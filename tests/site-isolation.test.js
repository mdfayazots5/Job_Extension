"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const store = {};
const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]]));
        }
        return keys in store ? { [keys]: store[keys] } : {};
      },
      async set(values) { Object.assign(store, values); }
    }
  }
};
const context = vm.createContext({ chrome, Date });
vm.runInContext(fs.readFileSync("src/core/storage.js", "utf8"), context, { filename: "storage.js" });
const storage = context.JobCollectorStorage;
const linkedin = storage.keysForSite("linkedin");
const naukri = storage.keysForSite("naukri");

for (const key of ["runState", "openedJobs", "selectedTab", "progress", "diagnostics", "notice", "budget", "cooldown", "killSwitch"]) {
  assert.notEqual(linkedin[key], naukri[key], `${key} must be per site`);
}
assert.equal(linkedin.jobs, naukri.jobs);

const fresh = new Date().toISOString();
const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
Promise.resolve()
  .then(() => storage.setJobs("linkedin", {
    "101": { jobId: "101", capturedAt: fresh },
    "old": { jobId: "old", capturedAt: old }
  }, {
    [linkedin.budget]: { jobsToday: 1 },
    [linkedin.cooldown]: { until: Date.now() + 86400000 },
    [linkedin.killSwitch]: { triggerCount: 1 },
    [linkedin.openedJobs]: { "101": true }
  }))
  .then(() => storage.setJobs("naukri", {
    "202": { jobId: "202", capturedAt: fresh }
  }, {
    [naukri.budget]: { jobsToday: 2 },
    [naukri.cooldown]: { until: 0 },
    [naukri.killSwitch]: { triggerCount: 0 },
    [naukri.openedJobs]: { "202": true }
  }))
  .then(async () => {
    assert.deepEqual(Object.keys(await storage.getJobs("linkedin")), ["101"]);
    assert.deepEqual(Object.keys(await storage.getJobs("naukri")), ["202"]);
    assert.equal(store[linkedin.cooldown].until > Date.now(), true);
    assert.equal(store[naukri.cooldown].until, 0);
    assert.deepEqual(store[linkedin.openedJobs], { "101": true });
    assert.deepEqual(store[naukri.openedJobs], { "202": true });
    console.log("Site isolation tests passed: namespaced state is independent and retention is per site.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
