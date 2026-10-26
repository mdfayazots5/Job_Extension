"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function run() {
  const elements = new Map();
  const storageListeners = [];
  const createdTabs = [];
  const sentMessages = [];
  let activeUrl = "https://in.indeed.com/jobs?q=developer";
  let actionResponse = { ok: true };
  for (const id of [
    "start",
    "stop",
    "view-results"
  ]) {
    const listeners = {};
    elements.set(id, {
      disabled: false,
      hidden: false,
      title: "",
      textContent: "",
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
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
    "cooldown.indeed": { until: 0 },
    "debug.linkedin": true
  };
  const chrome = {
    tabs: {
      async query() {
        return [{ url: activeUrl }];
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
      async sendMessage(message) {
        sentMessages.push(message);
        if (message.type === "START_RUN" && actionResponse.ok) {
          store[`runs.${message.siteId}`] = {
            siteId: message.siteId,
            state: "RUNNING"
          };
        }
        return actionResponse;
      }
    }
  };
  const adapters = Object.fromEntries(["linkedin", "naukri", "indeed"].map((siteId) => [
    siteId,
    {
      id: siteId,
      limits: { maxPages: 50, maxJobsPerRun: 500, maxJobsPerDay: 5000 }
    }
  ]));
  const getAdapterForUrl = (value) => {
    const siteId = value.includes("linkedin.com")
      ? "linkedin"
      : (value.includes("naukri.com") ? "naukri" : (value.includes("indeed.com") ? "indeed" : null));
    return siteId ? adapters[siteId] : null;
  };
  const context = vm.createContext({
    document: { getElementById(id) { return elements.get(id); } },
    chrome,
    URL,
    Date,
    globalThis: {
      JobCollectorSiteRegistry: {
        getAdapterForUrl
      },
      JobCollectorStorage: {
        keysForSite(siteId) {
          return {
            runState: `runs.${siteId}`,
            notice: `notices.${siteId}`,
            budget: `budgets.${siteId}`,
            cooldown: `cooldown.${siteId}`,
            diagnostics: `diagnostics.${siteId}`,
            flowLogging: `debug.${siteId}`
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

  activeUrl = "https://www.linkedin.com/jobs/search-results/?keywords=developer";
  store["runs.linkedin"] = { siteId: "linkedin", state: "STOPPED" };
  await vm.runInContext("refreshStorageSnapshot()", context);
  await elements.get("start").dispatch("click");
  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages[sentMessages.length - 1])), {
    type: "START_RUN",
    siteId: "linkedin"
  });
  assert.equal(elements.get("start").disabled, true);
  assert.deepEqual(
    Array.from(store["diagnostics.linkedin"], (entry) => entry.event),
    [
      "start_clicked",
      "start_response",
      "run_state_after_start"
    ]
  );

  store["runs.linkedin"] = { siteId: "linkedin", state: "STOPPED" };
  actionResponse = { ok: false, error: "LinkedIn content script rejected the run." };
  await vm.runInContext("refreshStorageSnapshot()", context);
  await elements.get("start").dispatch("click");
  assert.equal(elements.get("start").disabled, false);
  assert.equal(elements.get("start").title, actionResponse.error);
  const failedStartLogs = store["diagnostics.linkedin"];
  assert.equal(failedStartLogs[failedStartLogs.length - 2].event, "start_response");
  assert.equal(failedStartLogs[failedStartLogs.length - 2].ok, false);
  assert.equal(failedStartLogs[failedStartLogs.length - 1].state, "STOPPED");
  console.log("Popup tests passed: compact Start/Stop/View controls and results-page logging settings.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
