"use strict";

(function initializeJobCollectorStorage(global) {
  const RECORDS_KEY = "records";
  const RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  function keysForSite(siteId) {
    if (typeof siteId !== "string" || !/^[a-z0-9-]+$/.test(siteId)) {
      throw new Error("A valid site ID is required for storage.");
    }
    return Object.freeze({
      runState: `runs.${siteId}`,
      jobs: RECORDS_KEY,
      openedJobs: `opened.${siteId}`,
      selectedTab: `ui.${siteId}.selectedTab`,
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

  async function setJobs(siteId, jobsById, additionalValues = {}) {
    if (!jobsById || typeof jobsById !== "object" || Array.isArray(jobsById)) {
      throw new Error("Job records must be supplied as an ID-keyed object.");
    }
    if (!additionalValues || typeof additionalValues !== "object" || Array.isArray(additionalValues)) {
      throw new Error("Additional site storage values must be supplied as an object.");
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
    const cutoff = Date.now() - RECORD_RETENTION_MS;
    for (const [jobId, record] of Object.entries(jobsById)) {
      const capturedAt = Date.parse(record && record.capturedAt);
      if (Number.isFinite(capturedAt) && capturedAt < cutoff) {
        continue;
      }
      next[`${prefix}${jobId}`] = record;
    }
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
  }

  global.JobCollectorStorage = Object.freeze({
    keysForSite,
    getJobs,
    setJobs
  });
})(globalThis);
