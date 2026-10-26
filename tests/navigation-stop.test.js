"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

function loadSite(siteId, markup, {
  pageNumber = 1,
  includeApiResponse = true,
  enableFlowLog = false
} = {}) {
  const domain = siteId === "indeed" ? "https://in.indeed.com" : "https://www.naukri.com";
  const search = siteId === "indeed"
    ? "/jobs?q=developer"
    : `/dot-net-developer-jobs${pageNumber > 1 ? `-${pageNumber}` : ""}`;
  const dom = new JSDOM(markup, {
    url: `${domain}${search}`,
    pretendToBeVisual: true
  });
  dom.window.scrollBy = () => {};
  const next = dom.window.document.querySelector(
    siteId === "indeed" ? "a[data-testid='pagination-page-next']" : "#lastCompMark a[rel='next']"
  );
  next.addEventListener("click", (event) => event.preventDefault());
  next.click = () => {};

  const messages = [];
  const clearedTimeouts = [];
  const clearedIntervals = [];
  const longTimers = new Map();
  const intervals = new Map();
  let nextTimerId = 1;
  let elapsed = 0;
  let listener;
  const runId = `${siteId}-pending-navigation`;
  const runState = {
    siteId,
    state: "RUNNING",
    runId,
    pageNumber,
    currentPage: pageNumber,
    startPageNumber: pageNumber,
    capturedCount: 0,
    capturedJobIds: [],
    microPauseEveryPages: 99
  };
  const chrome = {
    runtime: {
      id: "navigation-stop-test",
      async sendMessage(message) {
        messages.push(message);
        return { ok: true, resume: false };
      },
      onMessage: {
        addListener(callback) { listener = callback; }
      }
    },
    storage: {
      local: {
        async get(key) {
          if (key === `runs.${siteId}`) return { [key]: runState };
          if (key === "debug.naukri") return { [key]: enableFlowLog };
          return {};
        }
      }
    }
  };

  class FastDate extends Date {
    static now() { return Date.now() + elapsed; }
  }
  const context = vm.createContext({
    URL,
    Date: FastDate,
    Math,
    document: dom.window.document,
    window: dom.window,
    chrome,
    console,
    setTimeout(callback, milliseconds) {
      const id = nextTimerId++;
      if (milliseconds >= 45000) {
        longTimers.set(id, callback);
      } else {
        elapsed += milliseconds;
        global.setTimeout(callback, 0);
      }
      return id;
    },
    clearTimeout(id) {
      clearedTimeouts.push(id);
      longTimers.delete(id);
    },
    setInterval(callback) {
      const id = nextTimerId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) {
      clearedIntervals.push(id);
      intervals.delete(id);
    }
  });

  const commonFiles = [
    "src/core/storage.js",
    `src/sites/${siteId}/config.js`,
    `src/sites/${siteId}/selectors.js`,
    `src/sites/${siteId}/adapter.js`,
    "src/core/run-loop.js"
  ];
  const files = siteId === "indeed"
    ? [
      "src/core/storage.js",
      "src/sites/indeed/config.js",
      "src/sites/indeed/selectors.js",
      "src/sites/indeed/parse.js",
      "src/sites/indeed/adapter.js",
      "src/core/run-loop.js",
      "src/sites/indeed/collector.js"
    ]
    : [...commonFiles, "src/sites/naukri/collector.js"];
  for (const file of files) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  if (siteId === "naukri" && includeApiResponse) {
    context.JobCollectorNaukriApiResponses = {
      1: {
        status: 200,
        jobDetails: [{
          jobId: "123456789012",
          companyApplyJob: false,
          questionnaireIdPresent: true,
          applyRedirectUrl: null
        }]
      }
    };
  }
  return {
    dom,
    messages,
    clearedTimeouts,
    clearedIntervals,
    longTimers,
    intervals,
    runId,
    get listener() { return listener; }
  };
}

