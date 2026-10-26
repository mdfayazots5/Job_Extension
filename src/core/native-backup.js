"use strict";

(function initializeJobCollectorNativeBackup(global) {
  const HOST_NAME = "com.jobextensions.history";
  const PAGE_SIZE = 500;
  const SUPPORTED_SITES = new Set(["linkedin", "naukri", "indeed"]);
  const STATUS_SETTING_KEYS = Object.freeze(
    Array.from(SUPPORTED_SITES).flatMap((siteId) => [
      `opened.${siteId}`,
      `hidden.${siteId}`
    ])
  );
  const STATUS_SETTING_KEY_SET = new Set(STATUS_SETTING_KEYS);
  const SETTINGS_KEYS = Object.freeze([
    "ui.lastSite",
    ...Array.from(SUPPORTED_SITES).flatMap((siteId) => [
      `${siteId}:skipTitles`,
      `ui.${siteId}.filters`,
      `ui.${siteId}.selectedTab`,
      `budgets.${siteId}`,
      `cooldown.${siteId}`,
      `killswitch.${siteId}`
    ])
  ]);
  const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS);
  const ARCHIVED_SETTING_KEY_SET = new Set([...SETTINGS_KEYS, ...STATUS_SETTING_KEYS]);
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

  async function upsertRecords(records) {
    if (!Array.isArray(records) || records.length < 1 || records.length > 100) {
      throw new Error("A bounded list of job records is required for backup.");
    }
    for (const item of records) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("A valid site and job record are required for backup.");
      }
      validateRecord(item.siteId, item.record);
    }
    await send({ type: "upsertRecords", records });
  }

  function validateSettingsKey(key) {
    if (typeof key !== "string" || !SETTINGS_KEY_SET.has(key)) {
      throw new Error("The setting is not eligible for local backup.");
    }
  }

  async function upsertSetting(key, value) {
    validateSettingsKey(key);
    if (STATUS_SETTING_KEY_SET.has(key)) {
      throw new Error("Per-job opened and hidden statuses must use the shared status store.");
    }
    if (value === undefined) {
      throw new Error("A setting value is required for backup.");
    }
    await send({ type: "upsertSetting", key, value });
  }

  function validateJobStatus(siteId, jobId, statusName, value) {
    if (!SUPPORTED_SITES.has(siteId)
      || typeof jobId !== "string"
      || !jobId
      || jobId.length > 256
      || !["opened", "hidden"].includes(statusName)
      || typeof value !== "boolean") {
      throw new Error("A valid site, job ID, and boolean opened or hidden status are required.");
    }
  }

  async function updateJobStatus(siteId, jobId, statusName, value) {
    await updateJobStatuses(siteId, [{ jobId, [statusName]: value }]);
  }

  async function updateJobStatuses(siteId, updates) {
    if (!SUPPORTED_SITES.has(siteId)
      || !Array.isArray(updates)
      || updates.length < 1
      || updates.length > 1000) {
      throw new Error("A supported site and bounded job-status updates are required.");
    }
    const normalizedUpdates = [];
    for (const update of updates) {
      if (!update || typeof update !== "object" || Array.isArray(update)
        || typeof update.jobId !== "string" || !update.jobId || update.jobId.length > 256) {
        throw new Error("A valid job ID is required for each status update.");
      }
      for (const statusName of ["opened", "hidden"]) {
        if (Object.prototype.hasOwnProperty.call(update, statusName)) {
          validateJobStatus(siteId, update.jobId, statusName, update[statusName]);
          normalizedUpdates.push({
            jobId: update.jobId,
            statusName,
            value: update[statusName]
          });
        }
      }
      if (!["opened", "hidden"].some((statusName) => (
        Object.prototype.hasOwnProperty.call(update, statusName)
      ))) {
        throw new Error("Each status update must change opened or hidden state.");
      }
    }
    if (normalizedUpdates.length > 1000) {
      throw new Error("The job-status update batch is too large.");
    }
    await send({ type: "updateJobStatuses", siteId, updates: normalizedUpdates });
  }

  async function getJobStatuses(siteId) {
    if (!SUPPORTED_SITES.has(siteId)) {
      throw new Error("A supported site ID is required to read shared job statuses.");
    }
    const response = await send({ type: "listJobStatuses", siteId });
    if (!Array.isArray(response.statuses)) {
      throw new Error("The local job-history backup returned invalid job statuses.");
    }
    const statuses = {};
    for (const item of response.statuses) {
      if (!item || typeof item.jobId !== "string" || !item.jobId || item.jobId.length > 256
        || (Object.prototype.hasOwnProperty.call(item, "opened")
          && typeof item.opened !== "boolean")
        || (Object.prototype.hasOwnProperty.call(item, "hidden")
          && typeof item.hidden !== "boolean")
        || (!Object.prototype.hasOwnProperty.call(item, "opened")
          && !Object.prototype.hasOwnProperty.call(item, "hidden"))) {
        throw new Error("The local job-history backup contains an invalid job status.");
      }
      statuses[item.jobId] = {
        ...(Object.prototype.hasOwnProperty.call(item, "opened") ? { opened: item.opened } : {}),
        ...(Object.prototype.hasOwnProperty.call(item, "hidden") ? { hidden: item.hidden } : {})
      };
    }
    return statuses;
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
      if (!item || typeof item.key !== "string" || !ARCHIVED_SETTING_KEY_SET.has(item.key)
        || !Object.prototype.hasOwnProperty.call(item, "value")) {
        throw new Error("The local job-history backup contains an invalid setting.");
      }
      settings.set(item.key, item.value);
    }
    return settings;
  }

  function timestamp(record) {
    const values = record && typeof record === "object"
      ? [record.capturedAt, record.firstSeenAt, record.recordUpdatedAt]
      : [];
    const timestamps = values
      .map((value) => Date.parse(String(value || "")))
      .filter(Number.isFinite);
    return timestamps.length ? Math.max(...timestamps) : null;
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
        ...SETTINGS_KEYS,
        ...STATUS_SETTING_KEYS
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

      const winningRecords = Array.from(archiveWinners, ([key, record]) => {
        const separator = key.indexOf(":");
        const siteId = key.slice(0, separator);
        if (!SUPPORTED_SITES.has(siteId)) {
          throw new Error("The local job-history backup contains an unsupported site.");
        }
        return { siteId, record };
      });
      for (let offset = 0; offset < winningRecords.length; offset += 100) {
        await upsertRecords(winningRecords.slice(offset, offset + 100));
      }
      const archivedStatuses = await getAllJobStatuses();
      const originalArchivedStatuses = Object.fromEntries(
        Object.entries(archivedStatuses).map(([siteId, statuses]) => [
          siteId,
          Object.fromEntries(Object.entries(statuses).map(([jobId, status]) => [
            jobId,
            { ...status }
          ]))
        ])
      );
      for (const siteId of SUPPORTED_SITES) {
        for (const statusName of ["opened", "hidden"]) {
          const statusSettingKey = `${statusName}.${siteId}`;
          const legacyStatuses = archivedSettings.get(statusSettingKey);
          if (legacyStatuses && typeof legacyStatuses === "object" && !Array.isArray(legacyStatuses)) {
            for (const [jobId, value] of Object.entries(legacyStatuses)) {
              if (typeof value === "boolean"
                && !Object.prototype.hasOwnProperty.call(archivedStatuses[siteId][jobId] || {}, statusName)) {
                archivedStatuses[siteId][jobId] = {
                  ...(archivedStatuses[siteId][jobId] || {}),
                  [statusName]: value
                };
              }
            }
          }
          const localStatuses = localValues[statusSettingKey];
          if (localStatuses && typeof localStatuses === "object" && !Array.isArray(localStatuses)) {
            for (const [jobId, value] of Object.entries(localStatuses)) {
              if (typeof value === "boolean") {
                archivedStatuses[siteId][jobId] = {
                  ...(archivedStatuses[siteId][jobId] || {}),
                  [statusName]: value
                };
              }
            }
          }
        }
      }
      for (const siteId of SUPPORTED_SITES) {
        const statusUpdates = [];
        for (const [jobId, status] of Object.entries(archivedStatuses[siteId])) {
          const update = { jobId };
          for (const statusName of ["opened", "hidden"]) {
            if (typeof status[statusName] === "boolean"
              && originalArchivedStatuses[siteId][jobId]?.[statusName] !== status[statusName]) {
              update[statusName] = status[statusName];
            }
          }
          if (Object.keys(update).length > 1) {
            statusUpdates.push(update);
          }
        }
        for (let offset = 0; offset < statusUpdates.length; offset += 1000) {
          await updateJobStatuses(siteId, statusUpdates.slice(offset, offset + 1000));
        }
      }
      const restoredStatuses = {};
      for (const siteId of SUPPORTED_SITES) {
        const opened = {};
        const hidden = {};
        for (const [jobId, status] of Object.entries(archivedStatuses[siteId])) {
          if (typeof status.opened === "boolean") {
            opened[jobId] = status.opened;
          }
          if (typeof status.hidden === "boolean") {
            hidden[jobId] = status.hidden;
          }
        }
        restoredStatuses[`opened.${siteId}`] = opened;
        restoredStatuses[`hidden.${siteId}`] = hidden;
      }
      await global.chrome.storage.local.set(restoredStatuses);

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
        synchronizedSettings: settingsToArchive.length,
        restoredStatuses: Object.values(archivedStatuses)
          .reduce((count, statuses) => count + Object.keys(statuses).length, 0)
      };
    })();
    try {
      return await restorePromise;
    } catch (error) {
      restorePromise = null;
      throw error;
    }
  }

  async function getAllJobStatuses() {
    const statuses = {};
    for (const siteId of SUPPORTED_SITES) {
      statuses[siteId] = await getJobStatuses(siteId);
    }
    return statuses;
  }

  global.JobCollectorNativeBackup = Object.freeze({
    upsertRecord,
    upsertRecords,
    upsertSetting,
    updateJobStatus,
    updateJobStatuses,
    getJobStatuses,
    isBackupSettingKey: (key) => SETTINGS_KEY_SET.has(key),
    restoreArchive
  });
})(globalThis);
