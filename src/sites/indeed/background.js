"use strict";

(function initializeIndeedBackground(global) {
  const siteId = "indeed";
  const keys = global.JobCollectorStorage.keysForSite(siteId);
  const adapter = global.JobCollectorIndeedAdapter;
  const config = global.JobCollectorIndeedConfig;
  const runGuard = global.JobCollectorRunGuard || Object.freeze({
    withStartLock(operation) { return operation(); },
    activeRunMessage() { return "A collector run is already active. Stop it before starting another site."; }
  });
  const ACTIVE_STATES = new Set(["RUNNING", "PAGINATING", "PAUSED"]);
  const NAVIGATION_ALARM_PREFIX = "indeed-navigation:";
  const CONTENT_FILES = Object.freeze([
    "src/core/storage.js",
    "src/sites/indeed/config.js",
    "src/sites/indeed/selectors.js",
    "src/sites/indeed/parse.js",
    "src/sites/indeed/adapter.js",
    "src/core/run-loop.js",
    "src/sites/indeed/collector.js"
  ]);
  let initializationPromise = null;
  let captureQueue = Promise.resolve();
  let resultsQueue = Promise.resolve();
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
      skippedAppliedCount: 0,
      skippedExpiredCount: 0,
      skippedJobIds: [],
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

  function emptyBudget(dateKey = dayKey()) {
    return {
      dayKey: dateKey,
      jobsToday: 0,
      seenJobIds: [],
      runsToday: 0,
      lastRunAt: null
    };
  }

  function canonicalSearchUrl(value) {
    const url = value instanceof URL ? new URL(value.href) : new URL(value);
    if (!adapter.matchesUrl(url)) {
      throw new Error("An Indeed /jobs search URL with a q= term is required.");
    }
    return `https://in.indeed.com/jobs?q=${encodeURIComponent(url.searchParams.get("q"))}`;
  }

  function normalizeBudget(budget) {
    const today = dayKey();
    if (!budget || budget.dayKey !== today) {
      return emptyBudget(today);
    }
    if (
      !Number.isInteger(budget.jobsToday)
      || budget.jobsToday < 0
      || !Array.isArray(budget.seenJobIds)
      || budget.seenJobIds.some((id) => typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id))
      || !Number.isInteger(budget.runsToday)
      || budget.runsToday < 0
      || (budget.lastRunAt !== null && !Number.isFinite(Date.parse(budget.lastRunAt)))
    ) {
      throw new Error("Stored Indeed daily budget is invalid; Start is blocked to protect the limits.");
    }
    return {
      dayKey: today,
      jobsToday: budget.jobsToday,
      seenJobIds: budget.seenJobIds,
      runsToday: budget.runsToday,
      lastRunAt: budget.lastRunAt
    };
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

  function activeRunMessage(run) {
    const label = run && run.siteId === "linkedin"
      ? "LinkedIn"
      : run && run.siteId === "naukri"
        ? "Naukri"
        : "Indeed";
    return `A collector run is already active (RUNNING on ${label}). Stop it before starting another site.`;
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
          initial[keys.budget] = emptyBudget();
        } else {
          normalizeBudget(values[keys.budget]);
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
        if (values[keys.selectedTab] !== "Easy Apply" && values[keys.selectedTab] !== "Company Site") {
          initial[keys.selectedTab] = "Easy Apply";
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

  async function pingContentScript(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING", siteId });
      return response && response.ok ? response : null;
    } catch (_error) {
      return null;
    }
  }

  async function ensureContentScript(tabId) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await pingContentScript(tabId);
      if (response) {
        return response;
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load the Indeed content scripts: ${detail}`);
    }
    const response = await pingContentScript(tabId);
    if (!response) {
      throw new Error("Could not connect to the Indeed jobs content script. Refresh the page and try again.");
    }
    return response;
  }

  async function getAllSiteRuns() {
    const values = await chrome.storage.local.get(["runs.linkedin", "runs.naukri", keys.runState]);
    return [values["runs.linkedin"], values["runs.naukri"], values[keys.runState]].filter(Boolean);
  }

  async function writeNotice(text, kind) {
    await chrome.storage.local.set({
      [keys.notice]: { text, kind, updatedAt: new Date().toISOString() }
    });
  }

  async function savePageDiagnostics(message, sender) {
    const current = await getState();
    const counters = message.counters;
    const counterKeys = [
      "cards",
      "matched",
      "invalidId",
      "matchedEmpty",
      "sponsoredNoDate",
      "jsonMissing",
      "parseError",
      "notInResults"
    ];
    if (
      current.siteId !== siteId
      || !ACTIVE_STATES.has(current.state)
      || current.runId !== message.runId
      || current.pageNumber !== message.pageNumber
      || !sender.tab
      || sender.tab.id !== current.tabId
      || !counters
      || counterKeys.some((key) => !Number.isInteger(counters[key]) || counters[key] < 0)
    ) {
      throw new Error("Indeed page diagnostics do not match the active run and page.");
    }

    const values = await chrome.storage.local.get(keys.diagnostics);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const previous = Array.isArray(values[keys.diagnostics])
      ? values[keys.diagnostics].filter((entry) => (
        entry
        && Number.isFinite(Date.parse(entry.at))
        && Date.parse(entry.at) >= cutoff
      ))
      : [];
    const event = {
      at: new Date().toISOString(),
      runId: current.runId,
      siteId,
      pageNumber: message.pageNumber,
      counters: Object.fromEntries(counterKeys.map((key) => [key, counters[key]]))
    };
    await chrome.storage.local.set({
      [keys.diagnostics]: previous.concat(event).slice(-1000)
    });
    return { ok: true };
  }

  async function openResults(state) {
    if (!state || state.resultsOpened || state.capturedCount < 1) {
      return;
    }
    const pending = resultsQueue.then(async () => {
      const current = await getState();
      if (current.runId !== state.runId || current.resultsOpened || current.capturedCount < 1) {
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

  async function finish(current, terminalState, changes = {}) {
    const latest = await getState();
    if (latest.runId !== current.runId || !ACTIVE_STATES.has(latest.state)) {
      return latest;
    }
    const ended = transition(latest, terminalState, {
      ...changes,
      navigationPending: false,
      resultsOpening: false
    });
    await chrome.storage.local.set({ [keys.runState]: ended });
    await chrome.alarms.clear(NAVIGATION_ALARM_PREFIX + current.runId);
    if (ended.capturedCount > 0) {
      await openResults(ended);
    }
    return ended;
  }

  async function applyBlockCooldown() {
    const values = await chrome.storage.local.get([keys.cooldown, keys.killSwitch]);
    const current = values[keys.cooldown] || {};
    const now = Date.now();
    const recentBlocks = Array.isArray(current.recentBlocks)
      ? current.recentBlocks.filter((time) => Number.isFinite(time) && now - time <= config.repeatedBlockWindowMs)
      : [];
    const repeated = recentBlocks.length > 0;
    const cooldown = {
      recentBlocks: recentBlocks.concat(now),
      lastBlockAt: now,
      until: now + (repeated ? config.repeatedBlockCooldownMs : config.cooldownMs),
      reason: repeated ? "repeated-block" : "block"
    };
    const previous = values[keys.killSwitch] || {};
    await chrome.storage.local.set({
      [keys.cooldown]: cooldown,
      [keys.killSwitch]: {
        triggerCount: Number.isInteger(previous.triggerCount) ? previous.triggerCount + 1 : 1,
        lastTriggeredAt: now
      }
    });
    return cooldown;
  }

  async function finishFailure(message) {
    const current = await getState();
    if (current.runId !== message.runId || !ACTIVE_STATES.has(current.state)) {
      return { ok: false, error: "The Indeed run is no longer active." };
    }
    const blocked = message.errorCode === "block_detected";
    const cooldown = blocked ? await applyBlockCooldown() : null;
    const text = String(message.message || "Indeed collection failed.");
    const ended = await finish(current, "ERROR", {
      lastError: text,
      terminalReason: message.errorCode || "collector_error",
      circuitBreaker: blocked,
      ...(cooldown ? { cooldownUntil: cooldown.until } : {})
    });
    await writeNotice(blocked
      ? `${text} Indeed collection is paused until ${new Date(cooldown.until).toLocaleString()}.`
      : text, "error");
    return { ok: true, state: ended.state };
  }

  async function startRun() {
    if (startInProgress) {
      throw new Error("An Indeed run is already starting.");
    }
    startInProgress = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") {
        throw new Error("Could not identify the active browser tab.");
      }
      const url = new URL(tab.url);
      if (!adapter.matchesUrl(url)) {
        throw new Error("Open an Indeed /jobs search page with a q= search term to start.");
      }
      const content = await ensureContentScript(tab.id);
      if (!content.ready) {
        throw new Error(content.error || "Open an Indeed search page with #mosaic-provider-jobcards to start.");
      }

      const active = (await getAllSiteRuns()).find((run) => ACTIVE_STATES.has(run.state) || run.resultsOpening);
      if (active) {
        throw new Error(activeRunMessage(active));
      }
      const cooldownValues = await chrome.storage.local.get(keys.cooldown);
      const cooldown = cooldownValues[keys.cooldown] || {};
      if (Number.isFinite(cooldown.until) && cooldown.until > Date.now()) {
        throw new Error(`Indeed is cooling down until ${new Date(cooldown.until).toLocaleString()}.`);
      }
      const budget = await readBudget();
      if (budget.jobsToday >= config.maxJobsPerDay) {
        throw new Error(`Daily Indeed job limit reached (${budget.jobsToday}/${config.maxJobsPerDay}).`);
      }
      if (budget.runsToday >= config.maxRunsPerDay) {
        throw new Error(`Daily Indeed run limit reached (${budget.runsToday}/${config.maxRunsPerDay}).`);
      }

      const current = await getState();
      if (ACTIVE_STATES.has(current.state) || current.resultsOpening) {
        throw new Error("An Indeed collector run is already active.");
      }
      const runId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      const running = transition(current, "RUNNING", {
        runId,
        siteId,
        tabId: tab.id,
        pageNumber: 1,
        currentPage: 1,
        searchUrl: canonicalSearchUrl(url),
        capturedCount: 0,
        capturedJobIds: [],
        skippedAppliedCount: 0,
        skippedExpiredCount: 0,
        skippedJobIds: [],
        startedAt,
        lastActionAt: startedAt,
        lastError: null,
        terminalReason: null,
        resultsOpened: false,
        resultsOpening: false,
        navigationPending: false,
        circuitBreaker: false
      });
      await chrome.storage.local.set({
        [keys.runState]: running,
        [keys.budget]: {
          ...budget,
          runsToday: budget.runsToday + 1,
          lastRunAt: startedAt
        },
        [keys.progress]: {
          runId,
          pageNumber: 1,
          currentPage: 1,
          searchUrl: canonicalSearchUrl(url),
          capturedCount: 0,
          updatedAt: startedAt
        }
      });
      await writeNotice("Collecting Indeed job results.", "info");
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: "START_RUN",
          siteId,
          runId
        });
        if (!response || !response.ok) {
          throw new Error(response && response.error || "The Indeed content script did not acknowledge the run.");
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
      throw new Error("There is no active Indeed run to stop.");
    }
    const stopped = await finish(current, "STOPPED", {
      terminalReason: "user-stop",
      lastError: null
    });
    let acknowledged = true;
    if (Number.isInteger(current.tabId)) {
      try {
        await chrome.tabs.sendMessage(current.tabId, {
          type: "STOP_RUN",
          siteId,
          runId: current.runId
        });
      } catch (_error) {
        acknowledged = false;
      }
    }
    await writeNotice(
      acknowledged ? "Indeed run stopped." : "Indeed run stopped; the page did not acknowledge STOP.",
      acknowledged ? "info" : "error"
    );
    return { ok: true, state: stopped.state };
  }

  function sameSearch(leftValue, rightValue) {
    try {
      const left = new URL(leftValue);
      const right = new URL(rightValue);
      return adapter.matchesUrl(left)
        && adapter.matchesUrl(right)
        && left.pathname === right.pathname
        && left.searchParams.get("q") === right.searchParams.get("q");
    } catch (_error) {
      return false;
    }
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
        throw new Error("The capture is not associated with the active Indeed run.");
      }
      const capturedAt = new Date().toISOString();
      const record = adapter.normalize({ ...message.record, capturedAt });
      if (
        !/^[0-9a-f]{16}$/.test(record.jobId)
        || !Number.isInteger(record.pageNumber)
        || record.pageNumber < 1
        || record.pageNumber !== current.pageNumber
        || record.url !== `https://in.indeed.com/viewjob?jk=${record.jobId}`
      ) {
        throw new Error("The Indeed capture has invalid job, page, or URL data.");
      }
      const budget = await readBudget();
      const jobs = await global.JobCollectorStorage.getJobs(siteId);
      if (
        Object.prototype.hasOwnProperty.call(jobs, record.jobId)
        || budget.seenJobIds.includes(record.jobId)
        || current.capturedJobIds.includes(record.jobId)
      ) {
        const existingRecord = jobs[record.jobId];
        const hasFreshPostedData = record.sponsored === true
          || typeof record.postedText === "string"
          || (record.pubDate !== null && record.pubDate !== undefined);
        if (existingRecord && hasFreshPostedData) {
          const enrichedRecord = {
            ...existingRecord,
            postedText: record.postedText,
            postedType: record.postedType,
            pubDate: record.pubDate,
            firstSeenAt: existingRecord.firstSeenAt || record.firstSeenAt || record.capturedAt,
            postedApprox: record.postedApprox,
            postedDateEstimate: record.postedDateEstimate,
            sponsored: record.sponsored,
            parseWarning: record.parseWarning
          };
          await global.JobCollectorStorage.setJobs(siteId, {
            ...jobs,
            [record.jobId]: enrichedRecord
          });
        }
        return { ok: true, saved: false, capturedCount: current.capturedCount };
      }
      if (
        current.capturedCount >= config.maxJobsPerRun
        || budget.jobsToday >= config.maxJobsPerDay
      ) {
        const limitReason = budget.jobsToday >= config.maxJobsPerDay ? "day" : "run";
        return {
          ok: true,
          saved: false,
          limitReached: true,
          limitReason,
          capturedCount: current.capturedCount
        };
      }

      const savedRecord = record;
      const nextJobs = { ...jobs, [record.jobId]: savedRecord };
      const nextState = transition(current, current.state, {
        capturedCount: current.capturedCount + 1,
        capturedJobIds: current.capturedJobIds.concat(record.jobId),
        currentPage: record.pageNumber,
        pageNumber: record.pageNumber,
        lastActionAt: capturedAt
      });
      const nextBudget = {
        ...budget,
        jobsToday: budget.jobsToday + 1,
        seenJobIds: budget.seenJobIds.concat(record.jobId)
      };
      await global.JobCollectorStorage.setJobs(siteId, nextJobs, {
        [keys.budget]: nextBudget,
        [keys.runState]: nextState
      });
      return {
        ok: true,
        saved: true,
        capturedCount: nextState.capturedCount,
        limitReached: nextState.capturedCount >= config.maxJobsPerRun
          || nextBudget.jobsToday >= config.maxJobsPerDay,
        limitReason: nextBudget.jobsToday >= config.maxJobsPerDay
          ? "day"
          : nextState.capturedCount >= config.maxJobsPerRun
            ? "run"
            : null
      };
    });
    captureQueue = operation.catch(() => {});
    return operation;
  }

  async function skipCapture(message, sender) {
    const operation = captureQueue.then(async () => {
      const current = await getState();
      const jobId = String(message.jobId || "");
      if (
        current.siteId !== siteId
        || !ACTIVE_STATES.has(current.state)
        || current.runId !== message.runId
        || !sender.tab
        || sender.tab.id !== current.tabId
        || !/^[0-9a-f]{16}$/.test(jobId)
        || (message.applied !== true && message.expired !== true)
      ) {
        throw new Error("The skipped Indeed job does not match the active run or skip criteria.");
      }
      const skippedJobIds = Array.isArray(current.skippedJobIds) ? current.skippedJobIds : [];
      if (skippedJobIds.includes(jobId)) {
        return {
          ok: true,
          skippedAppliedCount: current.skippedAppliedCount || 0,
          skippedExpiredCount: current.skippedExpiredCount || 0
        };
      }
      const updated = transition(current, current.state, {
        skippedAppliedCount: (Number(current.skippedAppliedCount) || 0) + Number(message.applied === true),
        skippedExpiredCount: (Number(current.skippedExpiredCount) || 0) + Number(message.expired === true),
        skippedJobIds: skippedJobIds.concat(jobId),
        lastActionAt: new Date().toISOString()
      });
      await chrome.storage.local.set({ [keys.runState]: updated });
      return {
        ok: true,
        skippedAppliedCount: updated.skippedAppliedCount,
        skippedExpiredCount: updated.skippedExpiredCount
      };
    });
    captureQueue = operation.catch(() => {});
    return operation;
  }

  async function prepareNavigation(message, sender) {
    const current = await getState();
    if (
      current.runId !== message.runId
      || !ACTIVE_STATES.has(current.state)
      || !sender.tab
      || sender.tab.id !== current.tabId
      || !Number.isInteger(message.pageNumber)
      || message.pageNumber !== current.pageNumber + 1
      || message.pageNumber > config.maxPages
      || !sameSearch(current.searchUrl, message.searchUrl)
    ) {
      throw new Error("The Indeed pagination action does not match the active run.");
    }
    const now = new Date().toISOString();
    const updated = transition(current, "RUNNING", {
      pageNumber: message.pageNumber,
      currentPage: message.pageNumber,
      lastActionAt: now,
      navigationPending: true
    });
    await chrome.storage.local.set({ [keys.runState]: updated });
    await chrome.alarms.create(NAVIGATION_ALARM_PREFIX + current.runId, {
      when: Date.now() + config.navigationTimeoutMs
    });
    return { ok: true };
  }

  async function resumeCheck(message, sender) {
    const current = await getState();
    if (
      !current.navigationPending
      || current.state !== "RUNNING"
      || !sender.tab
      || sender.tab.id !== current.tabId
    ) {
      return { ok: true, resume: false };
    }
    if (!sameSearch(current.searchUrl, message.href)) {
      const url = (() => {
        try { return new URL(message.href); } catch (_error) { return null; }
      })();
      const blocked = url && adapter.detectBlock(null, url);
      return finishFailure({
        runId: current.runId,
        errorCode: blocked ? "block_detected" : "page_load_failed",
        message: blocked || "Indeed pagination loaded a page outside the saved search."
      }).then((result) => ({ ...result, resume: false }));
    }
    const url = new URL(message.href);
    const pageNumber = adapter.getCurrentPage(null, url);
    if (pageNumber !== current.pageNumber) {
      await finishFailure({
        runId: current.runId,
        errorCode: "page_load_failed",
        message: "Indeed loaded a page that does not match the saved pagination state."
      });
      return { ok: true, resume: false };
    }
    const resumed = transition(current, "RUNNING", {
      navigationPending: false,
      lastActionAt: new Date().toISOString()
    });
    await chrome.storage.local.set({ [keys.runState]: resumed });
    await chrome.alarms.clear(NAVIGATION_ALARM_PREFIX + current.runId);
    return { ok: true, resume: true, runState: resumed };
  }

  async function handleMessage(message, sender) {
    if (!sender || sender.id !== chrome.runtime.id) {
      throw new Error("Messages from unknown extensions are not accepted.");
    }
    if (!message || message.siteId !== siteId) {
      throw new Error("The message site does not match the Indeed adapter.");
    }
    await initialize();
    switch (message.type) {
      case "START_RUN":
        return runGuard.withStartLock(startRun);
      case "STOP_RUN":
        return stopRun();
      case "SAVE_CAPTURE":
        return saveCapture(message, sender);
      case "INDEED_PAGE_DIAGNOSTICS":
        return savePageDiagnostics(message, sender);
      case "INDEED_SKIP_CAPTURE":
        return skipCapture(message, sender);
      case "INDEED_PREPARE_NAVIGATION":
        return prepareNavigation(message, sender);
      case "INDEED_RESUME_CHECK":
        return resumeCheck(message, sender);
      case "INDEED_PROGRESS": {
        const current = await getState();
        if (
          current.runId !== message.runId
          || !ACTIVE_STATES.has(current.state)
          || !sender.tab
          || sender.tab.id !== current.tabId
          || !Number.isInteger(message.pageNumber)
          || message.pageNumber < 1
          || message.pageNumber > config.maxPages
          || !["RUNNING", "PAGINATING"].includes(message.phase)
        ) {
          throw new Error("Indeed progress does not match the active tab and run.");
        }
        const updated = transition(current, message.phase, {
          pageNumber: message.pageNumber,
          currentPage: message.pageNumber,
          lastActionAt: new Date().toISOString()
        });
        await chrome.storage.local.set({
          [keys.runState]: updated,
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
      case "INDEED_RUN_FINISHED": {
        const current = await getState();
        if (
          current.runId !== message.runId
          || !ACTIVE_STATES.has(current.state)
          || !sender.tab
          || sender.tab.id !== current.tabId
          || !Number.isInteger(message.pageNumber)
          || message.pageNumber < 1
          || message.pageNumber > config.maxPages
          || message.pageNumber !== current.pageNumber
        ) {
          throw new Error("The Indeed run is no longer active.");
        }
        const ended = await finish(current, "DONE", {
          pageNumber: message.pageNumber,
          currentPage: message.pageNumber,
          terminalReason: "complete",
          lastError: null,
          lastActionAt: new Date().toISOString()
        });
        await writeNotice(message.message || "Indeed results collected.", "success");
        return { ok: true, state: ended.state };
      }
      case "INDEED_RUN_FAILED": {
        const current = await getState();
        if (
          current.runId !== message.runId
          || !ACTIVE_STATES.has(current.state)
          || !sender.tab
          || sender.tab.id !== current.tabId
        ) {
          throw new Error("The Indeed failure does not match the active tab and run.");
        }
        return finishFailure(message);
      }
      default:
        throw new Error(`Unsupported Indeed message type: ${message.type}`);
    }
  }

  async function resumePendingNavigation(tabId, urlValue) {
    const current = await getState();
    if (
      !current.navigationPending
      || current.state !== "RUNNING"
      || current.tabId !== tabId
    ) {
      return;
    }
    let url;
    try {
      url = new URL(urlValue);
    } catch (_error) {
      return;
    }
    const blocked = adapter.detectBlock(null, url);
    if (blocked || !adapter.matchesUrl(url)) {
      await finishFailure({
        runId: current.runId,
        errorCode: blocked ? "block_detected" : "page_load_failed",
        message: blocked || "Indeed pagination left the saved /jobs search route."
      });
      return;
    }
    await ensureContentScript(tabId);
    const resumed = await chrome.tabs.sendMessage(tabId, {
      type: "INDEED_RESUME_RUN",
      siteId
    });
    if (!resumed || !resumed.ok) {
      throw new Error(resumed && resumed.error || "The Indeed page did not resume the pending run.");
    }
  }

  async function handleTabUrlChange(tabId, urlValue) {
    const current = await getState();
    if (!ACTIVE_STATES.has(current.state) || current.tabId !== tabId || typeof urlValue !== "string") {
      return;
    }
    let url;
    try {
      url = new URL(urlValue);
    } catch (_error) {
      await finishFailure({
        runId: current.runId,
        errorCode: "page_load_failed",
        message: "Indeed navigated to an invalid page URL."
      });
      return;
    }
    if (adapter.matchesUrl(url) && current.navigationPending) {
      return;
    }
    if (current.navigationPending || !adapter.matchesUrl(url)) {
      const blocked = adapter.detectBlock(null, url);
      await finishFailure({
        runId: current.runId,
        errorCode: blocked ? "block_detected" : "page_load_failed",
        message: blocked || "The Indeed page left the active /jobs search route."
      });
    }
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(NAVIGATION_ALARM_PREFIX)) {
      return;
    }
    void (async () => {
      const current = await getState();
      if (
        current.runId
        && alarm.name === NAVIGATION_ALARM_PREFIX + current.runId
        && current.state === "RUNNING"
        && current.navigationPending
      ) {
        await finishFailure({
          runId: current.runId,
          errorCode: "page_load_failed",
          message: "Indeed pagination did not load a new page within 45 seconds."
        });
      }
    })().catch((error) => console.error("[Indeed Jobs Collector] Navigation timeout handler failed", error));
  });

  global.JobCollectorIndeedBackground = Object.freeze({
    handleMessage,
    initialize,
    resumePendingNavigation,
    handleTabUrlChange,
    async stopForTabClosed(tabId) {
      const current = await getState();
      if (current.tabId !== tabId || !ACTIVE_STATES.has(current.state)) {
        return;
      }
      await finish(current, "STOPPED", {
        terminalReason: "tab_closed",
        lastError: null
      });
      await writeNotice("Indeed collection stopped because its tab was closed.", "error");
    },
    async recoverStaleRun() {
      const current = await getState();
      if (!ACTIVE_STATES.has(current.state)) {
        return;
      }
      const tabs = await chrome.tabs.query({});
      if (Number.isInteger(current.tabId) && !tabs.some((tab) => tab.id === current.tabId)) {
        await finish(current, "STOPPED", { terminalReason: "tab_closed", lastError: null });
        await writeNotice("Indeed collection stopped because its tab was closed.", "error");
        return;
      }
      if (current.navigationPending) {
        const navigationStartedAt = Date.parse(current.lastActionAt || current.updatedAt || "");
        if (
          Number.isFinite(navigationStartedAt)
          && Date.now() - navigationStartedAt <= config.navigationTimeoutMs
        ) {
          return;
        }
        await finishFailure({
          runId: current.runId,
          errorCode: "page_load_failed",
          message: "Indeed pagination did not load a new page within 45 seconds."
        });
        return;
      }
      const lastAction = Date.parse(current.lastActionAt || current.updatedAt || "");
      if (Number.isFinite(lastAction) && Date.now() - lastAction <= 15 * 60 * 1000) {
        return;
      }
      await finish(current, "ERROR", {
        terminalReason: "stale",
        lastError: "Indeed collection stopped because its saved run was stale."
      });
      await writeNotice("Indeed collection stopped because its saved run was stale.", "error");
    }
  });
})(globalThis);
