"use strict";

importScripts(
  "config.js",
  "src/core/storage.js",
  "src/core/run-guard.js",
  "src/core/messages.js",
  "src/sites/linkedin/migration.js",
  "src/sites/linkedin/selectors.js",
  "src/sites/linkedin/metadata.js",
  "src/sites/linkedin/adapter.js",
  "src/sites/naukri/config.js",
  "src/sites/naukri/selectors.js",
  "src/sites/naukri/adapter.js",
  "src/sites/registry.js",
  "src/sites/naukri/background.js",
  "src/core/run-loop.js"
);

const SITE_ID = "linkedin";
const SITE_ADAPTER = globalThis.JobCollectorSiteRegistry.getAdapter(SITE_ID);
const STORAGE_KEYS = Object.freeze({
  ...globalThis.JobCollectorStorage.keysForSite(SITE_ID),
  config: "config"
});

const ACTIVE_STATES = new Set(["RUNNING", "PAGINATING", "PAUSED"]);
const ALLOWED_TRANSITIONS = Object.freeze({
  IDLE: new Set(["IDLE", "RUNNING"]),
  RUNNING: new Set(["RUNNING", "PAGINATING", "PAUSED", "DONE", "STOPPED", "ERROR"]),
  PAGINATING: new Set(["PAGINATING", "RUNNING", "PAUSED", "DONE", "STOPPED", "ERROR"]),
  PAUSED: new Set(["PAUSED", "RUNNING", "PAGINATING", "DONE", "STOPPED", "ERROR"]),
  DONE: new Set(["DONE", "IDLE", "RUNNING"]),
  STOPPED: new Set(["STOPPED", "IDLE", "RUNNING"]),
  ERROR: new Set(["ERROR", "IDLE", "RUNNING"])
});
const CONTENT_FILES = [
  "config.js",
  "src/core/storage.js",
  "src/sites/linkedin/selectors.js",
  "src/sites/linkedin/metadata.js",
  "src/sites/linkedin/adapter.js",
  "src/sites/registry.js",
  "src/core/run-loop.js",
  "src/sites/linkedin/collector.js"
];
let initializationPromise;
let progressQueue = Promise.resolve();
let diagnosticQueue = Promise.resolve();
let terminalQueue = Promise.resolve();
let startInProgress = false;
const resultsOpenPromises = new Map();
let captureQueue = Promise.resolve();

function defaultRunState() {
  return {
    state: "IDLE",
    siteId: null,
    runId: null,
    tabId: null,
    pageNumber: 0,
    currentPage: 0,
    searchUrl: null,
    capturedCount: 0,
    easyApplyCount: 0,
    companySiteCount: 0,
    resultsOpened: false,
    resultsOpening: false,
    htmlReportDownloaded: false,
    terminalReason: null,
    circuitBreaker: false,
    pausedFrom: null,
    resultsTabId: null,
    lastError: null,
    startedAt: null,
    lastActionAt: null,
    updatedAt: new Date().toISOString()
  };
}

function debugLog(...values) {
  if (globalThis.JobCollectorConfig.debug) {
    console.log("[LinkedIn Jobs Collector]", ...values);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isSearchResultsUrl(value) {
  return Boolean(globalThis.JobCollectorSiteRegistry.getAdapterForUrl(value));
}

function isBlockingUrl(value) {
  try {
    const url = new URL(value);
    const doc = { body: null, title: "", querySelectorAll() { return []; } };
    return Boolean(SITE_ADAPTER.detectBlock(doc, url));
  } catch (_error) {
    return false;
  }
}

function getSearchUrl(value) {
  const adapter = globalThis.JobCollectorSiteRegistry.getAdapterForUrl(value);
  if (!adapter || typeof adapter.normalizeUrl !== "function") {
    throw new Error("A supported jobs search-results URL is required.");
  }
  return adapter.normalizeUrl(value);
}

async function readRunState() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.runState);
  return values[STORAGE_KEYS.runState] || defaultRunState();
}

async function readJobs() {
  return globalThis.JobCollectorStorage.getJobs(SITE_ID);
}

async function writeJobs(jobsById, additionalValues) {
  await globalThis.JobCollectorStorage.setJobs(SITE_ID, jobsById, additionalValues);
}

function localDayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function emptyBudget(dayKey = localDayKey()) {
  return {
    dayKey,
    jobsToday: 0,
    seenJobIds: []
  };
}

async function readBudget() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.budget);
  const stored = values[STORAGE_KEYS.budget];
  const today = localDayKey();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    const created = emptyBudget(today);
    await chrome.storage.local.set({ [STORAGE_KEYS.budget]: created });
    return created;
  }
  if (stored.dayKey !== today) {
    const reset = emptyBudget(today);
    await chrome.storage.local.set({ [STORAGE_KEYS.budget]: reset });
    return reset;
  }
  if (
    !Number.isInteger(stored.jobsToday)
    || stored.jobsToday < 0
    || !Array.isArray(stored.seenJobIds)
    || stored.seenJobIds.some((jobId) => typeof jobId !== "string" || !/^\d+$/.test(jobId))
  ) {
    throw new Error("Stored daily budget is invalid; Start is blocked to protect the limits.");
  }
  const normalized = {
    dayKey: today,
    jobsToday: stored.jobsToday,
    seenJobIds: stored.seenJobIds
  };
  if (
    "cooldownUntil" in stored
    || "triggerHistory" in stored
    || "lastRunEndedAt" in stored
    || "runsToday" in stored
  ) {
    await chrome.storage.local.set({ [STORAGE_KEYS.budget]: normalized });
  }
  return normalized;
}

