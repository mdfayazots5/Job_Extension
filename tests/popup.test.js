"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function run() {
  const elements = new Map();
  const storageListeners = [];
  for (const id of [
    "start",
    "stop",
    "state",
    "current-page",
    "captured-count",
    "max-pages",
    "max-jobs",
    "jobs-today",
    "max-jobs-today",
    "budget-status",
    "skipped-status",
    "notice",
    "view-results"
  ]) {
    elements.set(id, {
      textContent: "",
      hidden: false,
      disabled: false,
      href: "",
      addEventListener() {}
    });
  }
  const state = {
    siteId: "indeed",
    runId: "indeed-test-run",
    state: "DONE",
    pageNumber: 2,
    capturedCount: 4,
    skippedAppliedCount: 3,
    skippedExpiredCount: 1
  };
  const store = {
    "runs.indeed": state,
    "notices.indeed": {
      text: "Indeed per-run job limit reached.",
      kind: "success",
      updatedAt: new Date().toISOString()
    },
    "budgets.indeed": {
      jobsToday: 4,
      dayKey: (() => {
        const date = new Date();
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      })(),
      lastRunAt: new Date().toISOString()
    },
    "cooldown.indeed": { until: 0 }
  };
  const chrome = {
    tabs: {
      async query() {
        return [{ url: "https://in.indeed.com/jobs?q=developer" }];
      }
    },
    storage: {
      local: {
        async get(keys) {
          const requestedKeys = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requestedKeys.filter((key) => key in store).map((key) => [key, store[key]]));
        },
        async set(updates) { Object.assign(store, updates); }
      },
      onChanged: {
        addListener(listener) { storageListeners.push(listener); }
      }
    },
    runtime: { async sendMessage() { return { ok: true }; } }
  };
  const adapter = {
    id: "indeed",
    limits: {
      maxPages: 50,
      maxJobsPerRun: 500,
      maxJobsPerDay: 2000,
      maxRunsPerDay: 3
    }
  };
  const context = vm.createContext({
    document: { getElementById(id) { return elements.get(id); } },
    chrome,
    URL,
    Date,
    globalThis: {
      JobCollectorSiteRegistry: {
        getAdapterForUrl(value) {
          return value.startsWith("https://in.indeed.com") ? adapter : null;
        }
      },
      JobCollectorStorage: {
        keysForSite(siteId) {
          return {
            runState: `runs.${siteId}`,
            notice: `notices.${siteId}`,
            budget: `budgets.${siteId}`,
            cooldown: `cooldown.${siteId}`
          };
        }
      },
      JobCollectorIndeedConfig: {}
    },
    console
  });
  vm.runInContext(fs.readFileSync("popup.js", "utf8"), context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(elements.get("skipped-status").hidden, false);
  assert.equal(elements.get("skipped-status").textContent, "Skipped: 3 applied, 1 expired");
  assert.equal(elements.get("captured-count").textContent, "4");
  assert.equal(elements.get("budget-status").textContent, "");
  assert.equal(elements.get("start").disabled, false);
  assert.doesNotMatch(elements.get("notice").textContent, /per-run job limit reached/i);
  assert.equal(store["notices.indeed"].text, "");

  state.skippedAppliedCount = 5;
  state.skippedExpiredCount = 2;
  for (const listener of storageListeners) {
    listener({ "runs.indeed": { newValue: state } }, "local");
  }
  assert.equal(elements.get("skipped-status").textContent, "Skipped: 5 applied, 2 expired");
  assert.equal(elements.get("start").disabled, false);
  console.log("Popup tests passed: Indeed skipped counts update and Start is available after a run.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
