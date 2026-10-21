"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function run() {
  const elements = new Map();
  const storageListeners = [];
  const createdTabs = [];
  for (const id of [
    "start",
    "stop",
    "view-results"
  ]) {
    const listeners = {};
    elements.set(id, {
      disabled: false,
      title: "",
      addEventListener(name, callback) { listeners[name] = callback; },
      async dispatch(name) { return listeners[name]?.({ target: this }); }
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
      runsToday: 50,
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
      },
      async create(options) {
        createdTabs.push(options);
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
    runtime: {
      getURL(path) { return `chrome-extension://collector-test/${path}`; },
      async sendMessage() { return { ok: true }; }
    }
  };
  const adapter = {
    id: "indeed",
    limits: {
      maxPages: 50,
      maxJobsPerRun: 500,
      maxJobsPerDay: 2000
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

  assert.equal(elements.get("start").disabled, false);
  assert.equal(store["ui.lastSite"], "indeed");
  await elements.get("view-results").dispatch("click");
  assert.deepEqual(JSON.parse(JSON.stringify(createdTabs)), [{
    url: "chrome-extension://collector-test/results.html"
  }]);

  state.skippedAppliedCount = 5;
  state.skippedExpiredCount = 2;
  for (const listener of storageListeners) {
    listener({ "runs.indeed": { newValue: state } }, "local");
  }
  assert.equal(elements.get("start").disabled, false);
  assert.deepEqual(
    [...elements.keys()],
    ["start", "stop", "view-results"]
  );
  const popupHtml = fs.readFileSync("popup.html", "utf8");
  assert.equal((popupHtml.match(/<button\b/g) || []).length, 3);
  assert.doesNotMatch(popupHtml, /Jobs this run|Jobs today|<output|<h1/);
  console.log("Popup tests passed: compact three-button controls and View opens the results tab.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
