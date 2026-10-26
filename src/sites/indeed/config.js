"use strict";

(function initializeIndeedConfig(global) {
  global.JobCollectorIndeedConfig = Object.freeze({
    maxPages: 50,
    maxJobsPerRun: 500,
    maxJobsPerDay: 5000,
    scrollDelayMs: Object.freeze({ min: 1800, max: 4000 }),
    pageDelayMs: Object.freeze({ min: 4000, max: 8000 }),
    resumeDelayMs: Object.freeze({ min: 2000, max: 5000 }),
    microPauseMs: Object.freeze({ min: 10000, max: 20000 }),
    microPauseEveryPages: 3,
    noResultsRecheckMs: Object.freeze({ min: 700, max: 1200 }),
    navigationTimeoutMs: 45000,
    cooldownMs: 24 * 60 * 60 * 1000,
    repeatedBlockCooldownMs: 48 * 60 * 60 * 1000,
    repeatedBlockWindowMs: 7 * 24 * 60 * 60 * 1000
  });
})(globalThis);
