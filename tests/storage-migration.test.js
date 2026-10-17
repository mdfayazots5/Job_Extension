"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function run() {
  const store = {
    jobsById: {
      "10": { jobId: "10", title: "Legacy ten" },
      "11": { jobId: "11", title: "Legacy eleven" }
    },
    jobs: [
      { jobId: "11", title: "Duplicate eleven" },
      { jobId: "12", title: "Legacy twelve" }
    ],
    collectorState: { state: "RUNNING", runId: "old-run", tabId: 7 },
    openedJobsById: { "10": true },
    resultsSelectedTab: "Company Site",
    collectorBudget: { dayKey: "2026-10-17", jobsToday: 8, seenJobIds: ["10"] },
    records: {
      "indeed:99": { siteId: "indeed", jobId: "99" },
      "linkedin:11": { jobId: "11", title: "Already migrated eleven" }
    }
  };
  let failMigrationMarkerWrite = true;
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys
              .filter((key) => Object.prototype.hasOwnProperty.call(store, key))
              .map((key) => [key, store[key]]));
          }
          return Object.prototype.hasOwnProperty.call(store, keys)
            ? { [keys]: store[keys] }
            : {};
        },
        async set(updates) {
          if (updates["storage.migration.linkedin.v1"] && failMigrationMarkerWrite) {
            failMigrationMarkerWrite = false;
            throw new Error("simulated interruption");
          }
          Object.assign(store, updates);
        }
      }
    }
  };
  const context = vm.createContext({ chrome });
  vm.runInContext(fs.readFileSync("src/core/storage.js", "utf8"), context);
  vm.runInContext(fs.readFileSync("src/sites/linkedin/migration.js", "utf8"), context);
  const storage = context.JobCollectorStorage;
  const migration = context.JobCollectorLinkedInMigration;

  await assert.rejects(migration.run(), /simulated interruption/);
  await migration.run();

  assert.equal(store.records["linkedin:10"].title, "Legacy ten");
  assert.equal(store.records["linkedin:11"].title, "Already migrated eleven");
  assert.equal(store.records["linkedin:12"].title, "Legacy twelve");
  assert.equal(store.records["indeed:99"].siteId, "indeed");
  assert.equal(store["runs.linkedin"].siteId, "linkedin");
  assert.equal(store["runs.linkedin"].tabId, 7);
  assert.equal(store["opened.linkedin"]["10"], true);
  assert.equal(store["ui.linkedin.selectedTab"], "Company Site");
  assert.equal(store["budgets.linkedin"].jobsToday, 8);
  assert.equal(store.jobsById["10"].title, "Legacy ten");
  assert.equal(store.jobs.length, 2);
  assert.equal(store["storage.migration.linkedin.v1"], true);

  const jobs = await storage.getJobs("linkedin");
  await storage.setJobs("linkedin", { "20": { jobId: "20" } });
  assert.equal(jobs["10"].title, "Legacy ten");
  assert.deepEqual(
    JSON.parse(JSON.stringify(store.records)),
    {
      "indeed:99": { siteId: "indeed", jobId: "99" },
      "linkedin:20": { jobId: "20" }
    }
  );
  console.log("Storage migration tests passed: retry-safe, namespaced, and non-destructive.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
