param(
  # One or more extension IDs allowed to talk to the host. Each browser can assign
  # its own ID to an unpacked extension, so pass every ID shown on the browsers'
  # extensions pages, e.g. -ExtensionId id1,id2
  # Find it on chrome://extensions (Developer mode on) under the extension's name.
  [Parameter(Mandatory = $true, HelpMessage = "Extension ID from chrome://extensions")]
  [ValidatePattern("^[a-p]{32}$")]
  [string[]] $ExtensionId,

  # Chromium browsers to register the host for (current Windows user only).
  [Parameter()]
  [ValidateSet("Chrome", "Brave", "Edge")]
  [string[]] $Browser = @("Chrome", "Brave", "Edge")
)

$ErrorActionPreference = "Stop"
$hostName = "com.jobextensions.history"
$nativeHostDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $nativeHostDirectory
$projectPath = Join-Path $nativeHostDirectory "JobHistoryHost.csproj"
$publishDirectory = Join-Path $nativeHostDirectory "publish"
$hostPath = Join-Path $publishDirectory "JobHistoryHost.exe"
$manifestPath = Join-Path $nativeHostDirectory "$hostName.json"
$registryRoots = @{
  Chrome = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
  Brave  = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"
  Edge   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
}

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot "manifest.json"))) {
  throw "The extension manifest was not found in $repositoryRoot."
}

& dotnet publish $projectPath --configuration Release --runtime win-x64 --self-contained true --output $publishDirectory
if ($LASTEXITCODE -ne 0) {
  throw "Could not build the local job-history backup host. Close every browser using the extension and try again."
}

$allowedOrigins = @($ExtensionId | Select-Object -Unique | ForEach-Object { "chrome-extension://$_/" })
$hostManifest = @{
  name = $hostName
  description = "Local append-only Job Extensions history backup"
  path = $hostPath
  type = "stdio"
  allowed_origins = $allowedOrigins
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
  $manifestPath,
  $hostManifest,
  [System.Text.UTF8Encoding]::new($false)
)

foreach ($name in ($Browser | Select-Object -Unique)) {
  $registryPath = Join-Path $registryRoots[$name] $hostName
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -Path $registryPath -Value $manifestPath
  Write-Output "Registered native backup host for $name."
}

Write-Output "Allowed extension IDs: $($ExtensionId -join ', ')"
Write-Output "Job history archive: $(Join-Path $repositoryRoot 'job-history-backup.jsonl')"
Write-Output "The archive is append-only and excluded from Git."
Write-Output "Fully restart each browser (close all windows) before clicking Start."
