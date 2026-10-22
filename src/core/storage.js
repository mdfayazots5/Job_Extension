"use strict";

(function initializeJobCollectorStorage(global) {
  const RECORDS_KEY = "records";
  const SITE_IDS = Object.freeze(["linkedin", "naukri", "indeed"]);

  function keysForSite(siteId) {
    if (typeof siteId !== "string" || !/^[a-z0-9-]+$/.test(siteId)) {
      throw new Error("A valid site ID is required for storage.");
    }
    return Object.freeze({
      runState: `runs.${siteId}`,
      jobs: RECORDS_KEY,
      openedJobs: `opened.${siteId}`,
      hiddenJobs: `hidden.${siteId}`,
      selectedTab: `ui.${siteId}.selectedTab`,
      filters: `ui.${siteId}.filters`,
      progress: `progress.${siteId}`,
      diagnostics: `diagnostics.${siteId}`,
      flowLogging: `debug.${siteId}`,
      killSwitch: `killswitch.${siteId}`,
      notice: `notices.${siteId}`,
      budget: `budgets.${siteId}`,
      cooldown: `cooldown.${siteId}`
    });
  }

  async function getJobs(siteId) {
    const values = await chrome.storage.local.get(RECORDS_KEY);
    const records = values[RECORDS_KEY] || {};
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      throw new Error("Stored records data is not a namespaced job-record object.");
    }
    const prefix = `${siteId}:`;
    return Object.fromEntries(
      Object.entries(records)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, record]) => [key.slice(prefix.length), record])
    );
  }

  async function setJobs(siteId, jobsById, additionalValues = {}, options = {}) {
    if (!SITE_IDS.includes(siteId)) {
      throw new Error("Job records require a supported site ID.");
    }
    if (!jobsById || typeof jobsById !== "object" || Array.isArray(jobsById)) {
      throw new Error("Job records must be supplied as an ID-keyed object.");
    }
    if (!additionalValues || typeof additionalValues !== "object" || Array.isArray(additionalValues)) {
      throw new Error("Additional site storage values must be supplied as an object.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("Storage write options must be an object.");
    }
    const siteKeys = keysForSite(siteId);
    const values = await chrome.storage.local.get([RECORDS_KEY, siteKeys.openedJobs]);
    const current = values[RECORDS_KEY] || {};
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error("Stored records data is not a namespaced job-record object.");
    }
    const prefix = `${siteId}:`;
    const next = Object.fromEntries(
      Object.entries(current).filter(([key]) => !key.startsWith(prefix))
    );
    for (const [jobId, record] of Object.entries(jobsById)) {
      if (!jobId || !record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(`Job record "${jobId}" is invalid.`);
      }
      next[`${prefix}${jobId}`] = record;
    }
    const changedRecords = Object.entries(jobsById)
      .filter(([jobId, record]) => JSON.stringify(current[`${prefix}${jobId}`]) !== JSON.stringify(record))
      .map(([jobId, record]) => ({ siteId, record }));
    const opened = Object.prototype.hasOwnProperty.call(additionalValues, siteKeys.openedJobs)
      ? additionalValues[siteKeys.openedJobs]
      : values[siteKeys.openedJobs];
    const retainedJobIds = new Set(
      Object.keys(next)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
    );
    const prunedOpened = opened && typeof opened === "object" && !Array.isArray(opened)
      ? Object.fromEntries(Object.entries(opened).filter(([jobId, isOpened]) => (
        isOpened === true && retainedJobIds.has(jobId)
      )))
      : {};
    await chrome.storage.local.set({
      ...additionalValues,
      [siteKeys.openedJobs]: prunedOpened,
      [RECORDS_KEY]: next
    });
    if (options.backup !== false && global.JobCollectorNativeBackup) {
      for (const item of changedRecords) {
        try {
          await global.JobCollectorNativeBackup.upsertRecord(item.siteId, item.record);
        } catch (error) {
          console.error(
            "Could not archive a locally saved job record; it will be synchronized on the next extension startup.",
            error
          );
        }
      }
    }
  }

  global.JobCollectorStorage = Object.freeze({
    keysForSite,
    getJobs,
    setJobs,
    recordKey: RECORDS_KEY,
    siteIds: SITE_IDS
  });
})(globalThis);