function enqueueTerminalOperation(operation) {
  const pending = terminalQueue.then(operation);
  terminalQueue = pending.catch((error) => {
    debugLog("Could not serialize run-state transition", errorMessage(error));
  });
  return pending;
}

function writeEndedBudget(state, { circuitBreaker = false } = {}) {
  return enqueueTerminalOperation(async () => {
    const current = await readRunState();
    if (current.runId !== state.runId) {
      return current;
    }
    const upgradingCircuitError = circuitBreaker
      && current.state === "ERROR"
      && !current.circuitBreaker;
    if (!ACTIVE_STATES.has(current.state) && !upgradingCircuitError) {
      return current;
    }

    const changes = { ...state };
    delete changes.state;
    delete changes.updatedAt;
    const ended = transitionRunState(current, state.state, {
      ...changes,
      circuitBreaker
    });
    await chrome.storage.local.set({ [STORAGE_KEYS.runState]: ended });
    return ended;
  });
}

function budgetBlockReason(budget) {
  if (budget.jobsToday >= globalThis.JobCollectorConfig.maxJobsPerDay) {
    return `Daily job limit reached (${budget.jobsToday}/${globalThis.JobCollectorConfig.maxJobsPerDay}). Start is available after the local day resets.`;
  }
  return null;
}

async function readCooldown() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.cooldown);
  const cooldown = values[STORAGE_KEYS.cooldown] || {};
  return Number.isFinite(cooldown.until) && cooldown.until > Date.now() ? cooldown : null;
}

async function applyBlockCooldown() {
  const now = Date.now();
  const values = await chrome.storage.local.get([STORAGE_KEYS.cooldown, STORAGE_KEYS.killSwitch]);
  const current = values[STORAGE_KEYS.cooldown] || {};
  const recentBlocks = Array.isArray(current.recentBlocks)
    ? current.recentBlocks.filter((timestamp) => Number.isFinite(timestamp) && now - timestamp <= 7 * 24 * 60 * 60 * 1000)
    : [];
  const repeated = recentBlocks.length > 0;
  const cooldown = {
    recentBlocks: recentBlocks.concat(now),
    lastBlockAt: now,
    until: now + (repeated ? 48 : 24) * 60 * 60 * 1000,
    reason: repeated ? "repeated-block" : "block"
  };
  const priorKillSwitch = values[STORAGE_KEYS.killSwitch] || {};
  await chrome.storage.local.set({
    [STORAGE_KEYS.cooldown]: cooldown,
    [STORAGE_KEYS.killSwitch]: {
      triggerCount: Number.isInteger(priorKillSwitch.triggerCount) ? priorKillSwitch.triggerCount + 1 : 1,
      lastTriggeredAt: now
    }
  });
  return cooldown;
}

async function writeNotice(text, kind) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.notice]: {
      text,
      kind,
      updatedAt: new Date().toISOString()
    }
  });
}

