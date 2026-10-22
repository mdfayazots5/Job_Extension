"use strict";

(function initializeIndeedCollector(global) {
  if (global.JobCollectorIndeedContentInstalled) {
    return;
  }
  global.JobCollectorIndeedContentInstalled = true;

  const adapter = global.JobCollectorIndeedAdapter;
  const selectors = global.JobCollectorIndeedSelectors;
  const config = global.JobCollectorIndeedConfig;
  let activeRunId = null;
  let stopRequested = false;
  let resumeStarted = false;
  let navigationTimer = null;
  let navigationRunId = null;

  class IndeedBlockError extends Error {
    constructor(message) {
      super(message);
      this.name = "IndeedBlockError";
    }
  }

  class IndeedStopError extends Error {
    constructor() {
      super("The Indeed run was stopped.");
      this.name = "IndeedStopError";
    }
  }

  class IndeedLimitError extends Error {
    constructor() {
      super("The Indeed daily job limit was reached.");
      this.name = "IndeedLimitError";
    }
  }

  function randomDelay(range) {
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function clearNavigationTimer() {
    if (navigationTimer !== null) {
      clearTimeout(navigationTimer);
      navigationTimer = null;
    }
    navigationRunId = null;
  }

  function currentUrl() {
    return new URL(window.location.href);
  }

  function hasResultsPage() {
    return adapter.matchesUrl(currentUrl())
      && Boolean(document.querySelector("#mosaic-provider-jobcards"));
  }

  async function send(message) {
    const response = await chrome.runtime.sendMessage({
      ...message,
      siteId: adapter.id
    });
    if (!response || response.ok !== true) {
      throw new Error(response && response.error
        ? response.error
        : "The Indeed service worker did not acknowledge the request.");
    }
    return response;
  }

  async function logFlow(runId, event, details = {}) {
    try {
      const settings = await chrome.storage.local.get("debug.indeed");
      if (settings["debug.indeed"] !== true) {
        return;
      }
      await send({
        type: "INDEED_FLOW_LOG",
        runId,
        event,
        details
      });
    } catch (error) {
      console.warn("[Indeed Jobs Collector] Could not persist flow log", event, error);
    }
  }

  async function checkRunning(runId) {
    if (stopRequested || activeRunId !== runId) {
      throw new IndeedStopError();
    }
    const values = await chrome.storage.local.get("runs.indeed");
    const state = values["runs.indeed"];
    if (
      !state
      || state.runId !== runId
      || state.siteId !== adapter.id
      || !["RUNNING", "PAGINATING"].includes(state.state)
    ) {
      stopRequested = true;
      throw new IndeedStopError();
    }
    return state;
  }

  async function waitUntilVisible(runId) {
    while (document.visibilityState !== "visible") {
      await checkRunning(runId);
      await wait(300 + Math.floor(Math.random() * 401));
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

  async function checkPageBlock() {
    const url = currentUrl();
    const block = adapter.detectBlock(document, url);
    if (block) {
      throw new IndeedBlockError(block);
    }
    if (!adapter.matchesUrl(url)) {
      throw new Error("Open an Indeed jobs search page with a query term to start.");
    }
  }

  async function verifyCards(runId) {
    await checkPageBlock();
    if (selectors.getJobCards(document).length > 0) {
      return;
    }
    await waitVisibleDelay(runId, randomDelay(config.noResultsRecheckMs));
    await checkRunning(runId);
    await checkPageBlock();
    if (selectors.getJobCards(document).length === 0) {
      throw new IndeedBlockError("Indeed returned 0 job cards on two consecutive checks.");
    }
  }

  async function readStats(runId) {
    const state = await checkRunning(runId);
    return { capturedCount: Number(state.capturedCount) || 0 };
  }

  async function reportFailure(runId, error) {
    try {
      await send({
        type: "INDEED_RUN_FAILED",
        runId,
        errorCode: error instanceof IndeedBlockError ? "block_detected" : "collector_error",
        message: error instanceof Error ? error.message : String(error)
      });
    } catch (reportError) {
      console.error("[Indeed Jobs Collector] Could not persist run failure", reportError);
    }
  }

  function scrollPage() {
    window.scrollBy({
      top: Math.max(240, Math.round(window.innerHeight * 0.7)),
      behavior: "smooth"
    });
  }

  async function runPage(runId, runState) {
    const pageNumber = runState.pageNumber;
    await logFlow(runId, "run-start", { pageNumber });
    const context = {
      doc: document,
      url: currentUrl(),
      runId,
      pageNumber,
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
        await waitUntilVisible(currentRunId);
        scrollPage();
        await waitVisibleDelay(currentRunId, randomDelay(config.scrollDelayMs));
        await checkRunning(currentRunId);

        const pageResult = await global.JobCollectorIndeedParser.parsePageWithRetry({
          doc: document
        });
        await send({
          type: "INDEED_PAGE_DIAGNOSTICS",
          runId: currentRunId,
          pageNumber: currentPage,
          counters: pageResult.diagnostics
        });
        const records = pageResult.records;
        await logFlow(currentRunId, "page-parsed", {
          pageNumber: currentPage,
          recordCount: records.length
        });
        if (!records.length) {
          throw new IndeedBlockError("Indeed returned 0 usable job records on a results page.");
        }

        const skipTitleSettings = await chrome.storage.local.get("indeed:skipTitles");
        const skipTitles = Array.isArray(skipTitleSettings["indeed:skipTitles"])
          ? skipTitleSettings["indeed:skipTitles"]
          : [];
        const pageIds = new Set();
        for (const rawRecord of records) {
          await checkRunning(currentRunId);
          if (pageIds.has(rawRecord.jobId)) {
            continue;
          }
          pageIds.add(rawRecord.jobId);
          const skipReason = adapter.getSkipReason(rawRecord);
          if (skipReason) {
            await send({
              type: "INDEED_SKIP_CAPTURE",
              runId: currentRunId,
              jobId: rawRecord.jobId,
              ...skipReason
            });
            continue;
          }
          const normalized = adapter.normalize({
            ...rawRecord,
            pageNumber: currentPage
          });
          if (adapter.shouldSkipRole(normalized, skipTitles)) {
            continue;
          }
          const response = await send({
            type: "SAVE_CAPTURE",
            runId: currentRunId,
            record: normalized
          });
          if (response.limitReached) {
            await send({
              type: "INDEED_RUN_FINISHED",
              runId: currentRunId,
              pageNumber: currentPage
            });
            throw new IndeedLimitError();
          }
        }
        return readStats(currentRunId);
      },
      async beforeNextPage(currentPage) {
        await logFlow(runId, "page-complete", { pageNumber: currentPage });
        if (currentPage % config.microPauseEveryPages === 0) {
          await waitVisibleDelay(runId, randomDelay(config.microPauseMs));
        }
        await waitVisibleDelay(runId, randomDelay(config.pageDelayMs));
      },
      async prepareNavigation(nextPage) {
        await waitUntilVisible(runId);
        await logFlow(runId, "pagination-start", { pageNumber: nextPage });
        await send({
          type: "INDEED_PREPARE_NAVIGATION",
          runId,
          pageNumber: nextPage,
          searchUrl: `${context.url.origin}${context.url.pathname}?q=${encodeURIComponent(context.url.searchParams.get("q"))}`,
          lastActionAt: new Date().toISOString()
        });
        clearNavigationTimer();
        navigationRunId = runId;
        navigationTimer = setTimeout(() => {
          void send({
            type: "INDEED_RUN_FAILED",
            runId,
            errorCode: "page_load_failed",
            message: "Indeed pagination did not load a new page within 45 seconds."
          }).catch((error) => console.error("[Indeed Jobs Collector] Could not report navigation timeout", error));
          navigationTimer = null;
          navigationRunId = null;
        }, config.navigationTimeoutMs);
        window.addEventListener("pagehide", clearNavigationTimer, { once: true });
      },
      async writeProgress(currentPage, stats, phase) {
        await send({
          type: "INDEED_PROGRESS",
          runId,
          pageNumber: currentPage,
          capturedCount: stats.capturedCount,
          phase
        });
      },
      async finish(currentPage, stats, message) {
        await logFlow(runId, "run-finished", { pageNumber: currentPage });
        await send({
          type: "INDEED_RUN_FINISHED",
          runId,
          pageNumber: currentPage,
          capturedCount: stats.capturedCount,
          message
        });
      },
      async onPage() {}
    };

    let navigationPending = false;
    try {
      const result = await global.JobCollectorRunLoop.run(adapter, context);
      navigationPending = result.navigation === "navigated";
    } catch (error) {
      if (!(error instanceof IndeedStopError) && !(error instanceof IndeedLimitError)) {
        await logFlow(runId, "run-failed", {
          pageNumber,
          reason: error instanceof IndeedBlockError ? "block-detected" : "collector-error"
        });
        await reportFailure(runId, error);
      }
    } finally {
      if (!navigationPending) {
        clearNavigationTimer();
      }
      if (activeRunId === runId) {
        activeRunId = null;
      }
    }
  }

  async function resumeSavedRun() {
    if (resumeStarted || activeRunId) {
      return;
    }
    resumeStarted = true;
    let resumeRunId = null;
    try {
      const response = await send({
        type: "INDEED_RESUME_CHECK",
        href: currentUrl().href
      });
      if (!response.resume || !response.runState) {
        return;
      }
      resumeRunId = response.runState.runId;
      activeRunId = resumeRunId;
      stopRequested = false;
      await checkPageBlock();
      const resumedPage = adapter.getCurrentPage(document, currentUrl());
      if (resumedPage !== response.runState.pageNumber) {
        await send({
          type: "INDEED_RUN_FAILED",
          runId: response.runState.runId,
          errorCode: "page_load_failed",
          message: "Indeed loaded a page that does not match the saved pagination state."
        });
        if (activeRunId === resumeRunId) {
          activeRunId = null;
        }
        return;
      }
      await waitVisibleDelay(activeRunId, randomDelay(config.resumeDelayMs));
      await checkRunning(activeRunId);
      await runPage(activeRunId, response.runState);
    } catch (error) {
      if (error instanceof IndeedBlockError && resumeRunId) {
        await reportFailure(resumeRunId, error);
      } else {
        console.error("[Indeed Jobs Collector] Could not resume the Indeed run", error);
      }
    } finally {
      if (resumeRunId && activeRunId === resumeRunId) {
        activeRunId = null;
      }
      resumeStarted = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }
    if (message.type === "PING") {
      const connected = message.siteId === adapter.id;
      const ready = connected && hasResultsPage();
      sendResponse({
        ok: connected,
        ready,
        error: connected && !ready
          ? "Open an Indeed jobs search page with a query and #mosaic-provider-jobcards to start."
          : undefined
      });
      return false;
    }
    if (message.siteId !== adapter.id) {
      return false;
    }
    if (message.type === "INDEED_RESUME_RUN") {
      void resumeSavedRun();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "STOP_RUN") {
      if (message.runId === activeRunId || message.runId === navigationRunId) {
        stopRequested = true;
        clearNavigationTimer();
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== "START_RUN") {
      return false;
    }

    (async () => {
      if (!hasResultsPage()) {
        throw new Error("Open an Indeed jobs search page with a query and #mosaic-provider-jobcards to start.");
      }
      if (typeof message.runId !== "string" || !message.runId) {
        throw new Error("START_RUN requires a run ID.");
      }
      const values = await chrome.storage.local.get("runs.indeed");
      const state = values["runs.indeed"];
      if (!state || state.siteId !== adapter.id || state.state !== "RUNNING" || state.runId !== message.runId) {
        throw new Error("The Indeed run is not active in extension storage.");
      }
      activeRunId = message.runId;
      stopRequested = false;
      void runPage(message.runId, state);
      return { ok: true };
    })().then(sendResponse).catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    return true;
  });

  void resumeSavedRun();
})(globalThis);
