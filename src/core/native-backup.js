"use strict";

(function initializeJobCollectorNativeBackup(global) {
  const HOST_NAME = "com.jobextensions.history";
  const PAGE_SIZE = 25;
  const SUPPORTED_SITES = new Set(["linkedin", "naukri", "indeed"]);
  const SETTINGS_KEYS = Object.freeze([
    "ui.lastSite",
    ...Array.from(SUPPORTED_SITES).flatMap((siteId) => [
      `${siteId}:skipTitles`,
      `opened.${siteId}`,
      `hidden.${siteId}`,
      `ui.${siteId}.filters`,
      `ui.${siteId}.selectedTab`,
      `budgets.${siteId}`,
      `cooldown.${siteId}`,
      `killswitch.${siteId}`
    ])
  ]);
  const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS);
  let restorePromise = null;
  let nativeRequestQueue = Promise.resolve();

  async function sendRequest(message) {
    if (!global.chrome || !global.chrome.runtime
      || typeof global.chrome.runtime.sendNativeMessage !== "function") {
      throw new Error("The local job-history backup host is unavailable.");
    }
    const response = await global.chrome.runtime.sendNativeMessage(HOST_NAME, message);
    if (!response || response.ok !== true) {
      throw new Error(response && typeof response.error === "string"
        ? response.error
        : "The local job-history backup host did not acknowledge the request.");
    }
    return response;
  }

  function send(message) {
    const operation = nativeRequestQueue.then(() => sendRequest(message));
    nativeRequestQueue = operation.catch(() => {});
    return operation;
  }

  function validateRecord(siteId, record) {
    if (
      !SUPPORTED_SITES.has(siteId)
      || !record
      || typeof record !== "object"
      || Array.isArray(record)
      || typeof record.jobId !== "string"
      || !record.jobId
    ) {
      throw new Error("A valid namespaced job record is required for backup.");
    }
    if (siteId === "indeed" && record.url !== `https://in.indeed.com/viewjob?jk=${record.jobId}`) {
      throw new Error("Indeed backup records must use the canonical viewjob URL.");
    }
  }

  async function upsertRecord(siteId, record) {
    validateRecord(siteId, record);
    await send({ type: "upsert", siteId, record });
  }

  function validateSettingsKey(key) {
    if (typeof key !== "string" || !SETTINGS_KEY_SET.has(key)) {
      throw new Error("The setting is not eligible for local backup.");
    }
  }

  async function upsertSetting(key, value) {
    validateSettingsKey(key);
    if (value === undefined) {
      throw new Error("A setting value is required for backup.");
    }
    await send({ type: "upsertSetting", key, value });
  }

  async function readArchive() {
    const records = new Map();
    let offset = 0;
    while (true) {
      const response = await send({ type: "list", offset, limit: PAGE_SIZE });
      if (!Array.isArray(response.records)) {
        throw new Error("The local job-history backup returned an invalid records page.");
      }
      for (const item of response.records) {
        if (
          !item
          || !SUPPORTED_SITES.has(item.siteId)
          || !item.record
          || typeof item.record !== "object"
          || Array.isArray(item.record)
          || typeof item.record.jobId !== "string"
          || !item.record.jobId
        ) {
          throw new Error("The local job-history backup contains an invalid record.");
        }
        validateRecord(item.siteId, item.record);
        records.set(`${item.siteId}:${item.record.jobId}`, item.record);
      }
      if (response.nextOffset === null) {
        return records;
      }
      if (!Number.isInteger(response.nextOffset) || response.nextOffset <= offset) {
        throw new Error("The local job-history backup returned an invalid page cursor.");
      }
      offset = response.nextOffset;
    }
  }

  async function readSettingsArchive() {
    const settings = new Map();
    const response = await send({ type: "listSettings" });
    if (!Array.isArray(response.settings)) {
      throw new Error("The local job-history backup returned invalid settings.");
    }
    for (const item of response.settings) {
      if (!item || typeof item.key !== "string" || !SETTINGS_KEY_SET.has(item.key)
        || !Object.prototype.hasOwnProperty.call(item, "value")) {
        throw new Error("The local job-history backup contains an invalid setting.");
      }
      settings.set(item.key, item.value);
    }
    return settings;
  }

  function timestamp(record) {
    const parsed = Date.parse(String(record && (record.capturedAt || record.firstSeenAt) || ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function mergeRecord(archived, local) {
    const archivedAt = timestamp(archived);
    const localAt = timestamp(local);
    if (archivedAt !== null && localAt !== null && archivedAt > localAt) {
      return { ...local, ...archived };
    }
    return { ...archived, ...local };
  }

  async function restoreArchive() {
    if (restorePromise) {
      return restorePromise;
    }
    restorePromise = (async () => {
      const [archivedRecords, archivedSettings] = await Promise.all([
        readArchive(),
        readSettingsArchive()
      ]);
      const localValues = await global.chrome.storage.local.get([
        "records",
        ...SETTINGS_KEYS
      ]);
      const localRecords = localValues.records || {};
      if (!localRecords || typeof localRecords !== "object" || Array.isArray(localRecords)) {
        throw new Error("Stored job records are invalid; archive restoration was stopped.");
      }
      const archiveWinners = new Map();

      for (const siteId of SUPPORTED_SITES) {
        const prefix = `${siteId}:`;
        const localJobs = Object.fromEntries(
          Object.entries(localRecords)
            .filter(([key, record]) => key.startsWith(prefix) && record && typeof record === "object")
            .map(([key, record]) => [key.slice(prefix.length), record])
        );
        const archivedJobs = Object.fromEntries(
          Array.from(archivedRecords.entries())
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, record]) => [key.slice(prefix.length), record])
        );
        const mergedJobs = { ...archivedJobs };

        for (const [jobId, localRecord] of Object.entries(localJobs)) {
          const key = `${prefix}${jobId}`;
          const archivedRecord = archivedRecords.get(key);
          mergedJobs[jobId] = archivedRecord
            ? mergeRecord(archivedRecord, localRecord)
            : localRecord;
        }
        for (const [jobId, record] of Object.entries(mergedJobs)) {
          const archivedRecord = archivedRecords.get(`${prefix}${jobId}`);
          if (JSON.stringify(archivedRecord) !== JSON.stringify(record)) {
            archiveWinners.set(`${prefix}${jobId}`, record);
          }
        }

        if (Object.keys(mergedJobs).length > 0) {
          await global.JobCollectorStorage.setJobs(siteId, mergedJobs, {}, { backup: false });
        }
      }

      for (const [key, record] of archiveWinners) {
        const separator = key.indexOf(":");
        const siteId = key.slice(0, separator);
        if (!SUPPORTED_SITES.has(siteId)) {
          throw new Error("The local job-history backup contains an unsupported site.");
        }
        await upsertRecord(siteId, record);
      }
      const settingsToRestore = {};
      const settingsToArchive = [];
      for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(localValues, key)) {
          if (!archivedSettings.has(key)
            || JSON.stringify(localValues[key]) !== JSON.stringify(archivedSettings.get(key))) {
            settingsToArchive.push([key, localValues[key]]);
          }
        } else if (archivedSettings.has(key)) {
            settingsToRestore[key] = archivedSettings.get(key);
        }
      }
      if (Object.keys(settingsToRestore).length > 0) {
        await global.chrome.storage.local.set(settingsToRestore);
      }
      for (const [key, value] of settingsToArchive) {
        await upsertSetting(key, value);
      }
      return {
        restored: archivedRecords.size,
        synchronized: archiveWinners.size,
        restoredSettings: Object.keys(settingsToRestore).length,
        synchronizedSettings: settingsToArchive.length
      };
    })();
    try {
      return await restorePromise;
    } catch (error) {
      restorePromise = null;
      throw error;
    }
  }

  global.JobCollectorNativeBackup = Object.freeze({
    upsertRecord,
    upsertSetting,
    isBackupSettingKey: (key) => SETTINGS_KEY_SET.has(key),
    restoreArchive
  });
})(globalThis);