function appendDiagnostic(runId, event, details = {}) {
  const operation = diagnosticQueue.then(async () => {
    const values = await chrome.storage.local.get([
      STORAGE_KEYS.runState,
      STORAGE_KEYS.diagnostics
    ]);
    const state = values[STORAGE_KEYS.runState];
    if (!state || state.runId !== runId || typeof event !== "string") {
      return;
    }
    const allowed = new Set([
      "pageNumber",
      "currentPage",
      "jobId",
      "route",
      "reason",
      "beforeScrollTop",
      "requestedScrollAmount",
      "observerResult",
      "newlyQueuedJobIds",
      "renderedJobIds",
      "target",
      "resultsScrollContainer",
      "detailPane",
      "control"
    ]);
    const elementFields = new Set([
      "tag",
      "testId",
      "role",
      "overflowY",
      "scrollTop",
      "clientHeight",
      "scrollHeight"
    ]);
    const safeReasons = new Set([
      "tab-hidden-or-unfocused",
      "tab-visible-and-focused",
      "consecutive-load-failures",
      "collector-error",
      "blocking-url",
      "tab-route-or-close",
      "user-stop",
      "already-applied",
      "visibility-timeout",
      "limit",
      "DONE",
      "STOPPED",
      "ERROR",
      "stalled",
      "stop-requested"
    ]);
    const safeEvents = new Set([
      "run-start",
      "run-paused",
      "run-resumed",
      "circuit-breaker",
      "job-captured",
      "job-already-captured",
      "job-already-applied",
      "job-card-click",
      "detail-loaded",
      "page-start",
      "results-scroll-step",
      "job-error",
      "pagination-click",
      "pagination-changed",
      "run-stopped",
      "run-error",
      "run-ended"
    ]);
    const safeDetails = {};
    const inputDetails = details && typeof details === "object" && !Array.isArray(details)
      ? details
      : {};
    for (const [key, value] of Object.entries(inputDetails)) {
      if (!allowed.has(key)) {
        continue;
      }
      if (key === "jobId") {
        if (typeof value === "string" && /^\d+$/.test(value)) {
          safeDetails[key] = value;
        }
        continue;
      }
      if (key === "reason") {
        safeDetails[key] = safeReasons.has(value) ? value : "unspecified";
        continue;
      }
      if (key === "route") {
        if (value === "/jobs/search-results/") {
          safeDetails[key] = value;
        }
        continue;
      }
      if (Array.isArray(value)) {
        safeDetails[key] = value.filter((item) => (
          typeof item === "string" && /^\d+$/.test(item)
        ));
      } else if (value && typeof value === "object") {
        safeDetails[key] = Object.fromEntries(
          Object.entries(value).filter(([field, nested]) => (
            elementFields.has(field)
            && (
              (typeof nested === "number" && Number.isFinite(nested))
              || (typeof nested === "string" && /^[a-zA-Z0-9_-]{1,60}$/.test(nested))
            )
          ))
        );
      } else if (typeof value === "number" && Number.isFinite(value)) {
        safeDetails[key] = value;
      } else if (typeof value === "string" && /^[a-zA-Z0-9 _-]{1,60}$/.test(value)) {
        safeDetails[key] = value;
      } else {
        continue;
      }
    }
    const prior = Array.isArray(values[STORAGE_KEYS.diagnostics])
      ? values[STORAGE_KEYS.diagnostics]
      : [];
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await chrome.storage.local.set({
      [STORAGE_KEYS.diagnostics]: prior.concat({
        at: new Date().toISOString(),
        runId,
        siteId: SITE_ID,
        event: safeEvents.has(event) ? event : "unknown-event",
        details: safeDetails
      }).filter((entry) => Number.isFinite(Date.parse(entry && entry.at)) && Date.parse(entry.at) >= cutoff).slice(-200)
    });
  });
  diagnosticQueue = operation.catch((error) => {
    debugLog("Could not persist diagnostic event", errorMessage(error));
  });
  return operation;
}

async function openResultsForRun(state) {
  if (
    !state
    || typeof state.runId !== "string"
    || (
      state.state !== "DONE"
      && state.state !== "STOPPED"
      && !(state.state === "ERROR" && state.circuitBreaker)
    )
  ) {
    return;
  }
  if (resultsOpenPromises.has(state.runId)) {
    return resultsOpenPromises.get(state.runId);
  }

  const operation = (async () => {
    const values = await chrome.storage.local.get(STORAGE_KEYS.runState);
    const current = values[STORAGE_KEYS.runState];
    const jobsById = await readJobs();
    if (!current || current.runId !== state.runId) {
      return;
    }
    if (
      !jobsById
      || typeof jobsById !== "object"
      || Array.isArray(jobsById)
      || Object.keys(jobsById).length === 0
    ) {
      if (current.resultsOpening) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.runState]: transitionRunState(current, current.state, {
            resultsOpening: false,
          })
        });
      }
      if (current.state !== "ERROR") {
        await writeNotice("No jobs captured.", "info");
      }
      return;
    }
    if (current.resultsOpened) {
      return;
    }

    const resultsUrl = `${chrome.runtime.getURL("results.html")}?site=${SITE_ID}&runId=${encodeURIComponent(state.runId)}`;
    await chrome.storage.local.set({
      [STORAGE_KEYS.runState]: transitionRunState(current, current.state, {
        resultsOpening: true
      })
    });

    try {
      const tabs = await chrome.tabs.query({});
      let resultsTab = tabs.find((tab) => tab.url === resultsUrl);
      if (!resultsTab) {
        resultsTab = await chrome.tabs.create({ url: resultsUrl, active: true });
      } else if (Number.isInteger(resultsTab.id)) {
        await chrome.tabs.update(resultsTab.id, { active: true });
      }

      const latest = await readRunState();
      if (latest.runId === state.runId) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.runState]: transitionRunState(latest, latest.state, {
            resultsOpening: false,
            resultsOpened: true,
            resultsTabId: Number.isInteger(resultsTab.id) ? resultsTab.id : null,
          })
        });
      }
      await writeNotice("Results opened.", "success");
    } catch (error) {
      const latest = await readRunState();
      if (latest.runId === state.runId) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.runState]: transitionRunState(latest, latest.state, {
            resultsOpening: false,
            lastError: `Could not open results: ${errorMessage(error)}`
          })
        });
      }
      await writeNotice(`Could not open results: ${errorMessage(error)}`, "error");
    }
  })().finally(() => {
    resultsOpenPromises.delete(state.runId);
  });

  resultsOpenPromises.set(state.runId, operation);
  return operation;
}

async function recoverResultsOpening() {
  const state = await readRunState();
  if (
    (
      state.state === "DONE"
      || state.state === "STOPPED"
      || (state.state === "ERROR" && state.circuitBreaker)
    )
    && !state.resultsOpened
  ) {
    await openResultsForRun(state);
  }
}

