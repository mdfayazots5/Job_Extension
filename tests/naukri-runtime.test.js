"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");

function loadScripts(context, files) {
  for (const file of files) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
}

function paginationDocument(page, nextMarkup) {
  return new JSDOM(`
    <div class="srp-jobtuple-wrapper" data-job-id="${page}">
      <a class="title" href="/job-${page}">Role ${page}</a>
      <div class="comp-name">Company ${page}</div>
    </div>
    <div id="lastCompMark"><a class="selected">${page}</a>${nextMarkup}</div>
  `).window.document;
}

async function testRunLoop() {
  const context = vm.createContext({ URL, Date });
  loadScripts(context, [
    "src/sites/naukri/config.js",
    "src/sites/naukri/selectors.js",
    "src/sites/naukri/adapter.js",
    "src/core/run-loop.js"
  ]);
  const { JobCollectorNaukriAdapter: adapter, JobCollectorRunLoop } = context;
  const captured = [];
  let preparedPage = null;
  let navigationClicks = 0;
  let finished = false;
  let beforePageChange = 0;

  function makeContext(doc, page) {
    const url = new URL(`https://www.naukri.com/sample-jobs${page > 1 ? `-${page}` : ""}`);
    return {
      doc,
      url,
      pageNumber: page,
      setPage() {},
      setNextPage() {},
      async ensureVisible() {},
      checkBlock() {
        const block = adapter.detectBlock(doc, url);
        if (block) throw new Error(block);
      },
      async readStats() {
        return { capturedCount: captured.length };
      },
      getContainer() { return null; },
      async collectPageWork() {
        const records = adapter.parsePage({ doc, capturedAt: "2026-10-17T10:00:00.000Z" });
        captured.push(...records);
        return { capturedCount: captured.length };
      },
      async beforeNextPage() { beforePageChange += 1; },
      async prepareNavigation(nextPage) { preparedPage = nextPage; },
      async writeProgress() {},
      async finish() { finished = true; }
    };
  }

  const first = paginationDocument(1, "<a id='next'>Next</a>");
  first.querySelector("#next").addEventListener("click", () => { navigationClicks += 1; });
  const firstResult = await JobCollectorRunLoop.run(
    adapter,
    makeContext(first, 1)
  );
  assert.equal(firstResult.navigation, "navigated");
  assert.equal(preparedPage, 2);
  assert.equal(navigationClicks, 1);
  assert.equal(beforePageChange, 1);
  assert.equal(finished, false);

  finished = false;
  const lastPage = paginationDocument(2, "<a disabled>Next</a>");
  const secondResult = await JobCollectorRunLoop.run(
    adapter,
    makeContext(lastPage, 2)
  );
  assert.equal(secondResult.navigation, "none");
  assert.equal(finished, true);
  assert.deepEqual(captured.map((record) => record.jobId), ["1", "2"]);

  finished = false;
  const singlePage = paginationDocument(1, "");
  const singleResult = await JobCollectorRunLoop.run(
    adapter,
    makeContext(singlePage, 1)
  );
  assert.equal(singleResult.navigation, "none");
  assert.equal(finished, true);

  await assert.rejects(
    JobCollectorRunLoop.run(adapter, {
      ...makeContext(singlePage, 1),
      async ensureVisible() { throw new Error("stopped"); }
    }),
    /stopped/
  );
  const blockPage = new JSDOM("<title>Verify you are human</title>").window.document;
  assert.match(
    adapter.detectBlock(blockPage, new URL("https://www.naukri.com/sample-jobs")),
    /access block/
  );
  console.log("PASS Naukri run loop: two pages, disabled last-page Next, single page, Stop, simulated block.");
}

function eventHook() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      for (const listener of listeners) await listener(...args);
    }
  };
}

