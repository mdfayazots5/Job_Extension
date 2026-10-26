"use strict";

(function initializeNaukriConfig(global) {
  global.JobCollectorNaukriConfig = Object.freeze({
    maxPages: 25,
    maxJobsPerRun: 500,
    maxJobsPerDay: 5000,
    pageChangeDelayMs: Object.freeze({ min: 2500, max: 5000 }),
    resumeDelayMs: Object.freeze({ min: 2000, max: 4000 }),
    microPauseMs: Object.freeze({ min: 8000, max: 12000 }),
    microPauseEveryPages: Object.freeze({ min: 4, max: 5 }),
    scrollSteps: Object.freeze({ min: 2, max: 3 }),
    scrollAmount: Object.freeze({ min: 350, max: 720 }),
    upwardScrollAmount: Object.freeze({ min: 80, max: 220 }),
    scrollDelayMs: Object.freeze({ min: 600, max: 1200 }),
    navigationTimeoutMs: 90000,
    noResultsRecheckMs: 2000,
    cooldownMs: 24 * 60 * 60 * 1000,
    repeatedBlockCooldownMs: 48 * 60 * 60 * 1000,
    repeatedBlockWindowMs: 7 * 24 * 60 * 60 * 1000,
    debug: false
  });
})(globalThis);
