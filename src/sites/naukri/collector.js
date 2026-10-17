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
      await wait(randomDelay(config.scrollDelayMs));
    }
  }

  async function checkPageBlock() {
    const block = adapter.detectBlock(document, currentUrl());
    if (block) {
      throw new NaukriBlockError(block);
    }
    if (!adapter.matchesUrl(currentUrl())) {
      throw new NaukriBlockError("The current page is not a Naukri jobs search-results page.");
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
      throw new NaukriBlockError("Naukri search page returned 0 job cards on two consecutive checks.");
    }
  }

  async function readStats(runId) {
    const state = await checkRunning(runId);
    return { capturedCount: Number(state.capturedCount) || 0 };
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

  async function runPage(runId, runState) {
    if (activeRunId && activeRunId !== runId) {
      return;
    }
    activeRunId = runId;
    stopRequested = false;
    const pageNumber = Number.isInteger(runState.pageNumber) && runState.pageNumber > 0
      ? runState.pageNumber
      : 1;
    const pageUrl = currentUrl();

    const context = {
      doc: document,
      url: pageUrl,
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
        await scrollResults(currentRunId);
        await checkRunning(currentRunId);
        const parsed = adapter.parsePage({
          doc: document,
          capturedAt: new Date().toISOString(),
          onCardError(detail) {
            debugLog("Card parsing failed", detail.selector, detail.jobId, detail.message);
          }
        });
        const currentIds = new Set();
        for (const record of parsed) {
          await checkRunning(currentRunId);
          if (currentIds.has(record.jobId)) {
            continue;
          }
          currentIds.add(record.jobId);
          await send({
            type: "SAVE_CAPTURE",
            runId: currentRunId,
            siteId: adapter.id,
            record: { ...adapter.normalize(record), pageNumber: currentPage }
          });
        }
        return readStats(currentRunId);
      },
      async beforeNextPage(currentPage) {
        const microPauseInterval = runState.microPauseEveryPages
          || config.microPauseEveryPages.min;
        if (currentPage % microPauseInterval === 0) {
          await wait(randomDelay(config.microPauseMs));
          await checkRunning(runId);
        }
        await wait(randomDelay(config.pageChangeDelayMs));
        await checkRunning(runId);
      },
      async prepareNavigation(nextPage) {
        await send({
          type: "NAUKRI_PREPARE_NAVIGATION",
          runId,
          pageNumber: nextPage,
          searchUrl: pageUrl.href,
          lastActionAt: new Date().toISOString()
        });
        if (navigationTimer !== null) {
          clearTimeout(navigationTimer);
        }
        navigationTimer = setTimeout(() => {
          if (!stopRequested) {
            void send({
              type: "NAUKRI_RUN_FAILED",
              runId,
              errorCode: "page_load_failed",
              message: "page_load_failed"
            }).catch((error) => debugLog("Could not report page-load timeout", error));
          }
        }, config.navigationTimeoutMs);
        window.addEventListener("pagehide", () => {
          if (navigationTimer !== null) {
            clearTimeout(navigationTimer);
            navigationTimer = null;
          }
        }, { once: true });
      },
      async writeProgress(currentPage, stats, phase) {
        await send({
          type: "NAUKRI_PROGRESS",
          runId,
          pageNumber: currentPage,
          capturedCount: stats.capturedCount,
          phase
        });
      },
      async finish(currentPage, stats, message) {
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

    try {
      await globalThis.JobCollectorRunLoop.run(adapter, context);
    } catch (error) {
      if (!(error instanceof NaukriStopError)) {
        await reportFailure(runId, error);
      }
    } finally {
      if (navigationTimer !== null) {
        clearTimeout(navigationTimer);
        navigationTimer = null;
      }
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
      return false;
    }
    if (message.type === "PING") {
      sendResponse({
        ok: message.siteId === adapter.id && hasResultsPage(),
        error: hasResultsPage() ? undefined : "Open a Naukri search results page to start."
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
      if (message.runId === activeRunId) {
        stopRequested = true;
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
