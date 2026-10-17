"use strict";

(function initializeNaukriBackground(global) {
  const siteId = "naukri";
  const keys = global.JobCollectorStorage.keysForSite(siteId);
  const adapter = global.JobCollectorNaukriAdapter;
  const config = global.JobCollectorNaukriConfig;
  const runGuard = global.JobCollectorRunGuard || Object.freeze({
    withStartLock(operation) { return operation(); },
    activeRunMessage() { return "A collector run is already active (RUNNING on another site)."; }
  });
  const ACTIVE_STATES = new Set(["RUNNING", "PAGINATING", "PAUSED"]);
  const NAVIGATION_ALARM_PREFIX = "naukri-navigation:";
  const CONTENT_FILES = Object.freeze([
    "src/core/storage.js",
    "src/sites/naukri/config.js",
    "src/sites/naukri/selectors.js",
    "src/sites/naukri/adapter.js",
    "src/core/run-loop.js",
    "src/sites/naukri/collector.js"
  ]);
  let initializationPromise = null;
  let resultsQueue = Promise.resolve();
  let captureQueue = Promise.resolve();
  let startInProgress = false;

  function dayKey(date = new Date()) {
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function defaultState() {
    return {
      state: "IDLE",
      siteId,
      runId: null,
      tabId: null,
      pageNumber: 0,
      currentPage: 0,
      searchUrl: null,
      capturedCount: 0,
      capturedJobIds: [],
      resultsOpening: false,
      resultsOpened: false,
      navigationPending: false,
      lastActionAt: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      lastError: null,
      terminalReason: null
    };
  }

  function resetRunProgress() {
    return {
      pageNumber: 0,
      currentPage: 0,
      capturedCount: 0,
      capturedJobIds: []
    };
  }

  function normalizeBudget(budget) {
    const today = dayKey();
    if (!budget || budget.dayKey !== today) {
      return { dayKey: today, jobsToday: 0, seenJobIds: [] };
    }
    if (
      !Number.isInteger(budget.jobsToday)
      || budget.jobsToday < 0
      || !Array.isArray(budget.seenJobIds)
      || budget.seenJobIds.some((id) => typeof id !== "string" || !/^\d+$/.test(id))
    ) {
      throw new Error("Stored Naukri daily budget is invalid.");
    }
    return { dayKey: today, jobsToday: budget.jobsToday, seenJobIds: budget.seenJobIds };
  }

  function transition(current, state, changes = {}) {
    return {
      ...current,
      ...changes,
      siteId,
      state,
      updatedAt: new Date().toISOString()
    };
  }

  async function getState() {
    const values = await chrome.storage.local.get(keys.runState);
    return values[keys.runState] || defaultState();
  }

  async function initialize() {
    if (!initializationPromise) {
      initializationPromise = (async () => {
        const values = await chrome.storage.local.get([
          keys.runState,
          keys.budget,
          keys.cooldown,
          keys.killSwitch,
          keys.openedJobs,
          keys.selectedTab
        ]);
        const initial = {};
        if (!values[keys.runState]) {
          initial[keys.runState] = defaultState();
        }
        if (!values[keys.budget] || values[keys.budget].dayKey !== dayKey()) {
          initial[keys.budget] = normalizeBudget(values[keys.budget]);
        }
        if (!values[keys.cooldown] || typeof values[keys.cooldown] !== "object") {
          initial[keys.cooldown] = { until: 0, recentBlocks: [] };
        }
        if (!values[keys.killSwitch] || typeof values[keys.killSwitch] !== "object") {
          initial[keys.killSwitch] = { triggerCount: 0, lastTriggeredAt: null };
        }
        if (!values[keys.openedJobs] || typeof values[keys.openedJobs] !== "object") {
          initial[keys.openedJobs] = {};
        }
        if (
          values[keys.selectedTab] !== "Company Jobs"
          && values[keys.selectedTab] !== "Consultant Jobs"
        ) {
          initial[keys.selectedTab] = "Company Jobs";
        }
        if (Object.keys(initial).length) {
          await chrome.storage.local.set(initial);
        }
      })().catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }
    return initializationPromise;
  }

  async function readBudget() {
    const values = await chrome.storage.local.get(keys.budget);
    const budget = normalizeBudget(values[keys.budget]);
    if (!values[keys.budget] || budget.dayKey !== values[keys.budget].dayKey) {
      await chrome.storage.local.set({ [keys.budget]: budget });
    }
    return budget;
  }

  async function getAllSiteRuns() {
    const values = await chrome.storage.local.get(["runs.linkedin", keys.runState]);
    return [values["runs.linkedin"], values[keys.runState]].filter(Boolean);
  }

  async function pingContentScript(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING", siteId });
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
      throw new Error("Could not connect to the Naukri jobs content script. Refresh the page and try again.");
    }
  }

  async function resumePendingNavigation(tabId, urlValue) {
    const current = await getState();
    if (
      !current.navigationPending
      || current.state !== "RUNNING"
      || current.tabId !== tabId
      || typeof current.runId !== "string"
    ) {
      return;
    }
    let url;
    try {
      url = new URL(urlValue);
    } catch (_error) {
      return;
    }
    if (!adapter.matchesUrl(url)) {
      return;
    }
    await ensureContentScript(tabId);
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "NAUKRI_RESUME_RUN",
      siteId,
      runId: current.runId
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error || "The Naukri page did not resume the pending run.");
    }
  }

  async function writeNotice(text, kind) {
    await chrome.storage.local.set({
      [keys.notice]: { text, kind, updatedAt: new Date().toISOString() }
    });
  }

  async function appendDiagnostic(runId, event, details = {}) {
    const values = await chrome.storage.local.get(keys.diagnostics);
    const prior = Array.isArray(values[keys.diagnostics]) ? values[keys.diagnostics] : [];
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await chrome.storage.local.set({
      [keys.diagnostics]: prior.concat({
        at: new Date().toISOString(),
        runId,
        siteId,
        event,
        details
      }).filter((entry) => Number.isFinite(Date.parse(entry && entry.at)) && Date.parse(entry.at) >= cutoff).slice(-200)
    });
  }

  async function openResults(state) {
    if (!state || state.resultsOpened || state.capturedCount < 1) {
      return;
    }
    const pending = resultsQueue.then(async () => {
      const current = await getState();
      if (
        current.runId !== state.runId
        || current.resultsOpened
        || current.capturedCount < 1
      ) {
        return;
      }
      await chrome.storage.local.set({
        [keys.runState]: transition(current, current.state, { resultsOpening: true })
      });
      try {
        const targetUrl = `${chrome.runtime.getURL("results.html")}?site=${siteId}&runId=${encodeURIComponent(current.runId)}`;
        const tabs = await chrome.tabs.query({});
        let tab = tabs.find((candidate) => candidate.url === targetUrl);
        if (!tab) {
          tab = await chrome.tabs.create({ url: targetUrl, active: true });
        } else if (Number.isInteger(tab.id)) {
          await chrome.tabs.update(tab.id, { active: true });
        }
        const latest = await getState();
        if (latest.runId === current.runId) {
          await chrome.storage.local.set({
            [keys.runState]: transition(latest, latest.state, {
              resultsOpening: false,
              resultsOpened: true,
              resultsTabId: Number.isInteger(tab.id) ? tab.id : null
            })
          });
        }
      } catch (error) {
        const latest = await getState();
        if (latest.runId === current.runId) {
          await chrome.storage.local.set({
            [keys.runState]: transition(latest, latest.state, {
              resultsOpening: false,
              lastError: `Could not open results: ${error instanceof Error ? error.message : String(error)}`
            })
          });
        }
        throw error;
      }
    });
    resultsQueue = pending.catch(() => {});
    return pending;
  }

  async function finish(state, terminalState, changes = {}) {
    const current = await getState();
    if (current.runId !== state.runId || !ACTIVE_STATES.has(current.state)) {
      return current;
    }
    const ended = transition(current, terminalState, {
      ...changes,
      ...resetRunProgress(),
      navigationPending: false,
      resultsOpening: false
    });
    await chrome.storage.local.set({ [keys.runState]: ended });
    await chrome.alarms.clear(NAVIGATION_ALARM_PREFIX + state.runId);
    if (ended.capturedCount > 0) {
      await openResults(ended);
    }
    return ended;
  }

  async function applyBlockCooldown() {
    const values = await chrome.storage.local.get([keys.cooldown, keys.killSwitch]);
    const current = values[keys.cooldown] || {};
    const now = Date.now();
    const recent = Array.isArray(current.recentBlocks)
      ? current.recentBlocks.filter((timestamp) => (
        Number.isFinite(timestamp) && now - timestamp <= config.repeatedBlockWindowMs
      ))
      : [];
    const repeated = recent.length > 0;
    const nextRecent = recent.concat(now);
    const duration = repeated ? config.repeatedBlockCooldownMs : config.cooldownMs;
    const cooldown = {
      recentBlocks: nextRecent,
      lastBlockAt: now,
      until: now + duration,
      reason: repeated ? "repeated-block" : "block"
    };
    const previousKillSwitch = values[keys.killSwitch] || {};
    await chrome.storage.local.set({
      [keys.cooldown]: cooldown,
      [keys.killSwitch]: {
        triggerCount: Number.isInteger(previousKillSwitch.triggerCount)
          ? previousKillSwitch.triggerCount + 1
          : 1,
        lastTriggeredAt: now
      }
    });
    return cooldown;
  }

  async function finishFailure(message) {
    const current = await getState();
    if (current.runId !== message.runId || !ACTIVE_STATES.has(current.state)) {
      return { ok: false, error: "The Naukri run is no longer active." };
    }
    const isBlock = message.errorCode === "block_detected";
    const cooldown = isBlock ? await applyBlockCooldown() : null;
    const text = message.errorCode === "page_load_failed"
      ? "page_load_failed"
      : String(message.message || "Naukri collection failed.");
    const ended = await finish(current, "ERROR", {
      lastError: text,
      terminalReason: message.errorCode || "collector_error",
      circuitBreaker: isBlock,
      ...(cooldown ? { cooldownUntil: cooldown.until } : {})
    });
    await writeNotice(isBlock
      ? `${text} Naukri collection is paused until ${new Date(cooldown.until).toLocaleString()}.`
      : text, "error");
    await appendDiagnostic(current.runId, isBlock ? "circuit-breaker" : "run-error", {
      reason: message.errorCode || "collector_error"
    });
    return { ok: true, state: ended.state };
  }

  async function startRun() {
    if (startInProgress) {
      throw new Error("A collector run is already starting.");
    }
    startInProgress = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") {
        throw new Error("Could not identify the active browser tab.");
      }
      const url = new URL(tab.url);
      if (!adapter.matchesUrl(url)) {
        throw new Error("Open a Naukri search results page to start.");
      }
      await ensureContentScript(tab.id);

      const runs = await getAllSiteRuns();
      if (runs.some((run) => ACTIVE_STATES.has(run.state) || run.resultsOpening)) {
        throw new Error(runGuard.activeRunMessage(runs.find((run) => ACTIVE_STATES.has(run.state) || run.resultsOpening)));
      }
      const cooldownValues = await chrome.storage.local.get(keys.cooldown);
      const cooldown = cooldownValues[keys.cooldown] || {};
      if (Number.isFinite(cooldown.until) && cooldown.until > Date.now()) {
        throw new Error(`Naukri is cooling down until ${new Date(cooldown.until).toLocaleString()}.`);
      }
      const budget = await readBudget();
      if (budget.jobsToday >= config.maxJobsPerDay) {
        throw new Error(`Daily Naukri job limit reached (${budget.jobsToday}/${config.maxJobsPerDay}).`);
      }
      const current = await getState();
      if (ACTIVE_STATES.has(current.state) || current.resultsOpening) {
        throw new Error("A Naukri collector run is already active.");
      }

      const runId = crypto.randomUUID();
      const running = transition(current, "RUNNING", {
        runId,
        siteId,
        tabId: tab.id,
        pageNumber: 1,
        currentPage: 1,
        searchUrl: url.href,
        capturedCount: 0,
        capturedJobIds: [],
        microPauseEveryPages: config.microPauseEveryPages.min
          + Math.floor(Math.random() * (
            config.microPauseEveryPages.max - config.microPauseEveryPages.min + 1
          )),
        startedAt: new Date().toISOString(),
        lastActionAt: new Date().toISOString(),
        lastError: null,
        terminalReason: null,
        resultsOpened: false,
        resultsOpening: false,
        navigationPending: false
      });
      await chrome.storage.local.set({
        [keys.runState]: running,
        [keys.progress]: {
          runId,
          pageNumber: 1,
          currentPage: 1,
          searchUrl: url.href,
          capturedCount: 0,
          updatedAt: new Date().toISOString()
        }
      });
      await writeNotice("Collecting Naukri job results.", "info");
      await appendDiagnostic(runId, "run-start");
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "START_RUN",
          siteId,
          runId
        });
        if (!response || !response.ok) {
          throw new Error(response && response.error || "The Naukri content script did not acknowledge the run.");
        }
      } catch (error) {
        await finish(running, "ERROR", {
          lastError: error instanceof Error ? error.message : String(error),
          terminalReason: "start-error"
        });
        await writeNotice(error instanceof Error ? error.message : String(error), "error");
        throw error;
      }
      return { ok: true };
    } finally {
      startInProgress = false;
    }
  }

  async function stopRun() {
    await captureQueue;
    const current = await getState();
    if (current.siteId !== siteId || !ACTIVE_STATES.has(current.state)) {
      throw new Error("There is no active Naukri run to stop.");
    }
    const stopped = transition(current, "STOPPED", {
      ...resetRunProgress(),
      terminalReason: "user-stop",
      lastError: null,
      navigationPending: false
    });
    await chrome.storage.local.set({ [keys.runState]: stopped });
    await chrome.alarms.clear(NAVIGATION_ALARM_PREFIX + current.runId);
    if (Number.isInteger(current.tabId)) {
      try {
        await chrome.tabs.sendMessage(current.tabId, {
          type: "STOP_RUN",
          siteId,
          runId: current.runId
        });
      } catch (_error) {
        await writeNotice("Run stopped; the page did not acknowledge STOP.", "error");
      }
    }
    await writeNotice("Naukri run stopped.", "info");
    await appendDiagnostic(current.runId, "run-stopped", { reason: "user-stop" });
    await openResults(stopped);
    return { ok: true };
  }

  async function saveCapture(message, sender) {
    const operation = captureQueue.then(async () => {
      const current = await getState();
      if (
        current.siteId !== siteId
        || !ACTIVE_STATES.has(current.state)
        || current.runId !== message.runId
        || !sender.tab
        || sender.tab.id !== current.tabId
      ) {
        throw new Error("The capture is not associated with the active Naukri run.");
      }
      const record = adapter.normalize(message.record);
      if (
        !/^\d+$/.test(record.jobId)
        || !Number.isInteger(record.pageNumber)
        || record.pageNumber < 1
      ) {
        throw new Error("The Naukri capture has invalid job or page data.");
      }
      const budget = await readBudget();
      const jobs = await global.JobCollectorStorage.getJobs(siteId);
      if (
        Object.prototype.hasOwnProperty.call(jobs, record.jobId)
        || budget.seenJobIds.includes(record.jobId)
        || current.capturedJobIds.includes(record.jobId)
      ) {
        return { ok: true, saved: false };
      }
      if (
        current.capturedCount >= config.maxJobsPerRun
        || budget.jobsToday >= config.maxJobsPerDay
      ) {
        const ended = await finish(current, "DONE", {
          terminalReason: "limit",
          lastError: null
        });
        await writeNotice("Naukri job limit reached; the run finished.", "success");
        await openResults(ended);
        return { ok: true, saved: false, limitReached: true };
      }

      const capturedAt = new Date().toISOString();
      const savedRecord = { ...record, capturedAt };
      const nextJobs = { ...jobs, [record.jobId]: savedRecord };
      const capturedJobIds = current.capturedJobIds.concat(record.jobId);
      const capturedCount = current.capturedCount + 1;
      const nextBudget = {
        ...budget,
        jobsToday: budget.jobsToday + 1,
        seenJobIds: budget.seenJobIds.concat(record.jobId)
      };
      let nextState = transition(current, current.state, {
        capturedCount,
        capturedJobIds,
        pageNumber: record.pageNumber,
        currentPage: record.pageNumber,
        lastActionAt: capturedAt
      });
      if (capturedCount >= config.maxJobsPerRun || nextBudget.jobsToday >= config.maxJobsPerDay) {
        nextState = transition(current, "DONE", {
          capturedCount,
          capturedJobIds,
          pageNumber: record.pageNumber,
          currentPage: record.pageNumber,
          terminalReason: "limit",
          lastError: null
        });
      }
      await global.JobCollectorStorage.setJobs(siteId, nextJobs, {
        [keys.budget]: nextBudget,
        [keys.runState]: nextState
      });
      if (nextState.state === "DONE") {
        await writeNotice("Naukri job limit reached; the run finished.", "success");
        await openResults(nextState);
      }
      return { ok: true, saved: true, capturedCount };
    });
    captureQueue = operation.catch(() => {});
    return operation;
  }

  async function handleMessage(message, sender) {
    if (!sender || sender.id !== chrome.runtime.id) {
      throw new Error("Messages from unknown extensions are not accepted.");
    }
    if (!message || message.siteId !== siteId) {
      throw new Error("The message site does not match the Naukri adapter.");
    }
    await initialize();
    switch (message.type) {
      case "START_RUN":
        return runGuard.withStartLock(() => startRun());
      case "STOP_RUN":
        return stopRun();
      case "SAVE_CAPTURE":
        return saveCapture(message, sender);
      case "NAUKRI_PROGRESS": {
        const current = await getState();
        if (
          current.runId !== message.runId
          || !ACTIVE_STATES.has(current.state)
          || !sender.tab
          || sender.tab.id !== current.tabId
        ) {
          throw new Error("The Naukri run is no longer active.");
        }
        const next = transition(current, current.state, {
          pageNumber: message.pageNumber,
          currentPage: message.pageNumber,
          capturedCount: current.capturedCount,
          phase: message.phase,
          lastActionAt: new Date().toISOString()
        });
        await chrome.storage.local.set({
          [keys.runState]: next,
          [keys.progress]: {
            runId: current.runId,
            pageNumber: message.pageNumber,
            currentPage: message.pageNumber,
            capturedCount: current.capturedCount,
            phase: message.phase,
            updatedAt: new Date().toISOString()
          }
        });
        return { ok: true };
      }
      case "NAUKRI_PREPARE_NAVIGATION": {
        const current = await getState();
        if (
          current.runId !== message.runId
          || !ACTIVE_STATES.has(current.state)
          || !sender.tab
          || sender.tab.id !== current.tabId
          || sender.id !== chrome.runtime.id
          || !Number.isInteger(message.pageNumber)
          || message.pageNumber !== current.pageNumber + 1
        ) {
          throw new Error("The Naukri pagination action does not match the active run.");
        }
        const updated = transition(current, "RUNNING", {
          pageNumber: message.pageNumber,
          currentPage: message.pageNumber,
          searchUrl: adapter.matchesUrl(new URL(message.searchUrl))
            ? message.searchUrl
            : current.searchUrl,
          lastActionAt: new Date().toISOString(),
          navigationPending: true
        });
        await chrome.storage.local.set({ [keys.runState]: updated });
        await chrome.alarms.create(NAVIGATION_ALARM_PREFIX + current.runId, {
          when: Date.now() + config.navigationTimeoutMs
        });
        return { ok: true };
      }
      case "NAUKRI_RESUME_CHECK": {
        const current = await getState();
        let validUrl = false;
        try {
          const url = new URL(message.href);
          validUrl = url.protocol === "https:"
            && url.hostname === "www.naukri.com"
            && (adapter.matchesUrl(url) || current.navigationPending);
        } catch (_error) {
          validUrl = false;
        }
        const resume = Boolean(
          validUrl
          && sender.tab
          && sender.tab.id === current.tabId
          && current.siteId === siteId
          && current.state === "RUNNING"
        );
        if (!resume) {
          return { ok: true, resume: false };
        }
        const next = transition(current, "RUNNING", {
          searchUrl: message.href,
          navigationPending: false,
          lastActionAt: new Date().toISOString()
        });
        await chrome.storage.local.set({ [keys.runState]: next });
        await chrome.alarms.clear(NAVIGATION_ALARM_PREFIX + current.runId);
        return { ok: true, resume: true, runState: next };
      }
      case "NAUKRI_RUN_FINISHED": {
        const current = await getState();
        if (
          current.runId !== message.runId
          || !ACTIVE_STATES.has(current.state)
          || !sender.tab
          || sender.tab.id !== current.tabId
        ) {
          throw new Error("The Naukri run is no longer active.");
        }
        const ended = await finish(current, "DONE", {
          pageNumber: message.pageNumber,
          currentPage: message.pageNumber,
          capturedCount: current.capturedCount,
          terminalReason: "complete",
          lastError: null,
          lastActionAt: new Date().toISOString()
        });
        await writeNotice(message.message || "Naukri results collected.", "success");
        return { ok: true, state: ended.state };
      }
      case "NAUKRI_RUN_FAILED": {
        const current = await getState();
        if (
          current.runId !== message.runId
          || !ACTIVE_STATES.has(current.state)
          || !sender.tab
          || sender.tab.id !== current.tabId
        ) {
          throw new Error("The Naukri failure does not match the active tab and run.");
        }
        return finishFailure(message);
      }
      default:
        throw new Error(`Unsupported Naukri message type: ${message.type}`);
    }
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(NAVIGATION_ALARM_PREFIX)) {
      return;
    }
    void (async () => {
      const state = await getState();
      if (
        state.runId
        && alarm.name === NAVIGATION_ALARM_PREFIX + state.runId
        && state.state === "RUNNING"
        && state.navigationPending
      ) {
        await finishFailure({
          runId: state.runId,
          errorCode: "page_load_failed",
          message: "page_load_failed"
        });
      }
    })().catch((error) => {
      if (config.debug) {
        console.error("[Naukri Jobs Collector] Navigation timeout handler failed", error);
      }
    });
  });

  global.JobCollectorNaukriBackground = Object.freeze({
    handleMessage,
    initialize,
    resumePendingNavigation,
    async stopForTabClosed(tabId) {
      const current = await getState();
      if (current.tabId !== tabId || !ACTIVE_STATES.has(current.state)) {
        return;
      }
      await finish(current, "STOPPED", {
        terminalReason: "tab_closed",
        lastError: null
      });
      await writeNotice("Naukri collection stopped because its tab was closed.", "error");
      await appendDiagnostic(current.runId, "run-stopped", { reason: "tab_closed" });
    },
    async recoverStaleRun() {
      const current = await getState();
      if (!ACTIVE_STATES.has(current.state)) {
        return;
      }
      const tabs = await chrome.tabs.query({});
      if (Number.isInteger(current.tabId) && !tabs.some((tab) => tab.id === current.tabId)) {
        await finish(current, "STOPPED", {
          terminalReason: "tab_closed",
          lastError: null
        });
        await writeNotice("Naukri collection stopped because its tab was closed.", "error");
        await appendDiagnostic(current.runId, "run-stopped", { reason: "tab_closed" });
        return;
      }
      const lastAction = Date.parse(current.lastActionAt || current.updatedAt || "");
      if (Number.isFinite(lastAction) && Date.now() - lastAction <= 15 * 60 * 1000) {
        return;
      }
      await finish(current, "STOPPED", {
        terminalReason: "stale",
        lastError: null
      });
      await writeNotice("Naukri collection stopped because its saved run was stale.", "error");
      await appendDiagnostic(current.runId, "run-stopped", { reason: "stale" });
    }
  });
})(globalThis);
