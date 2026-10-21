using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class Program
{
    private const int MaximumMessageBytes = 16 * 1024 * 1024;
    private const int MaximumResponseBytes = 512 * 1024;
    private static readonly HashSet<string> SupportedSites = ["linkedin", "naukri", "indeed"];
    private static readonly HashSet<string> SupportedSettings = BuildSupportedSettings();

    private static async Task<int> Main()
    {
        try
        {
            using var input = await ReadMessageAsync(Console.OpenStandardInput());
            var request = JsonNode.Parse(input.RootElement.GetRawText())?.AsObject()
                ?? throw new InvalidDataException("The native backup request must be a JSON object.");
            var response = request["type"]?.GetValue<string>() switch
            {
                "upsert" => await UpsertAsync(request),
                "list" => await ListAsync(request),
                "upsertSetting" => await UpsertSettingAsync(request),
                "listSettings" => await ListSettingsAsync(),
                _ => throw new InvalidDataException("Unsupported native backup request.")
            };
            await WriteMessageAsync(Console.OpenStandardOutput(), response);
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                await WriteMessageAsync(Console.OpenStandardOutput(), new JsonObject
                {
                    ["ok"] = false,
                    ["error"] = error.Message
                });
                return 0;
            }
            catch
            {
                return 1;
            }
        }
    }

    private static string FindBackupPath()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "manifest.json"))
                && Directory.Exists(Path.Combine(current.FullName, ".git")))
            {
                return Path.Combine(current.FullName, "job-history-backup.jsonl");
            }
            current = current.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not find the Job Extensions folder containing manifest.json and .git.");
    }

    private static HashSet<string> BuildSupportedSettings()
    {
        var settings = new HashSet<string>(StringComparer.Ordinal) { "ui.lastSite" };
        foreach (var siteId in SupportedSites)
        {
            settings.Add($"{siteId}:skipTitles");
            settings.Add($"opened.{siteId}");
            settings.Add($"hidden.{siteId}");
            settings.Add($"ui.{siteId}.filters");
            settings.Add($"ui.{siteId}.selectedTab");
            settings.Add($"budgets.{siteId}");
            settings.Add($"cooldown.{siteId}");
            settings.Add($"killswitch.{siteId}");
        }
        return settings;
    }

    private static async Task<JsonObject> UpsertSettingAsync(JsonObject request)
    {
        var key = request["key"]?.GetValue<string>();
        if (key is null || !SupportedSettings.Contains(key))
        {
            throw new InvalidDataException("The setting key is not eligible for local backup.");
        }
        if (!request.ContainsKey("value"))
        {
            throw new InvalidDataException("A setting value is required.");
        }

        var entry = new JsonObject
        {
            ["kind"] = "setting",
            ["key"] = key,
            ["value"] = request["value"]?.DeepClone(),
            ["archivedAt"] = DateTimeOffset.UtcNow.ToString("O")
        };
        var bytes = Encoding.UTF8.GetBytes(entry.ToJsonString() + "\n");
        await using var stream = new FileStream(
            FindBackupPath(),
            FileMode.Append,
            FileAccess.Write,
            FileShare.Read,
            bufferSize: 4096,
            FileOptions.WriteThrough);
        await stream.WriteAsync(bytes);
        stream.Flush(flushToDisk: true);
        return new JsonObject { ["ok"] = true, ["saved"] = true };
    }

    private static async Task<JsonObject> ListSettingsAsync()
    {
        var latest = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var path = FindBackupPath();
        if (File.Exists(path))
        {
            var lineNumber = 0;
            foreach (var line in await File.ReadAllLinesAsync(path, Encoding.UTF8))
            {
                lineNumber++;
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }
                JsonObject entry;
                try
                {
                    entry = JsonNode.Parse(line)?.AsObject()
                        ?? throw new InvalidDataException("The archive line is not a JSON object.");
                }
                catch (Exception error)
                {
                    throw new InvalidDataException(
                        $"The backup archive is invalid at line {lineNumber}; it was left untouched.",
                        error);
                }

                if (entry["kind"]?.GetValue<string>() != "setting")
                {
                    continue;
                }
                var key = entry["key"]?.GetValue<string>();
                if (key is null || !SupportedSettings.Contains(key)
                    || !entry.ContainsKey("value"))
                {
                    throw new InvalidDataException(
                        $"The backup archive contains an invalid setting at line {lineNumber}; it was left untouched.");
                }
                latest[key] = entry;
            }
        }

        var settings = new JsonArray();
        foreach (var (key, entry) in latest.OrderBy(item => item.Key, StringComparer.Ordinal))
        {
            settings.Add(new JsonObject
            {
                ["key"] = key,
                ["value"] = entry["value"]?.DeepClone()
            });
        }
        if (Encoding.UTF8.GetByteCount(settings.ToJsonString()) > MaximumResponseBytes)
        {
            throw new InvalidDataException("The archived settings exceed the safe response size.");
        }
        return new JsonObject { ["ok"] = true, ["settings"] = settings };
    }

    private static async Task<JsonObject> UpsertAsync(JsonObject request)
    {
        var siteId = request["siteId"]?.GetValue<string>();
        var record = request["record"]?.AsObject()
            ?? throw new InvalidDataException("A job record is required.");
        if (siteId is null || !SupportedSites.Contains(siteId))
        {
            throw new InvalidDataException("The backup site ID is not supported.");
        }

        var jobId = record["jobId"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(jobId) || jobId.Length > 256)
        {
            throw new InvalidDataException("The backup job ID is invalid.");
        }
        if (siteId == "indeed"
            && record["url"]?.GetValue<string>() != $"https://in.indeed.com/viewjob?jk={jobId}")
        {
            throw new InvalidDataException("Indeed records must use their canonical viewjob URL.");
        }

        var backupPath = FindBackupPath();
        var entry = new JsonObject
        {
            ["siteId"] = siteId,
            ["jobId"] = jobId,
            ["record"] = record.DeepClone(),
            ["archivedAt"] = DateTimeOffset.UtcNow.ToString("O")
        };
        var bytes = Encoding.UTF8.GetBytes(entry.ToJsonString() + "\n");
        await using var stream = new FileStream(
            backupPath,
            FileMode.Append,
            FileAccess.Write,
            FileShare.Read,
            bufferSize: 4096,
            FileOptions.WriteThrough);
        await stream.WriteAsync(bytes);
        stream.Flush(flushToDisk: true);
        return new JsonObject { ["ok"] = true, ["saved"] = true };
    }

    private static async Task<JsonObject> ListAsync(JsonObject request)
    {
        var offset = ReadNonNegativeInteger(request["offset"], "offset");
        var requestedLimit = ReadNonNegativeInteger(request["limit"], "limit");
        if (requestedLimit is < 1 or > 100)
        {
            throw new InvalidDataException("The backup page size must be between 1 and 100.");
        }

        var latest = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var path = FindBackupPath();
        if (File.Exists(path))
        {
            var lineNumber = 0;
            foreach (var line in await File.ReadAllLinesAsync(path, Encoding.UTF8))
            {
                lineNumber++;
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }
                JsonObject entry;
                try
                {
                    entry = JsonNode.Parse(line)?.AsObject()
                        ?? throw new InvalidDataException("The archive line is not a JSON object.");
                }
                catch (Exception error)
                {
                    throw new InvalidDataException(
                        $"The backup archive is invalid at line {lineNumber}; it was left untouched.",
                        error);
                }

                if (entry["kind"]?.GetValue<string>() == "setting")
                {
                    continue;
                }
                var siteId = entry["siteId"]?.GetValue<string>();
                var jobId = entry["jobId"]?.GetValue<string>();
                var record = entry["record"]?.AsObject();
                if (siteId is null || !SupportedSites.Contains(siteId)
                    || string.IsNullOrWhiteSpace(jobId)
                    || record is null
                    || record["jobId"]?.GetValue<string>() != jobId)
                {
                    throw new InvalidDataException(
                        $"The backup archive contains an invalid record at line {lineNumber}; it was left untouched.");
                }
                if (siteId == "indeed"
                    && record["url"]?.GetValue<string>() != $"https://in.indeed.com/viewjob?jk={jobId}")
                {
                    throw new InvalidDataException(
                        $"The Indeed archive record at line {lineNumber} is not canonical; the archive was left untouched.");
                }
                latest[$"{siteId}:{jobId}"] = entry;
            }
        }

        var ordered = latest.Values
            .OrderBy(entry => entry["siteId"]!.GetValue<string>(), StringComparer.Ordinal)
            .ThenBy(entry => entry["jobId"]!.GetValue<string>(), StringComparer.Ordinal)
            .ToArray();
        if (offset > ordered.Length)
        {
            throw new InvalidDataException("The backup page offset is outside the archive.");
        }

        var records = new JsonArray();
        var end = Math.Min(ordered.Length, offset + requestedLimit);
        for (var index = offset; index < end; index++)
        {
            var entry = ordered[index];
            var item = new JsonObject
            {
                ["siteId"] = entry["siteId"]!.DeepClone(),
                ["record"] = entry["record"]!.DeepClone()
            };
            records.Add(item);
            if (Encoding.UTF8.GetByteCount(records.ToJsonString()) > MaximumResponseBytes)
            {
                records.RemoveAt(records.Count - 1);
                if (records.Count == 0)
                {
                    throw new InvalidDataException("A single archived record exceeds the safe response size.");
                }
                end = index;
                break;
            }
        }

        return new JsonObject
        {
            ["ok"] = true,
            ["records"] = records,
            ["nextOffset"] = end < ordered.Length ? end : null
        };
    }

    private static int ReadNonNegativeInteger(JsonNode? value, string name)
    {
        if (value is null
            || !int.TryParse(value.ToJsonString(), out var number)
            || number < 0)
        {
            throw new InvalidDataException($"The backup {name} is invalid.");
        }
        return number;
    }

    private static async Task<JsonDocument> ReadMessageAsync(Stream input)
    {
        var header = new byte[sizeof(int)];
        await ReadExactlyAsync(input, header);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length < 1 || length > MaximumMessageBytes)
        {
            throw new InvalidDataException("The native backup request size is invalid.");
        }
        var payload = new byte[length];
        await ReadExactlyAsync(input, payload);
        return JsonDocument.Parse(payload);
    }

    private static async Task ReadExactlyAsync(Stream stream, byte[] buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset));
            if (read == 0)
            {
                throw new EndOfStreamException("The native backup request ended unexpectedly.");
            }
            offset += read;
        }
    }

    private static async Task WriteMessageAsync(Stream output, JsonObject response)
    {
        var payload = Encoding.UTF8.GetBytes(response.ToJsonString());
        if (payload.Length > MaximumResponseBytes)
        {
            throw new InvalidDataException("The native backup response is too large.");
        }
        var header = new byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await output.WriteAsync(header);
        await output.WriteAsync(payload);
        await output.FlushAsync();
    }
}
