"use strict";

globalThis.JobCollectorConfig = Object.freeze({
  scrollDelayMs: Object.freeze({ min: 1200, max: 2500 }),
  cardDelayMs: Object.freeze({ min: 1500, max: 3500 }),
  detailTimeoutMs: 15000,
  paginationTimeoutMs: 15000,
  scrollStepRatio: 0.8,
  maxPages: 25,
  maxJobsPerRun: 500,
  maxJobsPerDay: 5000,
  maxHiddenMs: 300000,
  watchdogMs: 90000,
  circuitFailureLimit: 2,
  clickCards: true,
  stallLimit: 3,
  debug: false
});
