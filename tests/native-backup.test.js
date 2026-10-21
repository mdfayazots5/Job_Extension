"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function run() {
  const records = {
    "linkedin:1": {
      siteId: "linkedin",
      jobId: "1",
      title: "Newer local LinkedIn job",
      capturedAt: "2026-10-20T10:00:00.000Z",
      url: "https://www.linkedin.com/jobs/view/1/"
    },
    "linkedin:2": {
      siteId: "linkedin",
      jobId: "2",
      title: "Local-only LinkedIn job",
      capturedAt: "2026-10-21T10:00:00.000Z",
      url: "https://www.linkedin.com/jobs/view/2/"
    }
  };
  const archived = new Map([
    ["linkedin:1", {
      siteId: "linkedin",
      jobId: "1",
      title: "Older archived LinkedIn job",
      capturedAt: "2026-10-19T10:00:00.000Z",
      url: "https://www.linkedin.com/jobs/view/1/"
    }],
    ["naukri:3", {
      siteId: "naukri",
      jobId: "3",
      title: "Old archived Naukri job",
      capturedAt: "2026-08-01T10:00:00.000Z"
    }],
    ["indeed:0123456789abcdef", {
      siteId: "indeed",
      jobId: "0123456789abcdef",
      title: "Old archived Indeed job",
      capturedAt: "2026-08-02T10:00:00.000Z",
      url: "https://in.indeed.com/viewjob?jk=0123456789abcdef"
    }]
  ]);
  const archivedSettings = new Map([
    ["linkedin:skipTitles", ["Archived exact title"]],
    ["opened.linkedin", { "1": true }],
    ["hidden.indeed", { "0123456789abcdef": true }],
    ["ui.naukri.filters", { locations: ["Pune"], experienceYears: ["3"] }],
    ["ui.lastSite", "indeed"],
    ["cooldown.linkedin", { until: 12345, recentBlocks: [] }],
    ["killswitch.naukri", { triggerCount: 2, lastTriggeredAt: "2026-10-20T10:00:00.000Z" }],
    ["budgets.indeed", { dayKey: "2026-10-21", runCount: 1 }]
  ]);
  const store = {
    records,
    "ui.lastSite": "linkedin",
    "hidden.linkedin": { "2": true },
    "progress.linkedin": { currentPage: 3 },
    "diagnostics.linkedin": [{ event: "temporary" }]
  };
  const chrome = {
    runtime: {
      async sendNativeMessage(_host, request) {
        if (request.type === "upsertSetting") {
          archivedSettings.set(request.key, request.value);
          return { ok: true, saved: true };
        }
        if (request.type === "listSettings") {
          return {
            ok: true,
            settings: [...archivedSettings.entries()].map(([key, value]) => ({ key, value }))
          };
        }
        if (request.type === "upsert") {
          const key = `${request.siteId}:${request.record.jobId}`;
          const existing = archived.get(key);
          if (!existing || JSON.stringify(existing) !== JSON.stringify(request.record)) {
            archived.set(key, request.record);
          }
          return { ok: true, saved: true };
        }
        if (request.type === "list") {
          const entries = [...archived.entries()]
            .sort(([left], [right]) => left.localeCompare(right));
          const page = entries.slice(request.offset, request.offset + request.limit);
          const nextOffset = request.offset + page.length < entries.length
            ? request.offset + page.length
            : null;
          return {
            ok: true,
            records: page.map(([, record]) => ({
              siteId: record.siteId,
              record
            })),
            nextOffset
          };
        }
        throw new Error(`Unexpected native backup request: ${request.type}`);
      }
    },
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) {
            return Object.fromEntries(key
              .filter((item) => Object.prototype.hasOwnProperty.call(store, item))
              .map((item) => [item, store[item]]));
          }
          return Object.prototype.hasOwnProperty.call(store, key)
            ? { [key]: store[key] }
            : {};
        },
        async set(updates) {
          Object.assign(store, updates);
        }
      }
    }
  };
  const context = vm.createContext({ chrome, Date });
  for (const file of ["src/core/storage.js", "src/core/native-backup.js"]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  const result = await context.JobCollectorNativeBackup.restoreArchive();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    restored: 3,
    synchronized: 2,
    restoredSettings: 7,
    synchronizedSettings: 2
  });
  assert.equal(store.records["linkedin:1"].title, "Newer local LinkedIn job");
  assert.equal(store.records["linkedin:2"].title, "Local-only LinkedIn job");
  assert.equal(store.records["naukri:3"].title, "Old archived Naukri job");
  assert.equal(store.records["indeed:0123456789abcdef"].title, "Old archived Indeed job");
  assert.equal(archived.size, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(store["linkedin:skipTitles"])), ["Archived exact title"]);
  assert.deepEqual(JSON.parse(JSON.stringify(store["opened.linkedin"])), { "1": true });
  assert.deepEqual(JSON.parse(JSON.stringify(store["hidden.indeed"])), { "0123456789abcdef": true });
  assert.deepEqual(JSON.parse(JSON.stringify(store["ui.naukri.filters"])), {
    locations: ["Pune"],
    experienceYears: ["3"]
  });
  assert.equal(store["ui.lastSite"], "linkedin");
  assert.equal(archivedSettings.get("ui.lastSite"), "linkedin");
  assert.deepEqual(JSON.parse(JSON.stringify(store["cooldown.linkedin"])), { until: 12345, recentBlocks: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(store["killswitch.naukri"])), {
    triggerCount: 2,
    lastTriggeredAt: "2026-10-20T10:00:00.000Z"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(store["budgets.indeed"])), {
    dayKey: "2026-10-21",
    runCount: 1
  });
  assert.deepEqual(JSON.parse(JSON.stringify(archivedSettings.get("hidden.linkedin"))), { "2": true });
  assert.deepEqual(store["progress.linkedin"], { currentPage: 3 });
  assert.deepEqual(store["diagnostics.linkedin"], [{ event: "temporary" }]);
  await context.JobCollectorNativeBackup.upsertSetting("linkedin:skipTitles", []);
  assert.deepEqual(JSON.parse(JSON.stringify(archivedSettings.get("linkedin:skipTitles"))), []);
  await assert.rejects(
    context.JobCollectorNativeBackup.upsertSetting("debug.linkedin", {}),
    /not eligible/
  );

  const currentNaukri = await context.JobCollectorStorage.getJobs("naukri");
  await context.JobCollectorStorage.setJobs("naukri", {
    ...currentNaukri,
    "4": {
      siteId: "naukri",
      jobId: "4",
      title: "New Naukri job",
      capturedAt: "2026-10-21T11:00:00.000Z"
    }
  });
  assert.equal(archived.has("naukri:3"), true);
  assert.equal(archived.get("naukri:4").title, "New Naukri job");
  console.log("Native backup tests passed: all sites restore old and new records without deleting archive entries.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
