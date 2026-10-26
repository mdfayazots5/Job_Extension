"use strict";

(() => {
  if (globalThis.JobCollectorNaukriContentInstalled) {
    return;
  }
  globalThis.JobCollectorNaukriContentInstalled = true;

  const adapter = globalThis.JobCollectorNaukriAdapter;
  const selectors = globalThis.JobCollectorNaukriSelectors;
  const config = globalThis.JobCollectorNaukriConfig;
  let activeRunId = null;
  let stopRequested = false;
  let navigationTimer = null;
  let navigationMonitor = null;
  let navigationRunId = null;
  let spaResumeInProgress = false;
  let resumeStarted = false;

  class NaukriBlockError extends Error {
    constructor(message) {
      super(message);
      this.name = "NaukriBlockError";
    }
  }

  class NaukriStopError extends Error {
    constructor() {
      super("The Naukri run was stopped.");
      this.name = "NaukriStopError";
    }
  }

  function randomDelay(range) {
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function clearNavigationWatch() {
    if (navigationTimer !== null) {
      clearTimeout(navigationTimer);
      navigationTimer = null;
    }
    if (navigationMonitor !== null) {
      clearInterval(navigationMonitor);
      navigationMonitor = null;
    }
    navigationRunId = null;
  }

  function debugLog(...values) {
    if (config.debug) {
      console.log("[Naukri Jobs Collector]", ...values);
    }
  }

  function currentUrl() {
    return new URL(window.location.href);
  }

  function hasResultsPage() {
    return adapter.matchesUrl(currentUrl()) && selectors.getJobCards(document).length > 0;
  }

  async function send(message) {
    const response = await chrome.runtime.sendMessage({
      ...message,
      siteId: adapter.id
    });
    if (!response || response.ok !== true) {
      throw new Error(response && response.error
        ? response.error
        : "The service worker did not acknowledge the Naukri request.");
    }
    return response;
  }

  async function logFlow(runId, event, details = {}) {
    try {
      const values = await chrome.storage.local.get("debug.naukri");
      if (values["debug.naukri"] !== true) {
        return;
      }
      await send({
        type: "NAUKRI_FLOW_LOG",
        runId,
        event,
        details: {
          ...details,
          urlPath: currentUrl().pathname,
          readyState: document.readyState,
          visibility: document.visibilityState
        }
      });
    } catch (error) {
      console.warn("[Naukri Jobs Collector] Could not persist flow log", event, error);
    }
  }

  async function checkRunning(runId) {
    if (stopRequested || activeRunId !== runId) {
      throw new NaukriStopError();
    }
    const values = await chrome.storage.local.get("runs.naukri");
    const state = values["runs.naukri"];
    if (
      !state
      || state.runId !== runId
      || state.siteId !== adapter.id
      || !["RUNNING", "PAGINATING"].includes(state.state)
    ) {
      stopRequested = true;
      throw new NaukriStopError();
    }
    return state;
  }

  async function waitUntilVisible(runId) {
    while (document.visibilityState !== "visible") {
      await checkRunning(runId);
      await wait(350 + Math.floor(Math.random() * 301));
    }
    await checkRunning(runId);
  }

  async function waitVisibleDelay(runId, milliseconds) {
    let remaining = milliseconds;
    while (remaining > 0) {
      await waitUntilVisible(runId);
      const duration = Math.min(250, remaining);
      const startedAt = Date.now();
      await wait(duration);
      if (document.visibilityState === "visible") {
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      }
      await checkRunning(runId);
    }
  }

  async function scrollResults(runId) {
    await waitUntilVisible(runId);
    const stepCount = randomDelay(config.scrollSteps);
    for (let step = 0; step < stepCount; step += 1) {
      await checkRunning(runId);
      await waitUntilVisible(runId);
      const upward = step > 0 && Math.random() < 0.22;
      const amount = upward
        ? -randomDelay(config.upwardScrollAmount)
        : randomDelay(config.scrollAmount);
      window.scrollBy({ top: amount, behavior: "smooth" });
      await waitVisibleDelay(runId, randomDelay(config.scrollDelayMs));
    }
  }

  async function checkPageBlock() {
    const block = adapter.detectBlock(document, currentUrl());
    if (block) {
      throw new NaukriBlockError(block);
    }
    if (!adapter.matchesUrl(currentUrl())) {
      throw new Error("The current page is not a Naukri jobs search-results page.");
    }
  }

  async function verifyCards(runId) {
    await checkPageBlock();
    if (selectors.getJobCards(document).length > 0) {
      return;
    }
    await wait(config.noResultsRecheckMs);
    await checkRunning(runId);
    await checkPageBlock();
    if (selectors.getJobCards(document).length === 0) {
      throw new Error("Naukri search page returned 0 job cards on two consecutive checks.");
    }
  }

  async function readStats(runId) {
    const state = await checkRunning(runId);
    return { capturedCount: Number(state.capturedCount) || 0 };
  }

  async function readApplicationDetails(runId, pageNumber, records) {
    const applicationDetails = {};
    const missingRecords = [];
    const recordsById = new Map(records.map((record) => [record.jobId, record]));
    for (const record of records) {
      if (adapter.ui.tabFor(record) !== "Unclassified") {
        applicationDetails[record.jobId] = {
          companyApplyJob: record.companyApplyJob,
          questionnaireIdPresent: record.questionnaireIdPresent,
          applyRedirectUrl: record.applyRedirectUrl
        };
      } else {
        missingRecords.push(record);
      }
    }
    const observedResponse = globalThis.JobCollectorNaukriApiResponses
      && globalThis.JobCollectorNaukriApiResponses[pageNumber];
    if (!observedResponse) {
      await logFlow(
        runId,
        missingRecords.length ? "application-api-unavailable" : "application-api-matched",
        {
          pageNumber,
          matchedCount: records.length - missingRecords.length,
          missingCount: missingRecords.length,
          source: "result-cards"
        }
      );
      return applicationDetails;
    }
    await logFlow(runId, "application-api-response", {
      pageNumber,
      status: observedResponse.status
    });
    if (observedResponse.status === 406) {
      if (!missingRecords.length) {
        await logFlow(runId, "application-api-matched", {
          pageNumber,
          matchedCount: records.length,
          source: "result-cards"
        });
        return applicationDetails;
      }
      throw new Error(
        "Naukri requires reCAPTCHA verification for its search results. " +
        "Complete the verification on the Naukri page, reload it, and start a new run."
      );
    }
    if (observedResponse.status < 200 || observedResponse.status >= 300) {
      throw new Error(
        `Naukri's page-loaded search request returned HTTP ${observedResponse.status} for page ${pageNumber}.`
      );
    }
    const apiDetails = adapter.parseApplicationDetails(observedResponse);
    for (const [jobId, details] of Object.entries(apiDetails)) {
      const card = recordsById.get(jobId);
      applicationDetails[jobId] = {
        companyApplyJob: typeof details.companyApplyJob === "boolean"
          ? details.companyApplyJob
          : card && card.companyApplyJob,
        questionnaireIdPresent: typeof details.questionnaireIdPresent === "boolean"
          ? details.questionnaireIdPresent
          : card && card.questionnaireIdPresent,
        applyRedirectUrl: details.applyRedirectUrl || (card && card.applyRedirectUrl) || null
      };
    }
    const missingIds = missingRecords
      .map((record) => record.jobId)
      .filter((jobId) => !Object.prototype.hasOwnProperty.call(applicationDetails, jobId));
    if (missingIds.length) {
      throw new Error(`Naukri search API did not return ${missingIds.length} visible job${missingIds.length === 1 ? "" : "s"} on page ${pageNumber}.`);
    }
    const unclassifiedCount = records.filter((record) => (
      adapter.ui.tabFor({ ...record, ...applicationDetails[record.jobId] }) === "Unclassified"
    )).length;
    await logFlow(runId, "application-api-matched", {
      pageNumber,
      matchedCount: records.length - unclassifiedCount,
      unclassifiedCount
    });
    return applicationDetails;
  }

  async function reportFailure(runId, error) {
    try {
      await send({
        type: "NAUKRI_RUN_FAILED",
        runId,
        errorCode: error instanceof NaukriBlockError ? "block_detected" : "collector_error",
        message: error instanceof Error ? error.message : String(error)
      });
    } catch (reportError) {
      debugLog("Could not persist Naukri failure", reportError);
    }
  }

  function markClickedJobOpened(event) {
    if (event.defaultPrevented) {
      return;
    }
    const clickedElement = event.target && event.target.nodeType === 1
      ? event.target
      : event.target && event.target.parentElement;
    if (!clickedElement || typeof clickedElement.closest !== "function") {
      return;
    }
    const link = clickedElement.closest("a");
    if (!link) {
      return;
    }
    const card = selectors.getJobCardForElement(document, link);
    if (!card || selectors.query(card, selectors.SELECTORS.title) !== link) {
      return;
    }
    const jobId = String(card.getAttribute("data-job-id") || "").trim();
    if (!/^\d+$/.test(jobId)) {
      return;
    }
    chrome.runtime.sendMessage({
      type: "SYNC_JOB_STATUSES",
      siteId: adapter.id,
      updates: [{ jobId, opened: true }]
    }).then((response) => {
      if (!response || response.ok !== true) {
        throw new Error(response && response.error
          ? response.error
          : "The service worker did not acknowledge the opened status.");
      }
    }).catch((error) => {
      console.warn("[Naukri Jobs Collector] Could not save opened status", error);
    });
  }

  async function runPage(runId, runState) {
    if (activeRunId && activeRunId !== runId) {
      return;
    }
    activeRunId = runId;
    stopRequested = false;
    const pageNumber = Number.isInteger(runState.pageNumber) && runState.pageNumber > 0
      ? runState.pageNumber
      : 1;
    const startPageNumber = Number.isInteger(runState.startPageNumber)
      && runState.startPageNumber > 0
      ? runState.startPageNumber
      : pageNumber;
    const pageUrl = currentUrl();
    await logFlow(runId, "page-run-start", {
      pageNumber,
      startPageNumber,
      pagesProcessed: Math.max(1, pageNumber - startPageNumber + 1),
      cardCount: selectors.getJobCards(document).length,
      navigationPending: Boolean(runState.navigationPending)
    });

    const context = {
      doc: document,
      url: pageUrl,
      runId,
      pageNumber,
      startPageNumber,
      logFlow: (event, details) => logFlow(runId, event, details),
      setPage() {},
      setNextPage() {},
      async ensureVisible() {
        await waitUntilVisible(runId);
      },
      async checkBlock() {
        await checkPageBlock();
      },
      async readStats() {
        return readStats(runId);
      },
      getContainer() {
        return null;
      },
      async collectPageWork(currentRunId, currentPage) {
        await verifyCards(currentRunId);
        await logFlow(currentRunId, "cards-found", {
          pageNumber: currentPage,
          cardCount: selectors.getJobCards(document).length
        });
        await scrollResults(currentRunId);
        await checkRunning(currentRunId);
        const parsed = adapter.parsePage({
          doc: document,
          capturedAt: new Date().toISOString(),
          onCardError(detail) {
            debugLog("Card parsing failed", detail.selector, detail.jobId, detail.message);
          }
        });
        const applicationDetails = await readApplicationDetails(
          currentRunId,
          currentPage,
          parsed
        );
        const skipTitleSettings = await chrome.storage.local.get("naukri:skipTitles");
        const skipTitles = Array.isArray(skipTitleSettings["naukri:skipTitles"])
          ? skipTitleSettings["naukri:skipTitles"]
          : [];
        const currentIds = new Set();
        for (const record of parsed) {
          await checkRunning(currentRunId);
          if (currentIds.has(record.jobId)) {
            continue;
          }
          currentIds.add(record.jobId);
          const details = applicationDetails[record.jobId] || {
            companyApplyJob: record.companyApplyJob,
            questionnaireIdPresent: record.questionnaireIdPresent,
            applyRedirectUrl: record.applyRedirectUrl
          };
          const normalized = adapter.normalize({
            ...record,
            companyApplyJob: details.companyApplyJob,
            questionnaireIdPresent: details.questionnaireIdPresent,
            applyRedirectUrl: details.applyRedirectUrl,
            pageNumber: currentPage
          });
          if (adapter.shouldSkipRole(normalized, skipTitles)) {
            await logFlow(currentRunId, "role-excluded", {
              pageNumber: currentPage,
              jobId: record.jobId,
              title: normalized.title
            });
            continue;
          }
          await send({
            type: "SAVE_CAPTURE",
            runId: currentRunId,
            siteId: adapter.id,
            record: normalized
          });
        }
        await logFlow(currentRunId, "page-captured", {
          pageNumber: currentPage,
          parsedCount: parsed.length,
          uniqueCount: currentIds.size,
          storedCount: (await readStats(currentRunId)).capturedCount
        });
        return readStats(currentRunId);
      },
      async beforeNextPage(currentPage) {
        const microPauseInterval = runState.microPauseEveryPages
          || config.microPauseEveryPages.min;
        if (currentPage % microPauseInterval === 0) {
          await waitVisibleDelay(runId, randomDelay(config.microPauseMs));
        }
        await waitVisibleDelay(runId, randomDelay(config.pageChangeDelayMs));
      },
      async prepareNavigation(nextPage) {
        await waitUntilVisible(runId);
        await logFlow(runId, "navigation-preparing", {
          pageNumber: adapter.getCurrentPage(document, currentUrl()),
          nextPage,
          hasNextPage: adapter.hasNextPage(document)
        });
        await send({
          type: "NAUKRI_PREPARE_NAVIGATION",
          runId,
          pageNumber: nextPage,
          searchUrl: pageUrl.href,
          lastActionAt: new Date().toISOString()
        });
        clearNavigationWatch();
        navigationRunId = runId;

        const startedUrl = currentUrl().href;
        const pageAdvancedEnough = () => {
          const currentPageNumber = adapter.getCurrentPage(document, currentUrl());
          return Number.isInteger(currentPageNumber) && currentPageNumber >= nextPage;
        };

        navigationMonitor = setInterval(() => {
          if (!pageAdvancedEnough()) {
            return;
          }
          if (!spaResumeInProgress && activeRunId !== runId) {
            spaResumeInProgress = true;
            clearNavigationWatch();
            void logFlow(runId, "same-document-page-advance", {
              expectedPage: nextPage,
              detectedPage: adapter.getCurrentPage(document, currentUrl()),
              urlChanged: currentUrl().href !== startedUrl
            }).then(() => resumeSavedRun({ force: true })).catch((error) => {
              debugLog("Could not resume Naukri after same-document pagination", error);
            }).finally(() => {
              spaResumeInProgress = false;
            });
          }
        }, 1000);

        navigationTimer = setTimeout(() => {
          if (!stopRequested && !pageAdvancedEnough()) {
            void logFlow(runId, "content-navigation-timeout", {
              expectedPage: nextPage,
              detectedPage: adapter.getCurrentPage(document, currentUrl()),
              startedUrlPath: new URL(startedUrl).pathname
            });
            clearNavigationWatch();
            void send({
              type: "NAUKRI_RUN_FAILED",
              runId,
              errorCode: "page_load_failed",
              message: "page_load_failed"
            }).catch((error) => debugLog("Could not report page-load timeout", error));
          }
        }, config.navigationTimeoutMs);

        const clearOnEvent = () => {
          clearNavigationWatch();
        };
        window.addEventListener("pagehide", clearOnEvent, { once: true });
        window.addEventListener("pageshow", clearOnEvent, { once: true });
        window.addEventListener("load", clearOnEvent, { once: true });
      },
      async writeProgress(currentPage, stats, phase) {
        await logFlow(runId, "progress", {
          pageNumber: currentPage,
          capturedCount: stats.capturedCount,
          phase
        });
        await send({
          type: "NAUKRI_PROGRESS",
          runId,
          pageNumber: currentPage,
          capturedCount: stats.capturedCount,
          phase
        });
      },
      async finish(currentPage, stats, message) {
        await logFlow(runId, "run-finished", {
          pageNumber: currentPage,
          capturedCount: stats.capturedCount,
          message
        });
        await send({
          type: "NAUKRI_RUN_FINISHED",
          runId,
          state: "DONE",
          pageNumber: currentPage,
          capturedCount: stats.capturedCount,
          message
        });
      },
      async onPage() {}
    };

    let navigationPending = false;
    try {
      const result = await globalThis.JobCollectorRunLoop.run(adapter, context);
      navigationPending = result.navigation === "navigated";
    } catch (error) {
      if (!(error instanceof NaukriStopError)) {
        await reportFailure(runId, error);
      }
    } finally {
      if (!navigationPending) {
        clearNavigationWatch();
      }
      spaResumeInProgress = false;
      if (activeRunId === runId) {
        activeRunId = null;
      }
    }
  }

  async function resumeSavedRun({ force = false } = {}) {
    if (resumeStarted && !force) {
      return;
    }
    if (activeRunId) {
      return;
    }
    resumeStarted = true;
    try {
      const response = await send({
        type: "NAUKRI_RESUME_CHECK",
        href: currentUrl().href
      });
      if (!response.resume || !response.runState) {
        resumeStarted = false;
        return;
      }
      await logFlow(response.runState.runId, "navigation-resumed", {
        pageNumber: response.runState.pageNumber,
        navigationPending: response.runState.navigationPending
      });
      activeRunId = response.runState.runId;
      stopRequested = false;
      await wait(randomDelay(config.resumeDelayMs));
      const state = await checkRunning(response.runState.runId);
      await runPage(response.runState.runId, state);
    } catch (error) {
      if (error instanceof NaukriBlockError) {
        const values = await chrome.storage.local.get("runs.naukri");
        const state = values["runs.naukri"];
        if (state && state.state === "RUNNING" && state.siteId === adapter.id) {
          await reportFailure(state.runId, error);
        }
      } else {
        debugLog("Could not resume Naukri run", error);
      }
      if (!activeRunId) {
        resumeStarted = false;
      }
    }
  }

  document.addEventListener("click", markClickedJobOpened, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }
    if (message.type === "PING") {
      const connected = message.siteId === adapter.id;
      sendResponse({
        ok: connected,
        ready: connected && hasResultsPage(),
        error: connected && !hasResultsPage()
          ? "Open a Naukri search results page to start."
          : undefined
      });
      return false;
    }
    if (message.siteId !== adapter.id) {
      return false;
    }
    if (message.type === "NAUKRI_RESUME_RUN") {
      if (message.runId && !activeRunId) {
        void resumeSavedRun({ force: true });
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "STOP_RUN") {
      if (message.runId === activeRunId || message.runId === navigationRunId) {
        stopRequested = true;
        clearNavigationWatch();
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== "START_RUN") {
      return false;
    }

    (async () => {
      if (!hasResultsPage()) {
        throw new Error("Start is only available on a Naukri search-results page with job cards.");
      }
      if (typeof message.runId !== "string" || !message.runId) {
        throw new Error("START_RUN requires a run ID.");
      }
      const values = await chrome.storage.local.get("runs.naukri");
      const state = values["runs.naukri"];
      if (!state || state.siteId !== adapter.id || state.state !== "RUNNING" || state.runId !== message.runId) {
        throw new Error("The Naukri run is not active in extension storage.");
      }
      void runPage(message.runId, state);
      return { ok: true };
    })().then(sendResponse).catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    return true;
  });

  void resumeSavedRun();
})();
