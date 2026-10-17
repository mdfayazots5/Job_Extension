"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");

function eventHook() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of listeners) {
        listener(...args);
      }
    }
  };
}

async function run() {
  const store = {};
  const getLinkedInJobs = () => Object.fromEntries(
    Object.entries(store.records || {})
      .filter(([key]) => key.startsWith("linkedin:"))
      .map(([key, record]) => [key.slice("linkedin:".length), record])
  );
  const setLinkedInJobs = (jobsById) => {
    const others = Object.fromEntries(
      Object.entries(store.records || {}).filter(([key]) => !key.startsWith("linkedin:"))
    );
    store.records = {
      ...others,
      ...Object.fromEntries(Object.entries(jobsById || {}).map(([jobId, record]) => [
        `linkedin:${jobId}`,
        record
      ]))
    };
  };
  for (const [legacyName, namespacedName] of [
    ["collectorState", "runs.linkedin"],
    ["openedJobsById", "opened.linkedin"],
    ["resultsSelectedTab", "ui.linkedin.selectedTab"],
    ["collectorBudget", "budgets.linkedin"],
    ["collectorDiagnostics", "diagnostics.linkedin"],
    ["contentProgress", "progress.linkedin"],
    ["uiNotice", "notices.linkedin"]
  ]) {
    Object.defineProperty(store, legacyName, {
      configurable: true,
      get() { return store[namespacedName]; },
      set(value) {
        store[namespacedName] = legacyName === "collectorState" && value
          ? { ...value, siteId: value.siteId || "linkedin" }
          : value;
      }
    });
  }
  Object.defineProperty(store, "jobsById", {
    configurable: true,
    get: getLinkedInJobs,
    set: setLinkedInJobs
  });
  const browserTabs = [{
    id: 5,
    url: "https://www.linkedin.com/jobs/search-results/?keywords=engineer",
    active: true
  }];
  const storageChanged = eventHook();
  const injected = { ready: false };
  let nextTabId = 100;
  const createdTabs = [];
  const chrome = {
    runtime: {
      id: "collector-test",
      onMessage: eventHook(),
      onInstalled: eventHook(),
      onStartup: eventHook(),
      getURL(path) {
        return `chrome-extension://collector-test/${path}`;
      }
    },
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
          const changes = {};
          for (const [key, value] of Object.entries(updates)) {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = value;
          }
          storageChanged.emit(changes, "local");
        },
        async remove(key) {
          if (Object.prototype.hasOwnProperty.call(store, key)) {
            const oldValue = store[key];
            delete store[key];
            storageChanged.emit({ [key]: { oldValue, newValue: undefined } }, "local");
          }
        }
      },
      onChanged: storageChanged
    },
    tabs: {
      onRemoved: eventHook(),
      onUpdated: eventHook(),
      async query(query) {
        if (query.active) {
          return [browserTabs[0]];
        }
        return browserTabs;
      },
      async sendMessage(_tabId, message) {
        if (message.type === "PING") {
          return { ok: injected.ready };
        }
        return { ok: true };
      },
      async create(options) {
        const tab = { id: nextTabId++, ...options };
        browserTabs.push(tab);
        createdTabs.push(tab);
        return tab;
      },
      async update(tabId, updates) {
        const tab = browserTabs.find((candidate) => candidate.id === tabId);
        Object.assign(tab, updates);
        return tab;
      }
    },
    alarms: {
      onAlarm: eventHook(),
      async create() {},
      async clear() { return true; }
    },
    scripting: {
      async executeScript() {
        injected.ready = true;
      }
    }
  };
  const context = vm.createContext({
    chrome,
    crypto: crypto.webcrypto,
    URL,
    importScripts(...paths) {
      for (const path of paths) {
        vm.runInContext(fs.readFileSync(path, "utf8"), context, { filename: path });
      }
    },
    console
  });
  vm.runInContext(fs.readFileSync("background.js", "utf8"), context, {
    filename: "background.js"
  });
  await vm.runInContext("initializeStorage()", context);
  assert.equal(vm.runInContext("JobCollectorConfig.maxJobsPerRun", context), 500);
  assert.equal(vm.runInContext("JobCollectorConfig.maxJobsPerDay", context), 2000);
  assert.equal(vm.runInContext("JobCollectorConfig.maxRunsPerDay", context), undefined);

  await chrome.storage.local.set({
    jobsById: { "10": { jobId: "10", applyType: "Easy Apply" } },
    openedJobsById: { "10": true },
    collectorDiagnostics: [{ event: "stale-run" }],
    resultsSelectedTab: "Company Site"
  });
  store["cooldown.naukri"] = { until: Date.now() + 24 * 60 * 60 * 1000 };
  store["cooldown.indeed"] = { until: Date.now() + 24 * 60 * 60 * 1000 };
  store["killswitch.indeed"] = { triggerCount: 3 };
  await vm.runInContext("handleStart()", context);
  assert.equal(Object.keys(store.jobsById).length, 0);
  assert.equal(Object.keys(store.openedJobsById).length, 0);
  assert.equal(store.collectorDiagnostics.length, 0);
  assert.equal(store.collectorState.state, "RUNNING");
  assert.equal(store.collectorState.capturedCount, 0);
  assert.equal(store.resultsSelectedTab, "Company Site");
  assert.equal(store["cooldown.indeed"].until > Date.now(), true);
  await vm.runInContext("progressQueue", context);
  await assert.rejects(vm.runInContext("handleStart()", context), /already active/);

  store.jobsById = {
    "101": { jobId: "101", applyType: "Easy Apply" }
  };
  const doneProgress = {
    runId: store.collectorState.runId,
    currentPage: 1,
    capturedCount: 1,
    easyApplyCount: 1,
    companySiteCount: 0,
    terminalState: "DONE",
    message: "Results page complete."
  };
  await vm.runInContext(
    `applyContentProgress(${JSON.stringify(doneProgress)})`,
    context
  );
  await Promise.all([
    vm.runInContext(
      `openResultsForRun(${JSON.stringify(store.collectorState)})`,
      context
    ),
    vm.runInContext(
      `openResultsForRun(${JSON.stringify(store.collectorState)})`,
      context
    )
  ]);
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].active, true);
  assert.match(createdTabs[0].url, /results\.html\?site=linkedin&runId=/);
  assert.equal(store.collectorState.resultsOpened, true);

  store.collectorState = {
    ...store.collectorState,
    runId: "stop-run",
    state: "RUNNING",
    tabId: 5,
    pageNumber: 5,
    currentPage: 5,
    capturedCount: 15,
    easyApplyCount: 10,
    companySiteCount: 5,
    resultsOpened: false
  };
  store.collectorBudget = { ...store.collectorBudget, jobsToday: 145 };
  store.jobsById = {
    "202": { jobId: "202", applyType: "Company Site" }
  };
  await vm.runInContext("handleStop()", context);
  assert.equal(store.collectorState.state, "STOPPED");
  assert.equal(store.collectorState.pageNumber, 0);
  assert.equal(store.collectorState.currentPage, 0);
  assert.equal(store.collectorState.capturedCount, 0);
  assert.equal(store.collectorState.easyApplyCount, 0);
  assert.equal(store.collectorState.companySiteCount, 0);
  assert.equal(store.collectorBudget.jobsToday, 145);
  assert.deepEqual(Object.keys(store.jobsById), ["202"]);
  assert.equal(createdTabs.length, 2);
  assert.equal(store.collectorState.resultsOpened, true);

  store.collectorState = {
    ...store.collectorState,
    runId: "auto-stop-run",
    state: "RUNNING",
    pageNumber: 4,
    currentPage: 4,
    capturedCount: 8,
    easyApplyCount: 5,
    companySiteCount: 3,
    resultsOpened: false,
    resultsOpening: false
  };
  store.jobsById = {};
  await vm.runInContext(
    `applyContentProgress({
      runId: "auto-stop-run",
      pageNumber: 4,
      currentPage: 4,
      capturedCount: 8,
      easyApplyCount: 5,
      companySiteCount: 3,
      terminalState: "STOPPED",
      terminalReason: "stalled",
      message: "Collection stopped after no progress."
    })`,
    context
  );
  assert.equal(store.collectorState.state, "STOPPED");
  assert.equal(store.collectorState.pageNumber, 0);
  assert.equal(store.collectorState.currentPage, 0);
  assert.equal(store.collectorState.capturedCount, 0);
  assert.equal(store.collectorState.easyApplyCount, 0);
  assert.equal(store.collectorState.companySiteCount, 0);
  assert.equal(store.collectorBudget.jobsToday, 145);

  store.collectorState = {
    ...store.collectorState,
    runId: "visibility-stop-run",
    state: "RUNNING",
    pageNumber: 3,
    currentPage: 3,
    capturedCount: 6,
    easyApplyCount: 4,
    companySiteCount: 2,
    resultsOpened: false,
    resultsOpening: false
  };
  await vm.runInContext('stopForVisibilityTimeout("visibility-stop-run")', context);
  assert.equal(store.collectorState.state, "STOPPED");
  assert.equal(store.collectorState.pageNumber, 0);
  assert.equal(store.collectorState.currentPage, 0);
  assert.equal(store.collectorState.capturedCount, 0);
  assert.equal(store.collectorState.easyApplyCount, 0);
  assert.equal(store.collectorState.companySiteCount, 0);
  assert.equal(store.collectorBudget.jobsToday, 145);

  store.collectorState = {
    ...store.collectorState,
    runId: "empty-run",
    state: "DONE",
    resultsOpened: false
  };
  store.jobsById = {};
  await vm.runInContext(
    `openResultsForRun(${JSON.stringify(store.collectorState)})`,
    context
  );
  assert.equal(createdTabs.length, 2);

  const today = vm.runInContext("localDayKey()", context);
  store.collectorState = { ...store.collectorState, state: "DONE", runId: "budget-run" };
  store.collectorBudget = {
    dayKey: today,
    jobsToday: 2000,
    seenJobIds: []
  };
  await assert.rejects(
    vm.runInContext("handleStart()", context),
    /Daily job limit reached/
  );
  store.collectorBudget = { ...store.collectorBudget, jobsToday: 0, runsToday: 99 };
  await vm.runInContext("handleStart()", context);
  assert.equal(store.collectorState.state, "RUNNING");
  assert.equal(store.collectorBudget.runsToday, undefined);
  store.collectorBudget = {
    ...store.collectorBudget,
    cooldownUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    triggerHistory: [new Date().toISOString()],
    lastRunEndedAt: new Date().toISOString()
  };
  const normalizedBudget = await vm.runInContext("readBudget()", context);
  assert.equal(normalizedBudget.cooldownUntil, undefined);
  assert.equal(normalizedBudget.lastRunEndedAt, undefined);
  assert.equal(normalizedBudget.triggerHistory, undefined);
  assert.equal(normalizedBudget.runsToday, undefined);
  assert.equal(store.collectorBudget.cooldownUntil, undefined);
  assert.equal(vm.runInContext(
    `budgetBlockReason(${JSON.stringify(normalizedBudget)})`,
    context
  ), null);
  store.collectorState = {
    ...vm.runInContext("defaultRunState()", context),
    runId: "trigger-one",
    state: "RUNNING"
  };
  await vm.runInContext(
    `writeEndedBudget({ ...defaultRunState(), runId: "trigger-one", state: "ERROR" }, { circuitBreaker: true })`,
    context
  );
  store.collectorState = {
    ...vm.runInContext("defaultRunState()", context),
    runId: "trigger-two",
    state: "RUNNING"
  };
  const secondTrigger = await vm.runInContext(
    `writeEndedBudget({ ...defaultRunState(), runId: "trigger-two", state: "ERROR" }, { circuitBreaker: true })`,
    context
  );
  assert.equal(secondTrigger.circuitBreaker, true);
  assert.equal(store.collectorBudget.cooldownUntil, undefined);
  assert.equal(vm.runInContext(
    `budgetBlockReason(${JSON.stringify(store.collectorBudget)})`,
    context
  ), null);
  store.collectorBudget = {
    ...store.collectorBudget,
    dayKey: vm.runInContext("localDayKey(new Date(Date.now() - 86400000))", context),
    jobsToday: 2000,
    runsToday: 99
  };
  const rolledBudget = await vm.runInContext("readBudget()", context);
  assert.equal(rolledBudget.jobsToday, 0);
  assert.equal(rolledBudget.runsToday, undefined);

  store.collectorState = {
    ...vm.runInContext("defaultRunState()", context),
    runId: "dedupe-run",
    state: "RUNNING",
    capturedCount: 0
  };
  store.jobsById = {};
  store.collectorBudget = {
    ...rolledBudget,
    jobsToday: 0,
    seenJobIds: ["900"]
  };
  const duplicate = await vm.runInContext(
    `saveCapturedJob({ runId: "dedupe-run", record: { jobId: "900", applyType: "Easy Apply", pageNumber: 1 } })`,
    context
  );
  assert.equal(duplicate.duplicateToday, true);
  assert.equal(Object.keys(store.jobsById).length, 0);
  const saved = await vm.runInContext(
    `saveCapturedJob({ runId: "dedupe-run", record: { jobId: "901", applyType: "Company Site", pageNumber: 1 } })`,
    context
  );
  assert.equal(saved.saved, true);
  assert.equal(store.collectorBudget.jobsToday, 1);
  assert.deepEqual(store.collectorBudget.seenJobIds, ["900", "901"]);

  await vm.runInContext(
    `appendDiagnostic("dedupe-run", "run-ended", { jobId: "901", reason: "Role contains private text", pageNumber: 1, title: "must-not-be-stored" })`,
    context
  );
  const lastDiagnostic = store.collectorDiagnostics.at(-1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(lastDiagnostic.details)),
    { jobId: "901", reason: "unspecified", pageNumber: 1 }
  );
  const diagnosticWrites = Array.from({ length: 205 }, (_, index) => (
    vm.runInContext(
      `appendDiagnostic("dedupe-run", "run-ended", { pageNumber: ${index + 1}, reason: "DONE" })`,
      context
    )
  ));
  await Promise.all(diagnosticWrites);
  assert.equal(store.collectorDiagnostics.length, 200);
  assert.equal(store.collectorDiagnostics[199].details.pageNumber, 205);

  store.collectorState = {
    ...vm.runInContext("defaultRunState()", context),
    runId: "pause-run",
    state: "RUNNING",
    tabId: 5
  };
  await vm.runInContext('pauseRun("pause-run")', context);
  assert.equal(store.collectorState.state, "PAUSED");
  await vm.runInContext('resumeRun("pause-run")', context);
  assert.equal(store.collectorState.state, "RUNNING");

  store.collectorState = {
    ...store.collectorState,
    runId: "circuit-run",
    state: "RUNNING",
    capturedCount: 1,
    tabId: 5,
    resultsOpened: false,
    resultsOpening: false
  };
  store.jobsById = {
    "901": { jobId: "901", applyType: "Easy Apply" }
  };
  const circuitStartedAt = Date.now();
  await vm.runInContext(
    'failRunForTab(5, "LinkedIn checkpoint detected.", { circuitBreaker: true })',
    context
  );
  assert.equal(Date.now() - circuitStartedAt < 2000, true);
  assert.equal(store.collectorState.state, "ERROR");
  assert.ok(store["cooldown.linkedin"].until > Date.now());
  assert.equal(store["killswitch.linkedin"].triggerCount, 1);
  assert.equal(store["cooldown.indeed"].until > Date.now(), true);
  assert.deepEqual(store["killswitch.indeed"], { triggerCount: 3 });
  assert.equal(store.collectorState.resultsOpened, true);
  store["cooldown.linkedin"].until = 0;
  await vm.runInContext("handleStart()", context);
  assert.equal(store.collectorState.state, "RUNNING");
  assert.throws(
    () => vm.runInContext(
      'transitionRunState({ state: "IDLE" }, "DONE", {})',
      context
    ),
    /Invalid state transition/
  );

  store.collectorState = {
    ...vm.runInContext("defaultRunState()", context),
    runId: "stale-run",
    state: "RUNNING",
    tabId: 5,
    lastActionAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
  };
  await vm.runInContext("recoverStaleLinkedInRun()", context);
  assert.equal(store.collectorState.state, "STOPPED");
  assert.equal(store.collectorState.terminalReason, "stale");

  store.collectorState = {
    ...vm.runInContext("defaultRunState()", context),
    runId: "closed-tab-run",
    state: "RUNNING",
    tabId: 5,
    lastActionAt: new Date().toISOString()
  };
  await vm.runInContext("stopRunForClosedTab(5)", context);
  assert.equal(store.collectorState.state, "STOPPED");
  assert.equal(store.collectorState.terminalReason, "tab_closed");

  store.collectorState = {
    ...vm.runInContext("defaultRunState()", context),
    runId: "daily-limit-run",
    state: "RUNNING"
  };
  store.jobsById = {};
  store.collectorBudget = {
    ...store.collectorBudget,
    jobsToday: 1999,
    seenJobIds: [],
  };
  const dailyCapCapture = await vm.runInContext(
    `saveCapturedJob({ runId: "daily-limit-run", record: { jobId: "950", applyType: "Easy Apply", pageNumber: 1 } })`,
    context
  );
  assert.equal(dailyCapCapture.limitReached, true);
  assert.equal(store.collectorState.state, "DONE");
  assert.equal(store.collectorState.terminalReason, "limit");
  assert.equal(store.collectorBudget.jobsToday, 2000);

  vm.runInContext(
    "globalThis.JobCollectorConfig = Object.freeze({ ...globalThis.JobCollectorConfig, maxJobsPerRun: 1 })",
    context
  );
  store.collectorState = {
    ...vm.runInContext("defaultRunState()", context),
    runId: "per-run-limit",
    state: "RUNNING"
  };
  store.jobsById = {};
  store.collectorBudget = {
    ...store.collectorBudget,
    jobsToday: 0,
    seenJobIds: []
  };
  const perRunCapCapture = await vm.runInContext(
    `saveCapturedJob({ runId: "per-run-limit", record: { jobId: "951", applyType: "Easy Apply", pageNumber: 1 } })`,
    context
  );
  assert.equal(perRunCapCapture.limitReached, true);
  assert.equal(store.collectorState.state, "DONE");
  assert.equal(store.collectorState.terminalReason, "limit");
}

run().then(() => {
  console.log("Background lifecycle tests passed: Start clears data, Stop retains data, and terminal runs open results once.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