function transitionRunState(current, nextState, changes) {
  const allowed = ALLOWED_TRANSITIONS[current.state];
  if (!allowed || !allowed.has(nextState)) {
    throw new Error(`Invalid state transition: ${current.state} → ${nextState}`);
  }

  return {
    ...current,
    ...changes,
    state: nextState,
    updatedAt: new Date().toISOString(),
    lastActionAt: changes.lastActionAt || new Date().toISOString()
  };
}

function resetStoppedProgress() {
  return {
    pageNumber: 0,
    currentPage: 0,
    capturedCount: 0,
    easyApplyCount: 0,
    companySiteCount: 0
  };
}

async function persistRunFailure(error) {
  try {
    const state = await readRunState();
    if (ACTIVE_STATES.has(state.state)) {
      const failed = transitionRunState(state, "ERROR", {
        lastError: errorMessage(error)
      });
      await writeEndedBudget(failed);
    } else {
      await chrome.storage.local.set({
        [STORAGE_KEYS.runState]: transitionRunState(state, state.state, {
          lastError: errorMessage(error)
        })
      });
    }
    await writeNotice(errorMessage(error), "error");
  } catch (persistError) {
    debugLog("Could not persist failure", errorMessage(persistError));
  }
}

function initializeStorage() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await globalThis.JobCollectorLinkedInMigration.run();
      const values = await chrome.storage.local.get([
        STORAGE_KEYS.config,
        STORAGE_KEYS.runState,
        STORAGE_KEYS.openedJobs,
        STORAGE_KEYS.selectedTab,
        STORAGE_KEYS.budget,
        STORAGE_KEYS.cooldown,
        STORAGE_KEYS.killSwitch
      ]);
      const initialValues = {};

      if (!values[STORAGE_KEYS.config]) {
        initialValues[STORAGE_KEYS.config] = globalThis.JobCollectorConfig;
      }
      if (!values[STORAGE_KEYS.runState]) {
        initialValues[STORAGE_KEYS.runState] = defaultRunState();
      }
      if (
        !values[STORAGE_KEYS.openedJobs]
        || typeof values[STORAGE_KEYS.openedJobs] !== "object"
        || Array.isArray(values[STORAGE_KEYS.openedJobs])
      ) {
        initialValues[STORAGE_KEYS.openedJobs] = {};
      }
      if (
        values[STORAGE_KEYS.selectedTab] !== "Easy Apply"
        && values[STORAGE_KEYS.selectedTab] !== "Company Site"
      ) {
        initialValues[STORAGE_KEYS.selectedTab] = "Easy Apply";
      }
      const today = localDayKey();
      if (!values[STORAGE_KEYS.budget]) {
        initialValues[STORAGE_KEYS.budget] = emptyBudget(today);
      } else if (values[STORAGE_KEYS.budget].dayKey !== today) {
        initialValues[STORAGE_KEYS.budget] = emptyBudget(today);
      }
      if (!values[STORAGE_KEYS.cooldown] || typeof values[STORAGE_KEYS.cooldown] !== "object") {
        initialValues[STORAGE_KEYS.cooldown] = { until: 0, recentBlocks: [] };
      }
      if (!values[STORAGE_KEYS.killSwitch] || typeof values[STORAGE_KEYS.killSwitch] !== "object") {
        initialValues[STORAGE_KEYS.killSwitch] = { triggerCount: 0, lastTriggeredAt: null };
      }
      if (Object.keys(initialValues).length > 0) {
        await chrome.storage.local.set(initialValues);
      }
    })().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

async function queryActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") {
    throw new Error("Could not identify the active browser tab.");
  }
  return tab;
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return Boolean(response && response.ok);
  } catch (_error) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await pingContentScript(tabId)) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES
  });

  if (!await pingContentScript(tabId)) {
    throw new Error("Could not connect to the LinkedIn jobs content script.");
  }
}

