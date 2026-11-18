"use strict";

// Sample ("demo") jobs that let a first-time user see the results page before running a real
// collection. Site-agnostic: each site contributes its own guide + demo records through
// globalThis.JobCollectorSiteGuides (src/sites/<id>/guide.js). Demo rows are written straight into
// `records` (never through JobCollectorStorage.setJobs) so they are never mirrored to the optional
// backup host, and every demo record carries `demo: true` plus a `demo-` job ID prefix.
(function initializeJobCollectorDemoData(global) {
  const RECORDS_KEY = "records";
  const DEMO_ID_PREFIX = "demo-";

  function isDemoRecord(record) {
    return Boolean(record && typeof record === "object" && record.demo === true);
  }

  function guides() {
    const registered = global.JobCollectorSiteGuides || {};
    return Object.values(registered).filter((guide) => (
      guide && typeof guide.id === "string" && typeof guide.demoRecords === "function"
    ));
  }

  async function readRecords() {
    const values = await global.chrome.storage.local.get(RECORDS_KEY);
    const records = values[RECORDS_KEY];
    return records && typeof records === "object" && !Array.isArray(records) ? records : {};
  }

  // Seeds demo jobs for every site with a registered guide (or only `siteIds` when given).
  async function seed(siteIds) {
    const wanted = Array.isArray(siteIds) ? new Set(siteIds) : null;
    const records = { ...(await readRecords()) };
    const now = Date.now();
    let count = 0;
    for (const guide of guides()) {
      if (wanted && !wanted.has(guide.id)) {
        continue;
      }
      // Never mix samples into a site that already has real collected jobs.
      const hasRealJobs = Object.entries(records).some(([key, record]) => (
        key.startsWith(`${guide.id}:`) && !isDemoRecord(record)
      ));
      if (hasRealJobs) {
        continue;
      }
      guide.demoRecords(now).forEach((record, index) => {
        const jobId = `${DEMO_ID_PREFIX}${index + 1}`;
        records[`${guide.id}:${jobId}`] = {
          ...record,
          siteId: guide.id,
          jobId,
          demo: true,
          capturedAt: record.capturedAt || new Date(now - index * 60000).toISOString()
        };
        count += 1;
      });
    }
    await global.chrome.storage.local.set({ [RECORDS_KEY]: records });
    return count;
  }

  // Removes demo jobs (all sites, or only `siteId`). Real jobs are never touched.
  async function clear(siteId) {
    const records = await readRecords();
    const kept = {};
    let removed = 0;
    for (const [key, record] of Object.entries(records)) {
      const matchesSite = !siteId || key.startsWith(`${siteId}:`);
      if (matchesSite && isDemoRecord(record)) {
        removed += 1;
      } else {
        kept[key] = record;
      }
    }
    if (removed > 0) {
      await global.chrome.storage.local.set({ [RECORDS_KEY]: kept });
    }
    return removed;
  }

  function countDemo(records, siteId) {
    return Object.entries(records || {}).filter(([key, record]) => (
      (!siteId || key.startsWith(`${siteId}:`)) && isDemoRecord(record)
    )).length;
  }

  global.JobCollectorDemoData = Object.freeze({
    seed,
    clear,
    countDemo,
    isDemoRecord,
    DEMO_ID_PREFIX
  });
})(globalThis);
