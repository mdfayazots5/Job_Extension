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
    },
    "naukri:3": {
      siteId: "naukri",
      jobId: "3",
      title: "Newer local Naukri job without apply flags",
      capturedAt: "2026-10-20T10:00:00.000Z",
      url: "https://www.naukri.com/job-listings-role-3"
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
      capturedAt: "2026-08-01T10:00:00.000Z",
      companyApplyJob: false,
      questionnaireIdPresent: true,
      applyType: "Easy Apply",
      recordUpdatedAt: "2026-10-22T10:00:00.000Z"
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
  const archivedStatuses = new Map();
  archivedStatuses.set("linkedin:2", { opened: false });
  const store = {
    records,
    "ui.lastSite": "linkedin",
    "opened.linkedin": { "2": true },
    "hidden.linkedin": { "2": true },
    "progress.linkedin": { currentPage: 3 },
    "diagnostics.linkedin": [{ event: "temporary" }]
  };
  const backupErrors = [];
  let activeNativeRequests = 0;
  let maxConcurrentNativeRequests = 0;
  let failNextRecordBackup = false;
  let recordBatchRequestCount = 0;
  const requestedPageSizes = [];
  const chrome = {
    runtime: {
      async sendNativeMessage(_host, request) {
        activeNativeRequests += 1;
        maxConcurrentNativeRequests = Math.max(maxConcurrentNativeRequests, activeNativeRequests);
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
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
          if (request.type === "updateJobStatuses") {
            for (const update of request.updates) {
              const key = `${request.siteId}:${update.jobId}`;
              archivedStatuses.set(key, {
                ...(archivedStatuses.get(key) || {}),
                [update.statusName]: update.value
              });
            }
            return { ok: true, saved: true };
          }
          if (request.type === "listJobStatuses") {
            return {
              ok: true,
              statuses: [...archivedStatuses.entries()]
                .filter(([key]) => key.startsWith(`${request.siteId}:`))
                .map(([key, status]) => ({
                  jobId: key.slice(request.siteId.length + 1),
                  ...status
                }))
            };
          }
          if (request.type === "upsert") {
            if (failNextRecordBackup) {
              failNextRecordBackup = false;
              throw new Error("Simulated archive sharing violation.");
            }
            const key = `${request.siteId}:${request.record.jobId}`;
            const existing = archived.get(key);
            if (!existing || JSON.stringify(existing) !== JSON.stringify(request.record)) {
              archived.set(key, request.record);
            }
            return { ok: true, saved: true };
          }
          if (request.type === "upsertRecords") {
            recordBatchRequestCount += 1;
            for (const item of request.records) {
              const key = `${item.siteId}:${item.record.jobId}`;
              archived.set(key, item.record);
            }
            return { ok: true, saved: true };
          }
          if (request.type === "list") {
            if (request.limit < 1 || request.limit > 500) {
              throw new Error("The backup page size must be between 1 and 500.");
            }
            requestedPageSizes.push(request.limit);
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
        } finally {
          activeNativeRequests -= 1;
        }
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
  const context = vm.createContext({
    chrome,
    Date,
    console: {
      error(...args) {
        backupErrors.push(args);
      }
    }
  });
  for (const file of ["src/core/storage.js", "src/core/native-backup.js"]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  const result = await context.JobCollectorNativeBackup.restoreArchive();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    restored: 3,
    synchronized: 3,
    restoredSettings: 5,
    synchronizedSettings: 1,
    restoredStatuses: 3
  });
  assert.equal(store.records["linkedin:1"].title, "Newer local LinkedIn job");
  assert.equal(store.records["linkedin:2"].title, "Local-only LinkedIn job");
  assert.equal(store.records["naukri:3"].title, "Old archived Naukri job");
  assert.equal(store.records["naukri:3"].companyApplyJob, false);
  assert.equal(store.records["naukri:3"].questionnaireIdPresent, true);
  assert.equal(store.records["naukri:3"].applyType, "Easy Apply");
  assert.equal(store.records["indeed:0123456789abcdef"].title, "Old archived Indeed job");
  assert.equal(archived.size, 4);
  assert.equal(recordBatchRequestCount, 1);
  assert.deepEqual(requestedPageSizes, [500]);
  assert.deepEqual(JSON.parse(JSON.stringify(store["linkedin:skipTitles"])), ["Archived exact title"]);
  assert.deepEqual(JSON.parse(JSON.stringify(store["opened.linkedin"])), {
    "1": true,
    "2": true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(store["hidden.indeed"])), { "0123456789abcdef": true });
  assert.deepEqual(JSON.parse(JSON.stringify(store["hidden.linkedin"])), { "2": true });
  assert.deepEqual(JSON.parse(JSON.stringify(store["ui.naukri.filters"])), {
    locations: ["Pune"],
    experienceYears: ["3"]
  });
  assert.equal(store["ui.lastSite"], "linkedin");
  assert.equal(archivedSettings.get("ui.lastSite"), "linkedin");
  assert.equal(maxConcurrentNativeRequests, 1, "native archive requests overlapped");
  assert.deepEqual(JSON.parse(JSON.stringify(store["cooldown.linkedin"])), { until: 12345, recentBlocks: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(store["killswitch.naukri"])), {
    triggerCount: 2,
    lastTriggeredAt: "2026-10-20T10:00:00.000Z"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(store["budgets.indeed"])), {
    dayKey: "2026-10-21",
    runCount: 1
  });
  assert.equal(archivedSettings.has("hidden.linkedin"), false);
  assert.deepEqual(archivedStatuses.get("linkedin:1"), { opened: true });
  assert.deepEqual(archivedStatuses.get("linkedin:2"), { opened: true, hidden: true });
  assert.deepEqual(archivedStatuses.get("indeed:0123456789abcdef"), { hidden: true });
  await context.JobCollectorNativeBackup.updateJobStatus("linkedin", "1", "opened", false);
  await context.JobCollectorNativeBackup.updateJobStatuses("linkedin", [
    { jobId: "1", opened: false },
    { jobId: "3", hidden: true }
  ]);
  const sharedLinkedInStatuses = await context.JobCollectorNativeBackup.getJobStatuses("linkedin");
  assert.deepEqual(JSON.parse(JSON.stringify(sharedLinkedInStatuses)), {
    "1": { opened: false },
    "2": { opened: true, hidden: true },
    "3": { hidden: true }
  });
  assert.equal(context.JobCollectorNativeBackup.isBackupSettingKey("opened.linkedin"), false);
  assert.deepEqual(store["progress.linkedin"], { currentPage: 3 });
  assert.deepEqual(store["diagnostics.linkedin"], [{ event: "temporary" }]);
  await context.JobCollectorNativeBackup.upsertSetting("linkedin:skipTitles", []);
  assert.deepEqual(JSON.parse(JSON.stringify(archivedSettings.get("linkedin:skipTitles"))), []);
  await assert.rejects(
    context.JobCollectorNativeBackup.upsertSetting("debug.linkedin", {}),
    /not eligible/
  );
  await assert.rejects(
    context.JobCollectorNativeBackup.updateJobStatus("linkedin", "1", "opened", "yes"),
    /boolean/
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
  failNextRecordBackup = true;
  await context.JobCollectorStorage.setJobs("linkedin", {
    ...await context.JobCollectorStorage.getJobs("linkedin"),
    "5": {
      siteId: "linkedin",
      jobId: "5",
      title: "Locally saved despite archive lock",
      capturedAt: "2026-10-21T12:00:00.000Z",
      url: "https://www.linkedin.com/jobs/view/5/"
    }
  });
  assert.equal(store.records["linkedin:5"].title, "Locally saved despite archive lock");
  assert.equal(archived.has("linkedin:5"), false);
  assert.equal(backupErrors.length, 1);
  assert.match(backupErrors[0][0], /next extension startup/);
  console.log("Native backup tests passed: all sites restore old and new records without deleting archive entries.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