async function sendToJobsTab(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

async function handleStart(siteId = SITE_ID) {
  return globalThis.JobCollectorRunGuard.withStartLock(() => startRun(siteId));
}

async function startRun(siteId = SITE_ID) {
  const tab = await queryActiveTab();
  const adapter = globalThis.JobCollectorSiteRegistry.getAdapterForUrl(tab.url);
  if (!adapter || adapter.id !== siteId) {
    throw new Error("Start is only available on a supported jobs search-results page.");
  }
  const naukriRunValues = await chrome.storage.local.get("runs.naukri");
  if (naukriRunValues["runs.naukri"] && ACTIVE_STATES.has(naukriRunValues["runs.naukri"].state)) {
    throw new Error(globalThis.JobCollectorRunGuard.activeRunMessage(naukriRunValues["runs.naukri"]));
  }

  const cooldown = await readCooldown();
  if (cooldown) {
    throw new Error(`LinkedIn is cooling down until ${new Date(cooldown.until).toLocaleString()}.`);
  }

  const budget = await readBudget();
  const blocked = budgetBlockReason(budget);
  if (blocked) {
    await writeNotice(blocked, "error");
    throw new Error(blocked);
  }

  const current = await readRunState();
  if (ACTIVE_STATES.has(current.state) || current.resultsOpening) {
    throw new Error(globalThis.JobCollectorRunGuard.activeRunMessage(current));
  }

  const runId = crypto.randomUUID();
  const nextBudget = { ...budget };
  const running = transitionRunState(current, "RUNNING", {
    runId,
    siteId,
    tabId: tab.id,
    pageNumber: 1,
    currentPage: 1,
    searchUrl: getSearchUrl(tab.url),
    capturedCount: 0,
    easyApplyCount: 0,
    companySiteCount: 0,
    resultsOpened: false,
    resultsOpening: false,
    htmlReportDownloaded: false,
    circuitBreaker: false,
    terminalReason: null,
    resultsTabId: null,
    lastError: null,
    startedAt: new Date().toISOString(),
    lastActionAt: new Date().toISOString()
  });
  await writeJobs({}, {
    [STORAGE_KEYS.budget]: nextBudget,
    [STORAGE_KEYS.openedJobs]: {},
    [STORAGE_KEYS.diagnostics]: [],
    [STORAGE_KEYS.runState]: running,
    [STORAGE_KEYS.progress]: {
      runId,
      pageNumber: 1,
      currentPage: 1,
      searchUrl: running.searchUrl,
      capturedCount: 0,
      easyApplyCount: 0,
      companySiteCount: 0,
      updatedAt: new Date().toISOString()
    }
  });
  await writeNotice("Collecting the current results page.", "info");

  try {
    const response = await sendToJobsTab(tab.id, {
      type: "START_RUN",
      siteId,
      runId
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error
        ? response.error
        : "The content script did not acknowledge the run.");
    }
  } catch (error) {
    await persistRunFailure(error);
    throw error;
  }

  return { ok: true };
}

async function handleStop(siteId = SITE_ID) {
  await captureQueue;
  await progressQueue;
  const current = await readRunState();
  if (current.siteId !== siteId) {
    throw new Error("The active run belongs to a different site.");
  }
  if (!ACTIVE_STATES.has(current.state)) {
    throw new Error("There is no active run to stop.");
  }

  const stopped = transitionRunState(current, "STOPPED", {
    ...resetStoppedProgress(),
    lastError: null,
    terminalReason: "user-stop",
    resultsOpening: current.capturedCount > 0
  });
  const ended = await writeEndedBudget(stopped);
  await appendDiagnostic(current.runId, "run-stopped", {
    pageNumber: current.pageNumber,
    reason: "user-stop"
  });

  try {
    if (Number.isInteger(current.tabId)) {
      const response = await chrome.tabs.sendMessage(current.tabId, {
        type: "STOP_RUN",
        siteId: current.siteId,
        runId: current.runId
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error
          ? response.error
          : "The page did not acknowledge STOP.");
      }
    }
  } catch (error) {
    const warning = `Run stopped, but the page did not acknowledge STOP: ${errorMessage(error)}`;
    await chrome.storage.local.set({
      [STORAGE_KEYS.runState]: transitionRunState(ended, ended.state, {
        lastError: warning
      })
    });
    await writeNotice(warning, "error");
    await openResultsForRun(ended);
    return { ok: false, error: warning };
  }

  await writeNotice("Run stopped.", "info");
  await openResultsForRun(ended);
  return { ok: true };
}

function jobStats(jobsById) {
  const records = Object.values(jobsById);
  return {
    capturedCount: records.length,
    easyApplyCount: records.filter((record) => record.applyType === "Easy Apply").length,
    companySiteCount: records.filter((record) => record.applyType === "Company Site").length
  };
}

async function saveCapturedJob(message) {
  const operation = captureQueue.then(() => enqueueTerminalOperation(async () => {
    const current = await readRunState();
    if (
      !ACTIVE_STATES.has(current.state)
      || current.state === "PAUSED"
      || current.runId !== message.runId
        || (message.siteId !== undefined && message.siteId !== current.siteId)
    ) {
      throw new Error("The capture is not associated with the active run.");
    }
    const record = message.record;
    if (
      !record
      || typeof record !== "object"
      || typeof record.jobId !== "string"
      || !/^\d+$/.test(record.jobId)
      || !["Easy Apply", "Company Site", "Unknown"].includes(record.applyType)
      || !Number.isInteger(record.pageNumber)
    ) {
      throw new Error("The captured job record is invalid.");
    }

    const budget = await readBudget();
    const jobsById = await readJobs();
    if (Object.prototype.hasOwnProperty.call(jobsById, record.jobId)) {
      return { ok: true, saved: false, stats: jobStats(jobsById) };
    }
    if (budget.seenJobIds.includes(record.jobId)) {
      return { ok: true, saved: false, duplicateToday: true, stats: jobStats(jobsById) };
    }
    if (
      current.capturedCount >= globalThis.JobCollectorConfig.maxJobsPerRun
      || budget.jobsToday >= globalThis.JobCollectorConfig.maxJobsPerDay
    ) {
      const capped = transitionRunState(current, "DONE", {
        terminalReason: "limit",
        lastError: null,
        resultsOpening: Object.keys(jobsById).length > 0
      });
      await chrome.storage.local.set({
        [STORAGE_KEYS.budget]: budget,
        [STORAGE_KEYS.runState]: capped
      });
      await writeNotice("Job limit reached; the run finished.", "success");
      await openResultsForRun(capped);
      return {
        ok: false,
        limit: true,
        limitReason: budget.jobsToday >= globalThis.JobCollectorConfig.maxJobsPerDay
          ? "daily"
          : "run",
        stats: jobStats(jobsById)
      };
    }

    const nextJobs = { ...jobsById, [record.jobId]: record };
    const stats = jobStats(nextJobs);
    const nextBudget = {
      ...budget,
      jobsToday: budget.jobsToday + 1,
      seenJobIds: budget.seenJobIds.concat(record.jobId)
    };
    const reachedLimit = stats.capturedCount >= globalThis.JobCollectorConfig.maxJobsPerRun
      || nextBudget.jobsToday >= globalThis.JobCollectorConfig.maxJobsPerDay;
    let nextState = transitionRunState(current, current.state, {
      ...stats,
      currentPage: record.pageNumber,
      pageNumber: record.pageNumber
    });
    if (reachedLimit) {
      nextState = transitionRunState(current, "DONE", {
        ...stats,
        currentPage: record.pageNumber,
        pageNumber: record.pageNumber,
        terminalReason: "limit",
        lastError: null,
        resultsOpening: true
      });
    }
    await writeJobs(nextJobs, {
      [STORAGE_KEYS.budget]: nextBudget,
      [STORAGE_KEYS.runState]: nextState
    });
    if (reachedLimit) {
      await writeNotice("Job limit reached; the run finished.", "success");
      await openResultsForRun(nextState);
    }
    return { ok: true, saved: true, limitReached: reachedLimit, stats };
  }));
  captureQueue = operation.catch(() => {});
  return operation;
}

async function pauseRun(runId) {
  await captureQueue;
  await progressQueue;
  return enqueueTerminalOperation(async () => {
    const current = await readRunState();
    if (current.runId !== runId || !ACTIVE_STATES.has(current.state)) {
      return { ok: false, error: "The run is no longer active." };
    }
    if (current.state === "PAUSED") {
      return { ok: true };
    }
    const paused = transitionRunState(current, "PAUSED", { pausedFrom: current.state });
    await chrome.storage.local.set({ [STORAGE_KEYS.runState]: paused });
    await appendDiagnostic(runId, "run-paused", { reason: "tab-hidden-or-unfocused" });
    await writeNotice("Keep this LinkedIn tab visible. Collection is paused.", "info");
    return { ok: true };
  });
}

async function resumeRun(runId) {
  await captureQueue;
  await progressQueue;
  return enqueueTerminalOperation(async () => {
    const current = await readRunState();
    if (current.runId !== runId || current.state !== "PAUSED") {
      return { ok: false, error: "There is no paused run to resume." };
    }
    const nextState = current.pausedFrom === "PAGINATING" ? "PAGINATING" : "RUNNING";
    const resumed = transitionRunState(current, nextState, { pausedFrom: null });
    await chrome.storage.local.set({ [STORAGE_KEYS.runState]: resumed });
    await appendDiagnostic(runId, "run-resumed", { reason: "tab-visible-and-focused" });
    await writeNotice("Collection resumed.", "info");
    return { ok: true };
  });
}

async function stopForVisibilityTimeout(runId) {
  await captureQueue;
  await progressQueue;
  const current = await readRunState();
  if (current.runId !== runId || !ACTIVE_STATES.has(current.state)) {
    return { ok: false };
  }
  const stopped = transitionRunState(current, "STOPPED", {
    ...resetStoppedProgress(),
    terminalReason: "visibility-timeout",
    lastError: "Collection stopped because the LinkedIn tab remained hidden for too long."
  });
  const ended = await writeEndedBudget(stopped);
  await appendDiagnostic(runId, "run-stopped", {
    pageNumber: current.pageNumber,
    reason: "visibility-timeout"
  });
  await writeNotice(stopped.lastError, "error");
  await openResultsForRun(ended);
  return { ok: true };
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    throw new Error("Invalid extension message.");
  }
  if (sender.id !== chrome.runtime.id) {
    throw new Error("Messages from unknown extensions are not accepted.");
  }
  if (message.type !== "PING") {
    globalThis.JobCollectorMessages.validateSite(message, SITE_ID);
  }

  switch (message.type) {
    case "START_RUN":
      return handleStart(message.siteId || SITE_ID);
    case "STOP_RUN":
      return handleStop(message.siteId || SITE_ID);
    case "SAVE_CAPTURE":
      return saveCapturedJob(message);
    case "DIAGNOSTIC_EVENT":
      await appendDiagnostic(message.runId, message.event, message.details);
      return { ok: true };
    case "PAUSE_RUN":
      return pauseRun(message.runId);
    case "RESUME_RUN":
      return resumeRun(message.runId);
    case "VISIBILITY_TIMEOUT":
      return stopForVisibilityTimeout(message.runId);
    default:
      throw new Error(`Unsupported message type: ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isNaukriMessage = message && message.siteId === "naukri";
  const operation = isNaukriMessage
    ? globalThis.JobCollectorNaukriBackground.handleMessage(message, sender)
    : initializeStorage().then(() => handleMessage(message, sender));
  operation
    .then(sendResponse)
    .catch(async (error) => {
      if (isNaukriMessage) {
        if (globalThis.JobCollectorNaukriConfig.debug) {
          console.error("[Naukri Jobs Collector] Action failed", errorMessage(error));
        }
        try {
          await chrome.storage.local.set({
            "notices.naukri": {
              text: errorMessage(error),
              kind: "error",
              updatedAt: new Date().toISOString()
            }
          });
        } catch (noticeError) {
          if (globalThis.JobCollectorNaukriConfig.debug) {
            console.error("[Naukri Jobs Collector] Could not write action notice", errorMessage(noticeError));
          }
        }
      } else {
        debugLog("Action failed", errorMessage(error));
        try {
          const state = await readRunState();
          await chrome.storage.local.set({
            [STORAGE_KEYS.runState]: transitionRunState(state, state.state, {
              lastError: errorMessage(error)
            })
          });
          await writeNotice(errorMessage(error), "error");
        } catch (noticeError) {
          debugLog("Could not write action notice", errorMessage(noticeError));
        }
      }
      sendResponse({ ok: false, error: errorMessage(error) });
    });
  return true;
});

async function applyContentProgress(progress) {
  await captureQueue;
  if (!progress || typeof progress.runId !== "string") {
    throw new Error("Invalid content progress payload.");
  }

  const current = await readRunState();
  if (!ACTIVE_STATES.has(current.state) || current.runId !== progress.runId) {
    return;
  }

  const countFields = [
    "currentPage",
    "capturedCount",
    "easyApplyCount",
    "companySiteCount"
  ];
  const updates = {};
  for (const field of countFields) {
    const maximum = field === "currentPage"
      ? globalThis.JobCollectorConfig.maxPages
      : globalThis.JobCollectorConfig.maxJobsPerRun;
    if (
      !Number.isInteger(progress[field])
      || progress[field] < 0
      || progress[field] > maximum
    ) {
      throw new Error(`Invalid content progress value for ${field}.`);
    }
    updates[field] = progress[field];
  }
  updates.pageNumber = updates.currentPage;
  if (progress.searchUrl !== undefined) {
    let searchUrl;
    try {
      searchUrl = getSearchUrl(progress.searchUrl);
    } catch (error) {
      throw new Error(`Invalid content searchUrl: ${errorMessage(error)}`);
    }
    if (current.searchUrl && searchUrl !== current.searchUrl) {
      throw new Error("Content progress searchUrl does not match the active search.");
    }
    updates.searchUrl = searchUrl;
  }
  if (
    updates.easyApplyCount > updates.capturedCount
    || updates.companySiteCount > updates.capturedCount
  ) {
    throw new Error("Content progress counts exceed the captured job count.");
  }
  if (progress.lastError !== undefined) {
    if (progress.lastError !== null && typeof progress.lastError !== "string") {
      throw new Error("Content progress lastError must be a string or null.");
    }
    updates.lastError = progress.lastError;
  }

  if (progress.phase !== undefined) {
    if (progress.phase !== "RUNNING" && progress.phase !== "PAGINATING") {
      throw new Error("Invalid content progress phase.");
    }
    await enqueueTerminalOperation(async () => {
      const latest = await readRunState();
      if (latest.runId !== progress.runId || !ACTIVE_STATES.has(latest.state)) {
        return;
      }
      const nextState = latest.state === "PAUSED"
        ? "PAUSED"
        : progress.phase;
      const phaseChanges = latest.state === "PAUSED"
        ? { ...updates, pausedFrom: progress.phase }
        : updates;
      await chrome.storage.local.set({
        [STORAGE_KEYS.runState]: transitionRunState(
          latest,
          nextState,
          phaseChanges
        )
      });
    });
    return;
  }

  if (progress.terminalState !== undefined) {
    if (!["DONE", "STOPPED", "ERROR"].includes(progress.terminalState)) {
      throw new Error("Invalid content terminal state.");
    }
    if (
      progress.terminalState === "ERROR"
      && (typeof progress.abortReason !== "string" || progress.abortReason.length === 0)
    ) {
      throw new Error("Content error progress is missing an abort reason.");
    }
    const terminal = transitionRunState(current, progress.terminalState, {
      ...updates,
      ...(progress.terminalState === "STOPPED" ? resetStoppedProgress() : {}),
      resultsOpening: updates.capturedCount > 0,
      terminalReason: progress.terminalReason || (
        progress.terminalState === "STOPPED" ? "stalled" : null
      ),
      circuitBreaker: progress.circuitBreaker === true,
      lastError: progress.terminalState === "ERROR"
        ? progress.abortReason
        : (progress.lastError === undefined ? current.lastError : progress.lastError)
    });
    const ended = await writeEndedBudget(terminal, {
      circuitBreaker: progress.circuitBreaker === true
    });
    await appendDiagnostic(progress.runId, "run-ended", {
      pageNumber: updates.currentPage,
      reason: progress.terminalReason || progress.terminalState
    });
    const notice = progress.terminalState === "ERROR"
      ? progress.abortReason
      : (typeof progress.message === "string" ? progress.message : "Results page complete.");
    await writeNotice(notice, progress.terminalState === "ERROR" ? "error" : "success");
    if (
      progress.terminalState !== "ERROR"
      || progress.circuitBreaker === true
    ) {
      await openResultsForRun(ended);
    }
    return;
  }

  await enqueueTerminalOperation(async () => {
    const latest = await readRunState();
    if (latest.runId !== progress.runId || !ACTIVE_STATES.has(latest.state)) {
      return;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.runState]: transitionRunState(latest, latest.state, updates)
    });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEYS.progress]) {
    return;
  }

  const progress = changes[STORAGE_KEYS.progress].newValue;
  progressQueue = progressQueue
    .then(() => applyContentProgress(progress))
    .catch((error) => {
      debugLog("Could not persist content progress", errorMessage(error));
      return persistRunFailure(error);
    });
});

async function failRunForTab(tabId, reason, { circuitBreaker = false } = {}) {
  await captureQueue;
  await progressQueue;
  const state = await readRunState();
  if (state.tabId !== tabId || !ACTIVE_STATES.has(state.state)) {
    return;
  }

  const cooldown = circuitBreaker ? await applyBlockCooldown() : null;
  const failed = transitionRunState(state, "ERROR", {
    lastError: reason,
    circuitBreaker,
    ...(cooldown ? { cooldownUntil: cooldown.until } : {})
  });
  const ended = await writeEndedBudget(failed, { circuitBreaker });
  await appendDiagnostic(state.runId, circuitBreaker ? "circuit-breaker" : "run-error", {
    pageNumber: state.pageNumber,
    reason: circuitBreaker ? "blocking-url" : "tab-route-or-close"
  });
  await writeNotice(cooldown
    ? `${reason} LinkedIn collection is paused until ${new Date(cooldown.until).toLocaleString()}.`
    : reason, "error");
  if (circuitBreaker) {
    await openResultsForRun(ended);
  }
}

async function stopRunForClosedTab(tabId) {
  await captureQueue;
  await progressQueue;
  const state = await readRunState();
  if (state.tabId !== tabId || !ACTIVE_STATES.has(state.state)) {
    return;
  }
  const stopped = transitionRunState(state, "STOPPED", {
    ...resetStoppedProgress(),
    terminalReason: "tab_closed",
    lastError: null,
    resultsOpening: state.capturedCount > 0
  });
  const ended = await writeEndedBudget(stopped);
  await appendDiagnostic(state.runId, "run-stopped", {
    pageNumber: state.pageNumber,
    reason: "tab-route-or-close"
  });
  await writeNotice("LinkedIn collection stopped because its tab was closed.", "error");
  await openResultsForRun(ended);
}

async function recoverStaleLinkedInRun() {
  const state = await readRunState();
  if (!ACTIVE_STATES.has(state.state)) {
    return;
  }
  const tabs = await chrome.tabs.query({});
  if (Number.isInteger(state.tabId) && !tabs.some((tab) => tab.id === state.tabId)) {
    await stopRunForClosedTab(state.tabId);
    return;
  }
  const lastAction = Date.parse(state.lastActionAt || state.updatedAt || "");
  if (Number.isFinite(lastAction) && Date.now() - lastAction <= 15 * 60 * 1000) {
    return;
  }
  const stopped = transitionRunState(state, "STOPPED", {
    ...resetStoppedProgress(),
    terminalReason: "stale",
    lastError: null,
    resultsOpening: state.capturedCount > 0
  });
  const ended = await writeEndedBudget(stopped);
  await writeNotice("LinkedIn collection stopped because its saved run was stale.", "error");
  await openResultsForRun(ended);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void Promise.all([
    stopRunForClosedTab(tabId),
    globalThis.JobCollectorNaukriBackground.stopForTabClosed(tabId)
  ])
    .catch((error) => {
      debugLog("Could not stop run after tab close", errorMessage(error));
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    void globalThis.JobCollectorNaukriBackground.resumePendingNavigation(
      tabId,
      changeInfo.url || (tab && tab.url)
    ).catch((error) => {
      debugLog("Could not resume Naukri after navigation", errorMessage(error));
    });
  }
  if (typeof changeInfo.url !== "string" || isSearchResultsUrl(changeInfo.url)) {
    return;
  }

  const circuitBreaker = isBlockingUrl(changeInfo.url);
  const reason = circuitBreaker
    ? "LinkedIn checkpoint, login wall, or challenge URL detected."
    : "The active page left the LinkedIn jobs search-results route.";
  void failRunForTab(tabId, reason, { circuitBreaker })
    .catch((error) => {
      debugLog("Could not stop run after route change", errorMessage(error));
    });
});

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorage().then(async () => {
    await recoverStaleLinkedInRun();
    await globalThis.JobCollectorNaukriBackground.recoverStaleRun();
    return recoverResultsOpening();
  }).catch((error) => {
    debugLog("Storage initialization failed", errorMessage(error));
  });
});

chrome.runtime.onStartup.addListener(() => {
  void initializeStorage().then(async () => {
    await recoverStaleLinkedInRun();
    await globalThis.JobCollectorNaukriBackground.recoverStaleRun();
    return recoverResultsOpening();
  }).catch((error) => {
    debugLog("Storage initialization failed", errorMessage(error));
  });
});

void initializeStorage().then(async () => {
  await recoverStaleLinkedInRun();
  await globalThis.JobCollectorNaukriBackground.recoverStaleRun();
  return recoverResultsOpening();
}).catch((error) => {
  debugLog("Storage initialization failed", errorMessage(error));
});
