"use strict";

(function initializeLinkedInMigration(global) {
  const migrationKey = "storage.migration.linkedin.v1";
  const legacyKeys = Object.freeze({
    runState: "collectorState",
    jobs: "jobsById",
    openedJobs: "openedJobsById",
    selectedTab: "resultsSelectedTab",
    legacyJobs: "jobs",
    progress: "contentProgress",
    diagnostics: "collectorDiagnostics",
    notice: "uiNotice",
    budget: "collectorBudget"
  });
  const keys = global.JobCollectorStorage.keysForSite("linkedin");
  const recordsKey = "records";

  async function run() {
    const marker = await chrome.storage.local.get(migrationKey);
    if (marker[migrationKey] === true) {
      return;
    }

    const values = await chrome.storage.local.get([
      migrationKey,
      recordsKey,
      ...Object.values(legacyKeys)
    ]);
    const records = values[recordsKey] && typeof values[recordsKey] === "object"
      && !Array.isArray(values[recordsKey])
      ? { ...values[recordsKey] }
      : {};
    const legacyById = {};
    const oldMap = values[legacyKeys.jobs];
    if (oldMap && typeof oldMap === "object" && !Array.isArray(oldMap)) {
      Object.assign(legacyById, oldMap);
    }
    const oldList = values[legacyKeys.legacyJobs];
    if (Array.isArray(oldList)) {
      for (const record of oldList) {
        if (record && typeof record.jobId === "string" && record.jobId.length > 0) {
          legacyById[record.jobId] = record;
        }
      }
    }
    for (const [jobId, record] of Object.entries(legacyById)) {
      const key = `linkedin:${jobId}`;
      if (!Object.prototype.hasOwnProperty.call(records, key)) {
        records[key] = record;
      }
    }

    const updates = {};
    const copies = [
      ["runState", legacyKeys.runState],
      ["openedJobs", legacyKeys.openedJobs],
      ["selectedTab", legacyKeys.selectedTab],
      ["progress", legacyKeys.progress],
      ["diagnostics", legacyKeys.diagnostics],
      ["notice", legacyKeys.notice],
      ["budget", legacyKeys.budget]
    ];
    for (const [logicalName, legacyKey] of copies) {
      const destinationKey = keys[logicalName];
      const oldValue = values[legacyKey];
      if (oldValue === undefined) {
        continue;
      }
      const existing = await chrome.storage.local.get(destinationKey);
      if (existing[destinationKey] === undefined) {
        updates[destinationKey] = logicalName === "runState" && oldValue
          && typeof oldValue === "object"
          ? { ...oldValue, siteId: "linkedin" }
          : oldValue;
      }
    }
    if (values[legacyKeys.jobs] !== undefined || values[legacyKeys.legacyJobs] !== undefined) {
      updates[recordsKey] = records;
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }

    const verified = await chrome.storage.local.get([
      recordsKey,
      ...copies.map(([logicalName]) => keys[logicalName])
    ]);
    const savedRecords = verified[recordsKey] || {};
    for (const key of Object.keys(records)) {
      if (!Object.prototype.hasOwnProperty.call(savedRecords, key)) {
        throw new Error(`LinkedIn migration verification failed for record ${key}.`);
      }
    }
    for (const [logicalName, legacyKey] of copies) {
      if (values[legacyKey] !== undefined && verified[keys[logicalName]] === undefined) {
        throw new Error(`LinkedIn migration verification failed for ${logicalName}.`);
      }
    }
    await chrome.storage.local.set({ [migrationKey]: true });
  }

  global.JobCollectorLinkedInMigration = Object.freeze({ run });
})(globalThis);
