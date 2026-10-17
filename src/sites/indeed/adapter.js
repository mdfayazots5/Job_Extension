"use strict";

(function initializeIndeedAdapter(global) {
  function notImplemented() {
    throw new Error("not implemented");
  }

  global.JobCollectorIndeedAdapter = Object.freeze({
    id: "indeed",
    label: "Indeed",
    matchesUrl: notImplemented,
    detectBlock: notImplemented,
    getCurrentPage: notImplemented,
    collectPage: notImplemented,
    hasNextPage: notImplemented,
    goNextPage: notImplemented,
    normalize: notImplemented,
    limits: Object.freeze({
      maxPages: notImplemented,
      maxJobsPerRun: notImplemented,
      maxJobsPerDay: notImplemented
    }),
    ui: Object.freeze({
      tabs: notImplemented,
      columns: notImplemented,
      applyUrl: notImplemented,
      accent: notImplemented
    })
  });
})(globalThis);