async function testNaukriBackground() {
  const store = {};
  const alarmsCreated = [];
  const alarmsCleared = [];
  const browserTabs = [{
    id: 17,
    url: "https://www.naukri.com/dot-net-developer-jobs",
    active: true
  }];
  const createdTabs = [];
  const alarms = {
    onAlarm: eventHook(),
    async create(name, info) { alarmsCreated.push({ name, info }); },
    async clear(name) { alarmsCleared.push(name); return true; }
  };
  const chrome = {
    runtime: {
      id: "joblink-test",
      getURL(file) { return `chrome-extension://joblink-test/${file}`; }
    },
    storage: {
      local: {
        async get(keys) {
          return Array.isArray(keys)
            ? Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]]))
            : (keys in store ? { [keys]: store[keys] } : {});
        },
        async set(updates) { Object.assign(store, updates); }
      }
    },
    tabs: {
      async query() { return browserTabs; },
      async sendMessage(tabId, message) {
        if (message.type === "PING") return { ok: true };
        if (message.type === "START_RUN") return { ok: true };
        return { ok: true };
      },
      async create(options) {
        const tab = { id: 50 + createdTabs.length, ...options };
        createdTabs.push(tab);
        return tab;
      },
      async update(tabId, updates) {
        const tab = browserTabs.find((item) => item.id === tabId);
        if (tab) Object.assign(tab, updates);
        return tab;
      }
    },
    alarms
  };
  const context = vm.createContext({
    URL,
    Date,
    Math,
    crypto: crypto.webcrypto,
    chrome,
    console
  });
  loadScripts(context, [
    "src/core/storage.js",
    "src/sites/naukri/config.js",
    "src/sites/naukri/selectors.js",
    "src/sites/naukri/adapter.js",
    "src/sites/naukri/background.js"
  ]);
  const background = context.JobCollectorNaukriBackground;
  await background.initialize();

  store["runs.linkedin"] = {
    state: "RUNNING",
    siteId: "linkedin",
    runId: "linkedin-running"
  };
  await assert.rejects(
    background.handleMessage({ type: "START_RUN", siteId: "naukri" }, { id: chrome.runtime.id }),
    /already active/
  );
  store["runs.linkedin"].state = "DONE";
  store["cooldown.linkedin"] = { until: Date.now() + 24 * 60 * 60 * 1000 };

  await background.handleMessage(
    { type: "START_RUN", siteId: "naukri" },
    { id: chrome.runtime.id }
  );
  let state = store["runs.naukri"];
  assert.equal(state.state, "RUNNING");
  assert.equal(state.siteId, "naukri");
  assert.equal(state.tabId, 17);

  const capturedRecord = {
    siteId: "naukri",
    jobId: "123456789012",
    title: "Role",
    company: "Company",
    url: "https://www.naukri.com/job-listings-role-123456789012",
    applyType: "Naukri",
    pageNumber: 1
  };
  const sender = { id: chrome.runtime.id, tab: { id: 17 } };
  const saved = await background.handleMessage({
    type: "SAVE_CAPTURE",
    siteId: "naukri",
    runId: state.runId,
    record: capturedRecord
  }, sender);
  assert.equal(saved.saved, true);
  assert.equal(store["budgets.naukri"].jobsToday, 1);

  const duplicate = await background.handleMessage({
    type: "SAVE_CAPTURE",
    siteId: "naukri",
    runId: state.runId,
    record: capturedRecord
  }, sender);
  assert.equal(duplicate.saved, false);

  const searchUrl = "https://www.naukri.com/dot-net-developer-jobs";
  await background.handleMessage({
    type: "NAUKRI_PREPARE_NAVIGATION",
    siteId: "naukri",
    runId: state.runId,
    pageNumber: 2,
    searchUrl
  }, sender);
  assert.equal(store["runs.naukri"].pageNumber, 2);
  assert.equal(store["runs.naukri"].state, "RUNNING");
  assert.equal(store["runs.naukri"].navigationPending, true);
  assert.equal(alarmsCreated.length, 1);

  const wrongTab = await background.handleMessage({
    type: "NAUKRI_RESUME_CHECK",
    siteId: "naukri",
    href: "https://www.naukri.com/dot-net-developer-jobs-2"
  }, { id: chrome.runtime.id, tab: { id: 18 } });
  assert.equal(wrongTab.resume, false);
  const resumed = await background.handleMessage({
    type: "NAUKRI_RESUME_CHECK",
    siteId: "naukri",
    href: "https://www.naukri.com/dot-net-developer-jobs-2"
  }, sender);
  assert.equal(resumed.resume, true);
  assert.equal(resumed.runState.siteId, "naukri");
  assert.equal(resumed.runState.tabId, 17);
  assert.equal(resumed.runState.state, "RUNNING");
  assert.equal(resumed.runState.navigationPending, false);
  assert.ok(alarmsCleared.length > 0);

  await background.handleMessage({
    type: "NAUKRI_RUN_FINISHED",
    siteId: "naukri",
    runId: state.runId,
    pageNumber: 2,
    capturedCount: 1
  }, sender);
  assert.equal(store["runs.naukri"].state, "DONE");
  assert.equal(store["runs.naukri"].pageNumber, 0);
  assert.equal(store["runs.naukri"].capturedCount, 0);
  assert.equal(store["runs.naukri"].resultsOpened, false);
  assert.equal(createdTabs.length, 0);

  await background.handleMessage({ type: "START_RUN", siteId: "naukri" }, { id: chrome.runtime.id });
  state = store["runs.naukri"];
  await background.handleMessage({
    type: "NAUKRI_RUN_FAILED",
    siteId: "naukri",
    runId: state.runId,
    errorCode: "block_detected",
    message: "Access Denied"
  }, sender);
  assert.equal(store["runs.naukri"].state, "ERROR");
  assert.equal(store["cooldown.naukri"].until - store["cooldown.naukri"].lastBlockAt, 24 * 60 * 60 * 1000);
  store["cooldown.naukri"].until = 0;

  await background.handleMessage({ type: "START_RUN", siteId: "naukri" }, { id: chrome.runtime.id });
  state = store["runs.naukri"];
  await background.handleMessage({
    type: "NAUKRI_RUN_FAILED",
    siteId: "naukri",
    runId: state.runId,
    errorCode: "block_detected",
    message: "Access Denied"
  }, sender);
  assert.equal(store["runs.naukri"].state, "ERROR");
  assert.equal(store["cooldown.naukri"].until - store["cooldown.naukri"].lastBlockAt, 48 * 60 * 60 * 1000);
  assert.equal(store["cooldown.naukri"].recentBlocks.length, 2);

  store["cooldown.naukri"].until = 0;
  await background.handleMessage({ type: "START_RUN", siteId: "naukri" }, { id: chrome.runtime.id });
  state = store["runs.naukri"];
  await background.handleMessage({
    type: "SAVE_CAPTURE",
    siteId: "naukri",
    runId: state.runId,
    record: { ...capturedRecord, jobId: "123456789013" }
  }, sender);
  await background.handleMessage({
    type: "STOP_RUN",
    siteId: "naukri"
  }, { id: chrome.runtime.id });
  assert.equal(store["runs.naukri"].state, "STOPPED");
  assert.equal(store["runs.naukri"].pageNumber, 0);
  assert.equal(store["runs.naukri"].capturedCount, 0);
  assert.ok(store.records["naukri:123456789013"]);
  assert.equal(store["runs.naukri"].resultsOpened, false);
  assert.equal(createdTabs.length, 0);

  await background.handleMessage({ type: "START_RUN", siteId: "naukri" }, { id: chrome.runtime.id });
  state = store["runs.naukri"];
  await background.handleMessage({
    type: "NAUKRI_PREPARE_NAVIGATION",
    siteId: "naukri",
    runId: state.runId,
    pageNumber: 2,
    searchUrl
  }, sender);
  await alarms.onAlarm.emit({ name: `naukri-navigation:${state.runId}` });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store["runs.naukri"].state, "ERROR");
  assert.equal(store["runs.naukri"].lastError, "page_load_failed");
  assert.equal(store["runs.naukri"].pageNumber, 0);
  assert.equal(store["runs.naukri"].capturedCount, 0);

  await assert.rejects(
    background.handleMessage({ type: "STOP_RUN", siteId: "naukri" }, { id: chrome.runtime.id }),
    /There is no active Naukri run to stop/
  );
  console.log("PASS Naukri background: site lock, dedupe/budget, persisted navigation, tab-verified resume, cooldown, terminal reset, and page-load timeout.");
}

Promise.resolve()
  .then(testRunLoop)
  .then(testNaukriBackground)
  .then(() => console.log("Naukri runtime simulations passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
