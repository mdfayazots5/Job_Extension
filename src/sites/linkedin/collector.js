"use strict";

(() => {
  if (globalThis.JobCollectorContentInstalled) {
    return;
  }
  globalThis.JobCollectorContentInstalled = true;

  const selectors = globalThis.JobCollectorSelectors;
  const adapter = globalThis.JobCollectorSiteRegistry.getAdapter("linkedin");
  const storage = globalThis.JobCollectorStorage;
  const STORAGE_KEYS = storage.keysForSite(adapter.id);
  const config = globalThis.JobCollectorConfig;
  const activeWaiters = new Set();
  let activeRunId = null;
  let activeSearchUrl = null;
  let stopRequested = false;
  let activeWatchdog = null;
  let hiddenTimeoutTimer = null;
  let pausePromise = null;
  let visibilityWake = null;
  let hiddenSince = null;
  let responseObserver = null;
  let blockingObserver = null;
  let unhandledExceptionCount = 0;
  let circuitTriggered = false;
  let activePageNumber = 1;
  let activeRunSavedCount = 0;
  let detailPaneLoadInFlight = false;
  let diagnosticsWriteQueue = Promise.resolve();

  /**
   * @typedef {Object} JobRecord
   * @property {string} jobId
   * @property {string} title
   * @property {string} company
   * @property {string|null} companyLogoUrl
   * @property {string} location
   * @property {string} url
   * @property {"Easy Apply"|"Company Site"|"Unknown"} applyType
   * @property {string|null} companyApplyUrl
   * @property {"actively-reviewing"|"not-indicated"} applicantReviewStatus
   * @property {"Posted"|"Reposted"|"Unknown"} postedType
   * @property {string} postedText
   * @property {string|null} postedDateEstimate
   * @property {number} pageNumber
   * @property {string} capturedAt
   */

  class RunStoppedError extends Error {
    constructor() {
      super("The collector run was stopped.");
      this.name = "RunStoppedError";
    }
  }

  class BlockingPageError extends Error {
    constructor(message) {
      super(message);
      this.name = "BlockingPageError";
    }
  }

  class JobLimitError extends Error {
    constructor(message = `The configured maximum of ${config.maxJobsPerRun} jobs has been reached.`) {
      super(message);
      this.name = "JobLimitError";
    }
  }

  class CircuitBreakerError extends Error {
    constructor(message) {
      super(message);
      this.name = "CircuitBreakerError";
    }
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function debugLog(...values) {
    if (config.debug) {
      console.log("[LinkedIn Jobs Collector]", ...values);
    }
  }

  function writeDiagnostic(runId, event, details = {}) {
    const write = diagnosticsWriteQueue.then(async () => {
      const response = await chrome.runtime.sendMessage({
        type: "DIAGNOSTIC_EVENT",
        siteId: adapter.id,
        runId,
        event,
        details
      });
      if (!response || !response.ok) {
        throw new Error(response && response.error
          ? response.error
          : "The service worker did not acknowledge the diagnostic event.");
      }
    });
    diagnosticsWriteQueue = write.catch((error) => {
      debugLog("Could not save collector diagnostic", errorMessage(error));
    });
    return write;
  }

  function makeStopError() {
    return new RunStoppedError();
  }

  function normalizeSearchUrl(value) {
    return adapter.normalizeUrl(value);
  }

  async function awaitWithStop(runId, promise) {
    const result = await promise;
    if (stopRequested || activeRunId !== runId) {
      throw makeStopError();
    }

    const values = await chrome.storage.local.get(STORAGE_KEYS.runState);
    const state = values[STORAGE_KEYS.runState];
    if (
      stopRequested
      || activeRunId !== runId
      || !state
      || state.runId !== runId
      || !["RUNNING", "PAGINATING", "PAUSED"].includes(state.state)
    ) {
      stopRequested = true;
      haltRunMonitoring();
      throw makeStopError();
    }
    return result;
  }

  async function readStoredJobs() {
    const records = await storage.getJobs(adapter.id);
    for (const [jobId, record] of Object.entries(records)) {
      if (!record || typeof record !== "object" || record.jobId !== jobId) {
        throw new Error(`Stored job record for ${jobId} is invalid.`);
      }
    }
    return records;
  }

  function getStats(jobsById) {
    const records = Object.values(jobsById);
    if (records.some((record) => !record || typeof record !== "object")) {
      throw new Error("Stored jobs contain an invalid record.");
    }
    return {
      capturedCount: records.length,
      easyApplyCount: records.filter((record) => record.applyType === "Easy Apply").length,
      companySiteCount: records.filter((record) => record.applyType === "Company Site").length
    };
  }

  async function writeProgress(runId, pageNumber, stats, details) {
    const progress = {
      runId,
      pageNumber,
      currentPage: pageNumber,
      searchUrl: activeSearchUrl,
      ...stats,
      updatedAt: new Date().toISOString(),
      ...(details || {})
    };
    await awaitWithStop(
      runId,
      chrome.storage.local.set({ [STORAGE_KEYS.progress]: progress })
    );
    armWatchdog(runId, pageNumber);
  }

  async function writeTerminalProgress(
    runId,
    pageNumber,
    stats,
    terminalState,
    message,
    details = {}
  ) {
    const values = await chrome.storage.local.get(STORAGE_KEYS.runState);
    const state = values[STORAGE_KEYS.runState];
    if (
      !state
      || state.runId !== runId
      || !["RUNNING", "PAGINATING", "PAUSED"].includes(state.state)
    ) {
      return;
    }

    await chrome.storage.local.set({
      [STORAGE_KEYS.progress]: {
        runId,
        pageNumber,
        currentPage: pageNumber,
        searchUrl: activeSearchUrl,
        ...stats,
        terminalState,
        ...details,
        ...(terminalState === "ERROR" ? { abortReason: message, lastError: message } : {}),
        ...(message ? { message } : {}),
        updatedAt: new Date().toISOString()
      }
    });
    if (activeWatchdog !== null) {
      clearTimeout(activeWatchdog);
      activeWatchdog = null;
    }
  }

  function wakeWaiters() {
    for (const wake of Array.from(activeWaiters)) {
      wake();
    }
    if (visibilityWake) {
      visibilityWake();
      visibilityWake = null;
    }
  }

  function haltRunMonitoring() {
    if (activeWatchdog !== null) {
      clearTimeout(activeWatchdog);
      activeWatchdog = null;
    }
    if (hiddenTimeoutTimer !== null) {
      clearTimeout(hiddenTimeoutTimer);
      hiddenTimeoutTimer = null;
    }
    if (responseObserver) {
      responseObserver.disconnect();
      responseObserver = null;
    }
    if (blockingObserver) {
      blockingObserver.disconnect();
      blockingObserver = null;
    }
  }

  function isPageVisible() {
    return document.visibilityState === "visible";
  }

  function waitForVisibilityChange(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        activeWaiters.delete(stopWake);
        if (visibilityWake === changeWake) {
          visibilityWake = null;
        }
        resolve(result);
      };
      const changeWake = () => finish("changed");
      const stopWake = () => finish("stopped");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      visibilityWake = changeWake;
      activeWaiters.add(stopWake);
    });
  }

  function beginVisibilityPause(runId) {
    if (hiddenSince !== null) {
      return pausePromise || Promise.resolve();
    }
    hiddenSince = Date.now();
    if (activeWatchdog !== null) {
      clearTimeout(activeWatchdog);
      activeWatchdog = null;
    }
    pausePromise = chrome.runtime.sendMessage({
      type: "PAUSE_RUN",
      siteId: adapter.id,
      runId
    }).then(() => {
      return writeDiagnostic(runId, "run-paused", { reason: "tab-hidden-or-unfocused" });
    });
    hiddenTimeoutTimer = setTimeout(() => {
      if (activeRunId !== runId || hiddenSince === null || stopRequested) {
        return;
      }
      stopRequested = true;
      wakeWaiters();
      haltRunMonitoring();
      void chrome.runtime.sendMessage({
        type: "VISIBILITY_TIMEOUT",
        siteId: adapter.id,
        runId
      });
    }, config.maxHiddenMs);
    return pausePromise;
  }

  async function ensureVisible(runId) {
    while (!isPageVisible()) {
      if (stopRequested || activeRunId !== runId) {
        throw makeStopError();
      }
      await beginVisibilityPause(runId);
      const elapsed = Date.now() - hiddenSince;
      const remaining = Math.max(0, config.maxHiddenMs - elapsed);
      const result = await waitForVisibilityChange(remaining);
      if (result === "timeout") {
        stopRequested = true;
        wakeWaiters();
        haltRunMonitoring();
        await chrome.runtime.sendMessage({
          type: "VISIBILITY_TIMEOUT",
          siteId: adapter.id,
          runId
        });
        throw makeStopError();
      }
    }
    if (hiddenSince !== null) {
      hiddenSince = null;
      if (hiddenTimeoutTimer !== null) {
        clearTimeout(hiddenTimeoutTimer);
        hiddenTimeoutTimer = null;
      }
      pausePromise = null;
      const response = await chrome.runtime.sendMessage({
        type: "RESUME_RUN",
        siteId: adapter.id,
        runId
      });
      if (!response || !response.ok) {
        throw makeStopError();
      }
      armWatchdog(runId, activePageNumber);
      await writeDiagnostic(runId, "run-resumed", { reason: "tab-visible-and-focused" });
    }
  }

  function armWatchdog(runId, pageNumber) {
    if (activeWatchdog !== null) {
      clearTimeout(activeWatchdog);
    }
    activeWatchdog = setTimeout(() => {
      if (activeRunId !== runId || stopRequested) {
        return;
      }
      stopRequested = true;
      wakeWaiters();
      haltRunMonitoring();
      void readStoredJobs().then((jobs) => (
        writeTerminalProgress(
          runId,
          pageNumber,
          getStats(jobs),
          "STOPPED",
          `Collection stopped because it made no progress for ${Math.round(config.watchdogMs / 1000)} seconds.`,
          { terminalReason: "stalled" }
        )
      )).catch((error) => {
        debugLog("Could not stop stalled run", errorMessage(error));
      });
    }, config.watchdogMs);
  }

  function installResponseObserver(runId, pageNumber) {
    if (typeof PerformanceObserver !== "function") {
      return;
    }
    try {
      responseObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.responseStatus === 429 || entry.responseStatus === 999) {
            const reason = `LinkedIn returned HTTP ${entry.responseStatus}; collection paused for account safety.`;
            tripCircuitBreaker(runId, activePageNumber, reason);
            responseObserver.disconnect();
            responseObserver = null;
            return;
          }
        }
      });
      responseObserver.observe({ type: "navigation", buffered: true });
      responseObserver.observe({ type: "resource", buffered: true });
    } catch (error) {
      debugLog("Could not observe response status", errorMessage(error));
      if (responseObserver) {
        responseObserver.disconnect();
        responseObserver = null;
      }
    }
  }

  function tripCircuitBreaker(runId, pageNumber, reason) {
    if (circuitTriggered || activeRunId !== runId) {
      return;
    }
    circuitTriggered = true;
    stopRequested = true;
    wakeWaiters();
    haltRunMonitoring();
    void writeDiagnostic(runId, "circuit-breaker", {
      pageNumber,
      reason
    });
    void readStoredJobs().then((jobs) => writeTerminalProgress(
      runId,
      pageNumber,
      getStats(jobs),
      "ERROR",
      reason,
      { circuitBreaker: true }
    )).catch((error) => {
      debugLog("Could not persist circuit-breaker stop", errorMessage(error));
    });
  }

  function installBlockingObserver(runId, pageNumber) {
    try {
      blockingObserver = new MutationObserver(() => {
        const errors = [];
        const reason = adapter.detectBlock(document, window.location, errors);
        if (reason) {
          tripCircuitBreaker(runId, activePageNumber, reason);
        }
      });
      blockingObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });
    } catch (error) {
      debugLog("Could not observe blocking page markers", errorMessage(error));
      if (blockingObserver) {
        blockingObserver.disconnect();
        blockingObserver = null;
      }
    }
  }

  function handleUnhandledException(runId, pageNumber) {
    unhandledExceptionCount += 1;
    if (unhandledExceptionCount < 2 || circuitTriggered) {
      return;
    }
    tripCircuitBreaker(runId, pageNumber, "Run stopped after two unhandled exceptions.");
  }

  function checkBlockingPage(errors) {
    const reason = adapter.detectBlock(document, window.location, errors);
    if (reason) {
      throw new BlockingPageError(reason);
    }
    if (!/^\/jobs\/search-results(?:\/|$)/.test(window.location.pathname)) {
      throw new Error("The active page left the LinkedIn jobs search-results route.");
    }
  }

  function collectSelectorErrors(errors) {
    return errors.splice(0).map((error) => (
      `${error.step} failed for selector "${error.selector}": ${error.message}`
    ));
  }

  function notifyProgressErrors(runId, pageNumber, stats, errors) {
    const messages = collectSelectorErrors(errors);
    if (messages.length === 0) {
      return Promise.resolve();
    }

    const message = messages.join("; ");
    debugLog(message);
    return writeProgress(runId, pageNumber, stats, { lastError: message });
  }

  function randomDelay(range) {
    const min = Math.min(range.min, range.max);
    const max = Math.max(range.min, range.max);
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function scheduleVisibleTimeout(timeoutMs, callback) {
    let remaining = timeoutMs;
    let startedAt = null;
    let timer = null;
    let cancelled = false;
    const pause = () => {
      if (timer === null) {
        return;
      }
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
      startedAt = null;
    };
    const resume = () => {
      if (cancelled || timer !== null || !isPageVisible()) {
        return;
      }
      startedAt = Date.now();
      timer = setTimeout(() => {
        timer = null;
        cancelled = true;
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("focus", resume);
        window.removeEventListener("blur", pause);
        callback();
      }, remaining);
    };
    const onVisibilityChange = () => {
      if (isPageVisible()) {
        resume();
      } else {
        pause();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", resume);
    window.addEventListener("blur", pause);
    resume();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", resume);
      window.removeEventListener("blur", pause);
    };
  }

  function waitForStopAwareTimeout(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        activeWaiters.delete(stopWake);
        resolve(result);
      };
      const stopWake = () => finish("stopped");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      activeWaiters.add(stopWake);
    });
  }

  function createMutationWatcher(container, scanCards, errors) {
    let currentWaiter = null;
    const observer = new MutationObserver(() => {
      try {
        scanCards();
        if (currentWaiter) {
          currentWaiter();
          currentWaiter = null;
        }
      } catch (error) {
        errors.push({
          step: "observe rendered job cards",
          selector: selectors.SELECTORS.scrollContainer,
          message: errorMessage(error)
        });
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "data-job-id", "data-occludable-job-id"]
    });

    return {
      observer,
      waitForChange(timeoutMs) {
        return new Promise((resolve) => {
          let settled = false;
          const finish = (result) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            activeWaiters.delete(stopWake);
            if (currentWaiter === mutationWake) {
              currentWaiter = null;
            }
            resolve(result);
          };
          const mutationWake = () => finish("mutation");
          const stopWake = () => finish("stopped");
          const timer = setTimeout(() => finish("timeout"), timeoutMs);
          currentWaiter = mutationWake;
          activeWaiters.add(stopWake);
        });
      },
      disconnect() {
        observer.disconnect();
        if (currentWaiter) {
          currentWaiter();
          currentWaiter = null;
        }
      }
    };
  }

  function waitForDetailPane(jobId, timeoutMs, errors) {
    const findCurrentPane = () => {
      checkBlockingPage(errors);
      const pane = selectors.findDetailPaneForJob(document, jobId, errors);
      if (!pane) {
        return null;
      }
      const title = selectors.getDetailTitleLink(pane, jobId, errors);
      return title ? { pane, title } : null;
    };

    const current = findCurrentPane();
    if (current) {
      return Promise.resolve(current);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let observer;
      const finish = (error, result) => {
        if (settled) {
          return;
        }
        settled = true;
        cancelTimeout();
        activeWaiters.delete(stopWake);
        if (observer) {
          observer.disconnect();
        }
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };
      const inspect = () => {
        try {
          const match = findCurrentPane();
          if (match) {
            finish(null, match);
          }
        } catch (error) {
          finish(error);
        }
      };
      const stopWake = () => finish(makeStopError());
      const cancelTimeout = scheduleVisibleTimeout(timeoutMs, () => {
        finish(new Error(
          `Timed out waiting for detail selector "${selectors.SELECTORS.jobLinks}" to match job ${jobId} inside the company/apply pane.`
        ));
      });

      try {
        observer = new MutationObserver(inspect);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["href", "aria-label"]
        });
        activeWaiters.add(stopWake);
        inspect();
      } catch (error) {
        finish(error);
      }
    });
  }

  function findLiveCard(container, jobId, errors) {
    const candidates = selectors.getCandidateElements(container, errors);
    for (const candidate of candidates) {
      const job = selectors.getJobLinkForCard(candidate, errors);
      if (job && job.jobId === jobId) {
        return { card: candidate, link: job.link, jobId: job.jobId };
      }
    }
    return null;
  }

  function decodeCompanyApplyUrl(companyApplyLink) {
    const href = companyApplyLink.href || companyApplyLink.getAttribute("href");
    const safetyUrl = new URL(href, window.location.href);
    if (
      safetyUrl.origin !== "https://www.linkedin.com"
      || safetyUrl.pathname !== "/safety/go/"
    ) {
      throw new Error("Company apply link is not a LinkedIn safety/go redirect.");
    }

    const destination = safetyUrl.searchParams.get("url");
    if (!destination) {
      throw new Error("Company apply link is missing its encoded url parameter.");
    }

    const decodedUrl = new URL(destination);
    if (decodedUrl.protocol !== "https:" && decodedUrl.protocol !== "http:") {
      throw new Error("Company apply URL uses an unsupported protocol.");
    }
    return decodedUrl.href;
  }

  /** @returns {JobRecord} */
  function extractRecord(detailPane, titleLink, jobId, pageNumber, errors, resultCard) {
    const companyLink = selectors.getDetailCompanyLink(detailPane, errors);
    if (!companyLink) {
      throw new Error("The matching detail pane has no company link.");
    }

    const title = (titleLink.innerText || titleLink.textContent || "").trim();
    const company = (companyLink.innerText || companyLink.textContent || "").trim();
    if (!title) {
      throw new Error("The matching detail pane has an empty job title.");
    }
    if (!company) {
      throw new Error("The matching detail pane has an empty company name.");
    }

    const capturedAt = new Date().toISOString();
    const meta = adapter.normalizeMetadata(
      detailPane.innerText || detailPane.textContent || "",
      capturedAt,
      { company, title }
    );
    const applyControls = selectors.getDetailApplyControls(detailPane, errors);
    let applyType = "Unknown";
    let companyApplyUrl = null;
    if (applyControls.easyApply) {
      applyType = "Easy Apply";
    } else if (applyControls.companyApply) {
      applyType = "Company Site";
      try {
        companyApplyUrl = decodeCompanyApplyUrl(applyControls.companyApply);
      } catch (error) {
        errors.push({
          step: "decode company apply URL",
          selector: selectors.SELECTORS.companyApply,
          message: errorMessage(error)
        });
      }
    }
    if (applyType === "Unknown" && resultCard) {
      applyType = selectors.getListCardDetails(resultCard, errors).applyType;
    }

    return adapter.normalize({
      jobId,
      title,
      company,
      companyLogoUrl: selectors.getDetailCompanyLogoUrl(companyLink, errors),
      location: meta.location,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      applyType,
      companyApplyUrl,
      applicantReviewStatus: selectors.isActivelyReviewingApplicants(detailPane, errors)
        || selectors.isActivelyReviewingApplicants(resultCard, errors)
        ? "actively-reviewing"
        : "not-indicated",
      postedType: meta.postedType,
      postedText: meta.postedText,
      postedDateEstimate: meta.postedDateEstimate,
      pageNumber,
      capturedAt
    });
  }

  async function saveRecord(runId, record, pageNumber) {
    await ensureVisible(runId);
    const response = await awaitWithStop(
      runId,
      chrome.runtime.sendMessage({
        type: "SAVE_CAPTURE",
        siteId: adapter.id,
        runId,
        pageNumber,
        record
      })
    );
    if (!response || !response.ok) {
      if (response && response.limit) {
        const limit = response.limitReason === "daily"
          ? config.maxJobsPerDay
          : config.maxJobsPerRun;
        throw new JobLimitError(
          `The configured maximum of ${limit} jobs has been reached.`
        );
      }
      throw new Error(response && response.error
        ? response.error
        : `The service worker did not accept job ${record.jobId}.`);
    }
    if (response.limitReached) {
      stopRequested = true;
      wakeWaiters();
    } else if (response.saved) {
      activeRunSavedCount += 1;
      await writeProgress(runId, pageNumber, response.stats);
    }
    return {
      saved: response.saved === true,
      stats: response.stats
    };
  }

  function extractListRecord(card, jobId, pageNumber, errors) {
    const details = selectors.getListCardDetails(card, errors);
    if (!details.title || !details.company) {
      throw new Error(`List card ${jobId} did not contain a title and company.`);
    }
    const capturedAt = new Date().toISOString();
    const meta = adapter.normalizeMetadata(
      details.metaLine,
      capturedAt,
      { company: details.company, title: details.title }
    );
    return adapter.normalize({
      jobId,
      title: details.title,
      company: details.company,
      companyLogoUrl: details.companyLink
        ? selectors.getDetailCompanyLogoUrl(details.companyLink, errors)
        : null,
      location: meta.location,
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      applyType: details.applyType,
      companyApplyUrl: null,
      applicantReviewStatus: details.activelyReviewing
        ? "actively-reviewing"
        : "not-indicated",
      postedType: meta.postedType,
      postedText: meta.postedText,
      postedDateEstimate: meta.postedDateEstimate,
      pageNumber,
      capturedAt
    });
  }

  async function processCard(runId, entry, container, pageNumber, errors, seenStoredJobIds, skipTitles) {
    await ensureVisible(runId);
    checkBlockingPage(errors);
    const currentJob = entry.card.isConnected
      ? selectors.getJobLinkForCard(entry.card, errors)
      : null;
    const live = currentJob && currentJob.jobId === entry.jobId
      ? { card: entry.card, link: currentJob.link, jobId: currentJob.jobId }
      : findLiveCard(container, entry.jobId, errors);
    if (!live || live.jobId !== entry.jobId) {
      throw new Error(`Job card ${entry.jobId} is no longer present in the results list.`);
    }

    if (selectors.isJobAlreadyApplied(live.card, errors)) {
      await writeDiagnostic(runId, "job-already-applied", {
        jobId: entry.jobId,
        pageNumber,
        reason: "already-applied"
      });
      return {
        saved: false,
        stats: getStats(await awaitWithStop(runId, readStoredJobs()))
      };
    }

    const storedJobs = await awaitWithStop(runId, readStoredJobs());
    if (Object.prototype.hasOwnProperty.call(storedJobs, entry.jobId)) {
      seenStoredJobIds.add(entry.jobId);
      return { saved: false, stats: getStats(storedJobs) };
    }
    const listDetails = selectors.getListCardDetails(live.card, errors);
    if (adapter.shouldSkipRole({ title: listDetails.title }, skipTitles)) {
      await writeDiagnostic(runId, "job-skipped-role", {
        jobId: entry.jobId,
        pageNumber,
        title: listDetails.title
      });
      return { saved: false, stats: getStats(storedJobs) };
    }
    const budgetValues = await awaitWithStop(
      runId,
      chrome.storage.local.get(STORAGE_KEYS.budget)
    );
    const budget = budgetValues[STORAGE_KEYS.budget] || {};
    if (Array.isArray(budget.seenJobIds) && budget.seenJobIds.includes(entry.jobId)) {
      return { saved: false, stats: getStats(storedJobs) };
    }
    if (
      activeRunSavedCount >= config.maxJobsPerRun
      || budget.jobsToday >= config.maxJobsPerDay
    ) {
      throw new JobLimitError();
    }

    if (!config.clickCards) {
      const record = extractListRecord(live.card, entry.jobId, pageNumber, errors);
      if (adapter.shouldSkipRole(record, skipTitles)) {
        await writeDiagnostic(runId, "job-skipped-role", {
          jobId: entry.jobId,
          pageNumber,
          title: record.title
        });
        return { saved: false, stats: getStats(storedJobs) };
      }
      const saved = await saveRecord(runId, record, pageNumber);
      await writeDiagnostic(runId, saved.saved ? "job-captured" : "job-already-captured", {
        jobId: entry.jobId,
        pageNumber,
        applyType: record.applyType
      });
      return saved;
    }
    if (live.link) {
      const linkUrl = new URL(
        live.link.href || live.link.getAttribute("href"),
        window.location.href
      );
      if (linkUrl.origin !== window.location.origin) {
        throw new Error(`Job card ${entry.jobId} link is not on the current LinkedIn origin.`);
      }
    }
    const clickTarget = live.card.tagName === "A"
      ? selectors.getCardForJobLink(live.link)
      : live.card;
    if (!clickTarget || clickTarget.tagName === "A") {
      throw new Error(`Could not find a non-link card element for job ${entry.jobId}; navigation was prevented.`);
    }
    if (detailPaneLoadInFlight) {
      throw new CircuitBreakerError("A second detail-pane load was requested before the previous one finished.");
    }

    detailPaneLoadInFlight = true;
    try {
      if (stopRequested) {
        throw makeStopError();
      }
      await ensureVisible(runId);
      clickTarget.scrollIntoView({ block: "nearest" });
      checkBlockingPage(errors);
      const detailPromise = waitForDetailPane(entry.jobId, config.detailTimeoutMs, errors);
      if (stopRequested) {
        throw makeStopError();
      }
      await writeDiagnostic(runId, "job-card-click", {
        jobId: entry.jobId,
        pageNumber,
        target: selectors.describeElement(clickTarget, document, errors),
        resultsScrollContainer: selectors.describeElement(container, document, errors)
      });
      await ensureVisible(runId);
      if (stopRequested) {
        throw makeStopError();
      }
      clickTarget.click();
      const detail = await awaitWithStop(runId, detailPromise);
      checkBlockingPage(errors);
      await writeDiagnostic(runId, "detail-loaded", {
        jobId: entry.jobId,
        detailPane: selectors.describeElement(detail.pane, document, errors)
      });

      const record = extractRecord(
        detail.pane,
        detail.title,
        entry.jobId,
        pageNumber,
        errors,
        live.card
      );
      if (adapter.shouldSkipRole(record, skipTitles)) {
        await writeDiagnostic(runId, "job-skipped-role", {
          jobId: entry.jobId,
          pageNumber,
          title: record.title
        });
        return { saved: false, stats: getStats(await readStoredJobs()) };
      }
      const saved = await saveRecord(runId, record, pageNumber);
      await writeDiagnostic(runId, saved.saved ? "job-captured" : "job-already-captured", {
        jobId: entry.jobId,
        pageNumber,
        applyType: record.applyType
      });
      return saved;
    } finally {
      detailPaneLoadInFlight = false;
    }
  }

  async function collectPageWork(runId, pageNumber) {
    const skipTitleSettings = await awaitWithStop(
      runId,
      chrome.storage.local.get("linkedin:skipTitles")
    );
    const skipTitles = Array.isArray(skipTitleSettings["linkedin:skipTitles"])
      ? skipTitleSettings["linkedin:skipTitles"]
      : [];
    let stats = getStats(await awaitWithStop(runId, readStoredJobs()));
    const errors = [];
    const pending = [];
    const seenJobIds = new Set();
    const seenStoredJobIds = new Set();
    const processedJobIds = new Set();
    let observer = null;
    let container = null;
    let stallSteps = 0;
    let activeStepIds = null;
    let consecutiveLoadFailures = 0;

    function scanCards() {
      const candidates = selectors.getCandidateElements(container, errors);
      for (const card of candidates) {
        try {
          const job = selectors.getJobLinkForCard(card, errors);
          if (!job || seenJobIds.has(job.jobId)) {
            continue;
          }
          seenJobIds.add(job.jobId);
          if (activeStepIds) {
            activeStepIds.add(job.jobId);
          }
          pending.push({ jobId: job.jobId, card });
        } catch (error) {
          errors.push({
            step: "queue rendered job card",
            selector: selectors.SELECTORS.jobLinks,
            message: errorMessage(error)
          });
        }
      }
    }

    async function processPendingCards() {
      while (pending.length > 0) {
        await awaitWithStop(runId, Promise.resolve());
        await ensureVisible(runId);
        const entry = pending.shift();
        if (processedJobIds.has(entry.jobId)) {
          continue;
        }
        processedJobIds.add(entry.jobId);

        try {
          const result = await awaitWithStop(
            runId,
            processCard(runId, entry, container, pageNumber, errors, seenStoredJobIds, skipTitles)
          );
          stats = result.stats;
          consecutiveLoadFailures = 0;
          if (result.saved) {
            armWatchdog(runId, pageNumber);
          }
          await awaitWithStop(
            runId,
            notifyProgressErrors(runId, pageNumber, stats, errors)
          );
          if (result.saved) {
            await awaitWithStop(
              runId,
              waitForStopAwareTimeout(randomDelay(config.cardDelayMs))
            );
          }
        } catch (error) {
          if (
            error instanceof RunStoppedError
            || error instanceof BlockingPageError
            || error instanceof JobLimitError
            || error instanceof CircuitBreakerError
          ) {
            throw error;
          }
          consecutiveLoadFailures += 1;
          if (consecutiveLoadFailures >= config.circuitFailureLimit) {
            throw new CircuitBreakerError(
              `Two consecutive job detail loads failed. Last failure: ${errorMessage(error)}`
            );
          }

          const detail = `Job ${entry.jobId} failed: ${errorMessage(error)}`;
          await writeDiagnostic(runId, "job-error", {
            jobId: entry.jobId,
            pageNumber,
            message: errorMessage(error)
          });
          debugLog(detail);
          await awaitWithStop(
            runId,
            writeProgress(runId, pageNumber, stats, { lastError: detail })
          );
          await awaitWithStop(
            runId,
            notifyProgressErrors(runId, pageNumber, stats, errors)
          );
        }
      }
    }

    try {
      checkBlockingPage(errors);
      container = selectors.getScrollableContainer(
        document,
        errors
      );
      if (!container) {
        throw new Error(
          `Could not find a scrollable results container using selector "${selectors.SELECTORS.scrollContainer}".`
        );
      }

      await writeDiagnostic(runId, "page-start", {
        pageNumber,
        resultsScrollContainer: selectors.describeElement(container, document, errors),
        renderedJobIds: Array.from(getRenderedJobIds(container, errors))
      });
      observer = createMutationWatcher(container, scanCards, errors);
      scanCards();
      await awaitWithStop(
        runId,
        notifyProgressErrors(runId, pageNumber, stats, errors)
      );
      await awaitWithStop(runId, processPendingCards());

      while (stallSteps < config.stallLimit) {
        await awaitWithStop(runId, Promise.resolve());
        checkBlockingPage(errors);
        stats = getStats(await awaitWithStop(runId, readStoredJobs()));
        if (activeRunSavedCount >= config.maxJobsPerRun) {
          throw new JobLimitError();
        }

        await ensureVisible(runId);
        activeStepIds = new Set();
        const scrollAmount = Math.max(1, Math.floor(container.clientHeight * config.scrollStepRatio));
        const beforeScroll = selectors.describeElement(container, document, errors);
        container.scrollBy({ top: scrollAmount, behavior: "auto" });
        const scrollResult = await awaitWithStop(
          runId,
          observer.waitForChange(randomDelay(config.scrollDelayMs))
        );
        await ensureVisible(runId);
        scanCards();
        await writeDiagnostic(runId, "results-scroll-step", {
          pageNumber,
          container: selectors.describeElement(container, document, errors),
          beforeScrollTop: beforeScroll.scrollTop,
          requestedScrollAmount: scrollAmount,
          observerResult: scrollResult,
          newlyQueuedJobIds: Array.from(activeStepIds)
        });
        await awaitWithStop(
          runId,
          notifyProgressErrors(runId, pageNumber, stats, errors)
        );
        await awaitWithStop(runId, processPendingCards());
        const newIdsThisStep = activeStepIds.size;
        activeStepIds = null;
        stallSteps = newIdsThisStep > 0 ? 0 : stallSteps + 1;
      }

      await awaitWithStop(runId, processPendingCards());
      if (seenStoredJobIds.size > 0) {
        const response = await awaitWithStop(runId, chrome.runtime.sendMessage({
          type: "TOUCH_SEEN_JOBS",
          siteId: adapter.id,
          runId,
          jobIds: Array.from(seenStoredJobIds)
        }));
        if (!response || !response.ok) {
          throw new Error(response && response.error
            ? response.error
            : "The service worker did not update previously captured jobs.");
        }
      }
      return stats;
    } finally {
      if (observer) {
        observer.disconnect();
      }
    }
  }

  function getRenderedJobIds(container, errors) {
    const ids = new Set();
    for (const card of selectors.getCandidateElements(container, errors)) {
      const job = selectors.getJobLinkForCard(card, errors);
      if (job) {
        ids.add(job.jobId);
      }
    }
    return ids;
  }

  function getResultsContainer(previousContainer, errors) {
    if (previousContainer && previousContainer.isConnected) {
      return previousContainer;
    }
    return selectors.getScrollableContainer(document, errors);
  }

  function getFirstJobId(ids) {
    return ids.values().next().value || null;
  }

  function waitForListChange(previousContainer, baselineIds, timeoutMs, errors) {
    const baselineFirstJobId = getFirstJobId(baselineIds);
    let mutationObserved = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      let observer;
      const finish = (error, result) => {
        if (settled) {
          return;
        }
        settled = true;
        cancelTimeout();
        activeWaiters.delete(stopWake);
        if (observer) {
          observer.disconnect();
        }
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };
      const inspect = () => {
        try {
          checkBlockingPage(errors);
          const container = getResultsContainer(previousContainer, errors);
          if (!container) {
            return;
          }
          const currentIds = getRenderedJobIds(container, errors);
          const firstJobId = getFirstJobId(currentIds);
          const firstCardChanged = Boolean(
            firstJobId
            && baselineFirstJobId
            && firstJobId !== baselineFirstJobId
          );
          const newJobIdRendered = Array.from(currentIds).some((jobId) => (
            !baselineIds.has(jobId)
          ));
          if (firstCardChanged || (mutationObserved && newJobIdRendered)) {
            finish(null, {
              container,
              pageNumber: adapter.getCurrentPage(document, window.location, errors)
            });
          }
        } catch (error) {
          finish(error);
        }
      };
      const stopWake = () => finish(makeStopError());
      const cancelTimeout = scheduleVisibleTimeout(timeoutMs, () => {
        finish(new Error(
          `Timed out waiting for results-list selector "${selectors.SELECTORS.scrollContainer}" to change after pagination.`
        ));
      });

      try {
        observer = new MutationObserver(() => {
          mutationObserved = true;
          inspect();
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["href", "data-job-id", "data-occludable-job-id"]
        });
        activeWaiters.add(stopWake);
        inspect();
      } catch (error) {
        finish(error);
      }
    });
  }

  async function paginateToNextPage(runId, pageNumber, container) {
    const errors = [];
    const nextControl = adapter.getNextPageControl(document, pageNumber, errors);
    if (!nextControl) {
      return null;
    }

    const listContainer = getResultsContainer(container, errors);
    if (!listContainer) {
      throw new Error(
        `Could not find results list selector "${selectors.SELECTORS.scrollContainer}" before pagination.`
      );
    }
    const currentPage = adapter.getCurrentPage(document, window.location, errors);
    if (Number.isInteger(currentPage) && currentPage > pageNumber) {
      const currentContainer = selectors.getScrollableContainer(document, errors);
      if (!currentContainer) {
        throw new CircuitBreakerError("Pagination advanced but the results list did not load.");
      }
      return { pageNumber: currentPage, container: currentContainer };
    }
    if (Number.isInteger(currentPage) && currentPage !== pageNumber) {
      throw new CircuitBreakerError("Pagination state no longer matches the active page.");
    }
    const baselineIds = getRenderedJobIds(listContainer, errors);
    const stats = await readStats();
    await awaitWithStop(
      runId,
      notifyProgressErrors(runId, pageNumber, stats, errors)
    );

    await awaitWithStop(runId, Promise.resolve());
    await ensureVisible(runId);
    checkBlockingPage(errors);
    const pageBeforeClick = adapter.getCurrentPage(document, window.location, errors);
    if (Number.isInteger(pageBeforeClick) && pageBeforeClick > pageNumber) {
      const currentContainer = selectors.getScrollableContainer(document, errors);
      if (!currentContainer) {
        throw new CircuitBreakerError("Pagination advanced but the results list did not load.");
      }
      return { pageNumber: pageBeforeClick, container: currentContainer };
    }
    if (Number.isInteger(pageBeforeClick) && pageBeforeClick !== pageNumber) {
      throw new CircuitBreakerError("Pagination state no longer matches the active page.");
    }
    const currentControl = adapter.getNextPageControl(document, pageNumber, errors);
    if (!currentControl) {
      return null;
    }
    const listWait = waitForListChange(
      listContainer,
      baselineIds,
      config.paginationTimeoutMs,
      errors
    );
    if (stopRequested) {
      throw makeStopError();
    }
    await writeDiagnostic(runId, "pagination-click", {
      currentPage: pageNumber,
      targetPage: currentControl.pageNumber,
      control: selectors.describeElement(currentControl.button, document, errors),
      resultsScrollContainer: selectors.describeElement(listContainer, document, errors)
    });
    await ensureVisible(runId);
    checkBlockingPage(errors);
    if (stopRequested) {
      throw makeStopError();
    }
    currentControl.button.click();
    try {
      const changed = await awaitWithStop(runId, listWait);
      const changedPage = changed.pageNumber;
      await writeDiagnostic(runId, "pagination-changed", {
        currentPage: pageNumber,
        detectedPage: changedPage,
        resultsScrollContainer: selectors.describeElement(changed.container, document, errors)
      });
      return {
        pageNumber: Number.isInteger(changedPage) && changedPage > pageNumber
          ? changedPage
          : (currentControl.pageNumber || pageNumber + 1),
        container: changed.container
      };
    } catch (error) {
      if (error instanceof RunStoppedError) {
        throw error;
      }
      throw new CircuitBreakerError(
        `Pagination to page ${pageNumber + 1} failed to load.`
      );
    }
  }

  async function readStats() {
    return getStats(await readStoredJobs());
  }

  async function runPage(runId, savedState) {
    activeRunId = runId;
    activeSearchUrl = normalizeSearchUrl(
      typeof savedState.searchUrl === "string"
        ? savedState.searchUrl
        : window.location.href
    );
    stopRequested = false;
    unhandledExceptionCount = 0;
    circuitTriggered = false;
    hiddenSince = null;
    await writeDiagnostic(runId, "run-start", {
      route: window.location.pathname,
      pageNumber: adapter.getCurrentPage(document, window.location)
    });
    const savedPageNumber = Number.isInteger(savedState.pageNumber)
      ? savedState.pageNumber
      : savedState.currentPage;
    const livePageNumber = adapter.getCurrentPage(document, window.location);
    let pageNumber = Number.isInteger(livePageNumber) && livePageNumber > 0
      ? livePageNumber
      : (Number.isInteger(savedPageNumber) && savedPageNumber > 0 ? savedPageNumber : 1);
    let resumePagination = savedState.state === "PAGINATING"
      && (!Number.isInteger(livePageNumber) || livePageNumber <= savedPageNumber);
    let unhandledListener;
    let rejectionListener;
    activePageNumber = pageNumber;
    armWatchdog(runId, pageNumber);
    installResponseObserver(runId, pageNumber);
    installBlockingObserver(runId, pageNumber);
    unhandledListener = () => handleUnhandledException(runId, activePageNumber);
    rejectionListener = () => handleUnhandledException(runId, activePageNumber);
    window.addEventListener("error", unhandledListener);
    window.addEventListener("unhandledrejection", rejectionListener);

    try {
      const runContext = {
        runId,
        doc: document,
        url: new URL(window.location.href),
        pageNumber,
        resumePagination,
        ensureVisible: () => ensureVisible(runId),
        checkBlock: () => checkBlockingPage([]),
        readStats: () => awaitWithStop(runId, readStats()),
        getContainer: () => selectors.getScrollableContainer(document, []),
        collectPageWork,
        goNextLinkedInPage: paginateToNextPage,
        writeProgress: (currentPage, stats, phase) => awaitWithStop(
          runId,
          writeProgress(runId, currentPage, stats, { phase, lastError: null })
        ),
        finish: (currentPage, stats, message) => writeTerminalProgress(
          runId,
          currentPage,
          stats,
          "DONE",
          message
        ),
        setPage(currentPage) {
          pageNumber = currentPage;
          activePageNumber = currentPage;
        },
        setNextPage(nextPageNumber, container) {
          runContext.nextPageNumber = nextPageNumber;
          runContext.container = container;
        },
        onPage(currentPage) {
          armWatchdog(runId, currentPage);
        }
      };
      await globalThis.JobCollectorRunLoop.run(adapter, runContext);
    } catch (error) {
      if (error instanceof RunStoppedError) {
        const values = await chrome.storage.local.get(STORAGE_KEYS.runState);
        await writeDiagnostic(runId, "run-stopped", {
          pageNumber,
          reason: values[STORAGE_KEYS.runState]
            && (values[STORAGE_KEYS.runState].terminalReason || values[STORAGE_KEYS.runState].lastError)
            ? values[STORAGE_KEYS.runState].terminalReason || values[STORAGE_KEYS.runState].lastError
            : "stop-requested"
        });
        debugLog("Run stopped.");
        return;
      }

      if (error instanceof JobLimitError) {
        const jobs = await readStoredJobs();
        await writeTerminalProgress(
          runId,
          pageNumber,
          getStats(jobs),
          "DONE",
          errorMessage(error),
          { terminalReason: "limit" }
        );
        return;
      }

      let stats = { capturedCount: 0, easyApplyCount: 0, companySiteCount: 0 };
      try {
        stats = getStats(await readStoredJobs());
      } catch (storageError) {
        debugLog("Could not read stored job counts", errorMessage(storageError));
      }
      const failureMessage = errorMessage(error);
      await writeDiagnostic(runId, "run-error", {
        pageNumber,
        reason: error instanceof BlockingPageError
          ? failureMessage
          : (error instanceof CircuitBreakerError
            ? "consecutive-load-failures"
            : "collector-error"),
        route: window.location.pathname
      });
      debugLog("Page collection failed", failureMessage);
      await writeTerminalProgress(
        runId,
        pageNumber,
        stats,
        "ERROR",
        failureMessage,
        {
          circuitBreaker: error instanceof BlockingPageError
            || error instanceof CircuitBreakerError
            || circuitTriggered
        }
      ).catch((persistError) => {
        debugLog("Could not persist collector failure", errorMessage(persistError));
      });
    } finally {
      if (activeRunId === runId) {
        activeRunId = null;
      }
      if (activeWatchdog !== null) {
        clearTimeout(activeWatchdog);
        activeWatchdog = null;
      }
      if (hiddenTimeoutTimer !== null) {
        clearTimeout(hiddenTimeoutTimer);
        hiddenTimeoutTimer = null;
      }
      if (responseObserver) {
        responseObserver.disconnect();
        responseObserver = null;
      }
      if (blockingObserver) {
        blockingObserver.disconnect();
        blockingObserver = null;
      }
      window.removeEventListener("error", unhandledListener);
      window.removeEventListener("unhandledrejection", rejectionListener);
      activeSearchUrl = null;
      stopRequested = false;
    }
  }

  async function resumeSavedRun() {
    try {
      const values = await chrome.storage.local.get(STORAGE_KEYS.runState);
      const state = values[STORAGE_KEYS.runState];
      if (
        !state
        || typeof state.runId !== "string"
        || (state.state !== "RUNNING" && state.state !== "PAGINATING")
      ) {
        return;
      }
      const savedSearchUrl = typeof state.searchUrl === "string"
        ? normalizeSearchUrl(state.searchUrl)
        : normalizeSearchUrl(window.location.href);
      if (normalizeSearchUrl(window.location.href) !== savedSearchUrl) {
        return;
      }
      if (activeRunId) {
        return;
      }
      activeRunId = state.runId;
      void runPage(state.runId, state).catch(async (error) => {
        const message = `Could not resume saved run: ${errorMessage(error)}`;
        debugLog(message);
        if (activeRunId === state.runId) {
          activeRunId = null;
        }
        try {
          const jobs = await readStoredJobs();
          await writeTerminalProgress(
            state.runId,
            Number.isInteger(state.pageNumber) ? state.pageNumber : 1,
            getStats(jobs),
            "ERROR",
            message
          );
        } catch (persistError) {
          debugLog("Could not persist resume error", errorMessage(persistError));
        }
      });
    } catch (error) {
      debugLog("Could not resume saved run", errorMessage(error));
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEYS.runState] || !activeRunId) {
      return;
    }

    const state = changes[STORAGE_KEYS.runState].newValue;
    if (
      state
      && state.runId === activeRunId
      && state.state !== "RUNNING"
      && state.state !== "PAGINATING"
      && state.state !== "PAUSED"
    ) {
      stopRequested = true;
      wakeWaiters();
      haltRunMonitoring();
    }
  });

  const handleVisibilitySignal = () => {
    if (!isPageVisible() && activeRunId) {
      void beginVisibilityPause(activeRunId).catch((error) => {
        debugLog("Could not pause hidden run", errorMessage(error));
      });
    }
    if (isPageVisible() && hiddenTimeoutTimer !== null) {
      clearTimeout(hiddenTimeoutTimer);
      hiddenTimeoutTimer = null;
    }
    if (visibilityWake) {
      visibilityWake();
    }
  };
  document.addEventListener("visibilitychange", handleVisibilitySignal);
  window.addEventListener("focus", handleVisibilitySignal);
  window.addEventListener("blur", handleVisibilitySignal);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }
    if (message.type === "PING") {
      sendResponse({ ok: message.siteId === undefined || message.siteId === adapter.id });
      return false;
    }
    if (message.type === "STOP_RUN") {
      if (message.siteId === adapter.id && message.runId === activeRunId) {
        stopRequested = true;
        wakeWaiters();
        haltRunMonitoring();
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== "START_RUN") {
      return false;
    }

    const runId = message.runId;
    (async () => {
      try {
        if (typeof runId !== "string" || runId.length === 0) {
          throw new Error("START_RUN requires a run ID.");
        }
        if (message.siteId !== adapter.id) {
          throw new Error("START_RUN is for a different site.");
        }
        const values = await chrome.storage.local.get(STORAGE_KEYS.runState);
        const state = values[STORAGE_KEYS.runState];
        if (!state || state.state !== "RUNNING" || state.runId !== runId) {
          throw new Error("The run is not active in extension storage.");
        }
        if (activeRunId === runId) {
          sendResponse({ ok: true });
          return;
        }
        if (activeRunId) {
          throw new Error("A different content-script run is already active.");
        }
        activeRunId = runId;
        activeSearchUrl = normalizeSearchUrl(state.searchUrl || window.location.href);
        activeRunSavedCount = Number.isInteger(state.runCapturedCount)
          ? state.runCapturedCount
          : 0;
        stopRequested = false;
        const jobs = await awaitWithStop(runId, readStoredJobs());
        await awaitWithStop(runId, chrome.storage.local.set({
          [STORAGE_KEYS.progress]: {
            runId,
            currentPage: Number.isInteger(state.currentPage) ? state.currentPage : 1,
            ...getStats(jobs),
            updatedAt: new Date().toISOString()
          }
        }));
        sendResponse({ ok: true });
        void runPage(runId, state).catch(async (error) => {
          const message = `Collector stopped unexpectedly: ${errorMessage(error)}`;
          debugLog(message);
          try {
            const jobs = await readStoredJobs();
            await writeTerminalProgress(
              runId,
              Number.isInteger(state.currentPage) ? state.currentPage : 1,
              getStats(jobs),
              "ERROR",
              message
            );
          } catch (persistError) {
            debugLog("Could not persist unexpected collector failure", errorMessage(persistError));
          }
        });
      } catch (error) {
        if (activeRunId === runId) {
          activeRunId = null;
        }
        sendResponse({ ok: false, error: errorMessage(error) });
      }
    })();
    return true;
  });

  void resumeSavedRun();
})();
