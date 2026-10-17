"use strict";

(function initializeJobCollectorRunGuard(global) {
  let startQueue = Promise.resolve();

  function withStartLock(operation) {
    const pending = startQueue.then(operation);
    startQueue = pending.catch(() => {});
    return pending;
  }

  function activeRunMessage(run) {
    const label = run && run.siteId === "naukri" ? "Naukri" : "LinkedIn";
    return `A collector run is already active (RUNNING on ${label}). Stop it before starting another site.`;
  }

  global.JobCollectorRunGuard = Object.freeze({ withStartLock, activeRunMessage });
})(globalThis);
