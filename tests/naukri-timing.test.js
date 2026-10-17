"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(
  fs.readFileSync("src/sites/naukri/config.js", "utf8"),
  context,
  { filename: "src/sites/naukri/config.js" }
);
const config = context.JobCollectorNaukriConfig;

for (const [name, range] of Object.entries({
  pageChangeDelayMs: config.pageChangeDelayMs,
  resumeDelayMs: config.resumeDelayMs,
  microPauseMs: config.microPauseMs,
  scrollSteps: config.scrollSteps,
  scrollDelayMs: config.scrollDelayMs
})) {
  assert.ok(range.min > 0, `${name} has a positive minimum`);
  assert.ok(range.max > range.min, `${name} retains randomized timing`);
}

assert.ok(config.pageChangeDelayMs.max <= 5000);
assert.ok(config.resumeDelayMs.max <= 4000);
assert.ok(config.scrollDelayMs.max <= 1200);
assert.ok(config.microPauseEveryPages.min >= 4);
assert.ok(config.microPauseMs.min >= 8000);
console.log("Naukri timing tests passed: faster randomized waits and less frequent recovery pauses.");