async function startAndStopPendingNavigation(siteId, markup, options = {}) {
  const harness = loadSite(siteId, markup, options);
  await new Promise((resolve, reject) => {
    const returnedAsync = harness.listener(
      { type: "START_RUN", siteId, runId: harness.runId },
      {},
      (response) => {
        try {
          assert.equal(response.ok, true);
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    );
    assert.equal(returnedAsync, true);
  });

  for (let attempt = 0; attempt < 150 && !harness.messages.some(
    (message) => message.type === `${siteId.toUpperCase()}_PREPARE_NAVIGATION`
  ); attempt += 1) {
    await new Promise((resolve) => global.setTimeout(resolve, 2));
  }
  const prepareType = siteId === "indeed" ? "INDEED_PREPARE_NAVIGATION" : "NAUKRI_PREPARE_NAVIGATION";
  assert.ok(
    harness.messages.some((message) => message.type === prepareType),
    `${siteId} prepared navigation: ${JSON.stringify(harness.messages.map((message) => [message.type, message.message]))}`
  );
  if (options.expectNextPage) {
    const preparedNavigation = harness.messages.find((message) => message.type === prepareType);
    assert.equal(preparedNavigation.pageNumber, options.expectNextPage);
    assert.ok(
      harness.messages.some((message) => (
        message.type === "NAUKRI_FLOW_LOG"
        && message.event === "application-api-unavailable"
      )),
      "Naukri records an explicit diagnostic when the initial search response is missing"
    );
    assert.equal(
      harness.messages.some((message) => message.type === "NAUKRI_RUN_FAILED"),
      false,
      "Naukri continues collecting the visible page when the initial search response is unavailable"
    );
  }
  for (let attempt = 0; attempt < 20 && harness.longTimers.size === 0; attempt += 1) {
    await new Promise((resolve) => global.setTimeout(resolve, 2));
  }
  assert.equal(
    harness.longTimers.size,
    1,
    `${siteId} keeps its navigation timeout while the next page is pending; timers=${JSON.stringify(harness.clearedTimeouts)}`
  );
  const intervalIds = Array.from(harness.intervals.keys());

  harness.listener(
    { type: "STOP_RUN", siteId, runId: harness.runId },
    {},
    () => {}
  );
  await new Promise((resolve) => global.setTimeout(resolve, 0));
  assert.equal(harness.longTimers.size, 0, `${siteId} cancels the pending navigation timeout on Stop`);
  if (siteId === "naukri") {
    assert.equal(harness.intervals.size, 0, "Naukri clears its SPA page-advance monitor on Stop");
    assert.ok(intervalIds.every((id) => harness.clearedIntervals.includes(id)));
  }
  harness.dom.window.close();
}

async function run() {
  await startAndStopPendingNavigation(
    "indeed",
    `<div id="mosaic-provider-jobcards">
      <div class="job_seen_beacon">
        <a class="jcs-JobTitle" data-jk="0123456789abcdef" href="/rc/clk?jk=0123456789abcdef">
          <h3 class="jobTitle"><span title="Role">Role</span></h3>
        </a>
      </div>
    </div>
    <a data-testid="pagination-page-next" href="/jobs?q=developer&start=10">Next</a>`
  );
  await startAndStopPendingNavigation(
    "naukri",
    `<div class="srp-jobtuple-wrapper" data-job-id="123456789012"
      data-company-apply-job="false" data-questionnaire-id-present="true">
      <a class="title" href="/job-listings-role-123456789012">Role</a>
      <div class="comp-name">Company</div>
    </div>
    <div id="lastCompMark"><a class="selected">1</a><a rel="next">Next page</a></div>`
  );
  await startAndStopPendingNavigation(
    "naukri",
    `<div class="srp-jobtuple-wrapper" data-job-id="223456789012">
      <a class="title" href="/job-listings-role-223456789012">Role</a>
      <div class="comp-name">Company</div>
    </div>
    <div id="lastCompMark"><a class="selected">25</a><a rel="next">Next page</a></div>`,
    {
      pageNumber: 25,
      includeApiResponse: false,
      enableFlowLog: true,
      expectNextPage: 26
    }
  );
  console.log("Navigation Stop tests passed: pending Indeed and Naukri timers/monitors clear after Stop.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
