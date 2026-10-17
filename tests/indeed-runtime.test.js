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

function eventHook() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    async emit(...args) {
      for (const listener of listeners) await listener(...args);
    }
  };
}

function indeedPage(page, next = false) {
  return new JSDOM(`
    <div id="mosaic-provider-jobcards">
      <div class="job_seen_beacon">
        <a class="jcs-JobTitle" data-jk="0123456789abcdef" href="/rc/clk?jk=0123456789abcdef">
          <h3 class="jobTitle"><span title="Indeed Role">Indeed Role</span></h3>
        </a>
      </div>
    </div>
    <div data-testid="pagination-page-current">${page}</div>
    ${next ? '<a data-testid="pagination-page-next" href="/jobs?q=developer&start=10">Next</a>' : ""}
  `, { url: `https://in.indeed.com/jobs?q=developer${page > 1 ? "&start=10" : ""}` }).window.document;
}

async function testIndeedRunLoop() {
  const context = vm.createContext({ URL, Date });
  loadScripts(context, [
    "src/sites/indeed/config.js",
    "src/sites/indeed/selectors.js",
    "src/sites/indeed/parse.js",
    "src/sites/indeed/adapter.js",
    "src/core/run-loop.js"
  ]);
  const adapter = context.JobCollectorIndeedAdapter;
  const loop = context.JobCollectorRunLoop;
  const firstDoc = indeedPage(1, true);
  const secondDoc = indeedPage(2, false);
  const order = [];
  let capturedCount = 0;
  let finished = false;
  const firstContext = {
    doc: firstDoc,
    url: new URL("https://in.indeed.com/jobs?q=developer"),
    pageNumber: 1,
    setPage() {},
    setNextPage() {},
    async ensureVisible() {},
    async checkBlock() {},
    async readStats() { return { capturedCount }; },
    getContainer() { return null; },
    async collectPageWork() { capturedCount += 1; return { capturedCount }; },
    async beforeNextPage() { order.push("delay"); },
    async prepareNavigation(pageNumber) { order.push(`persist:${pageNumber}`); },
    async writeProgress() {},
    async finish() { finished = true; },
    async onPage() {}
  };
  firstDoc.querySelector("a[data-testid='pagination-page-next']").addEventListener("click", (event) => {
    event.preventDefault();
    order.push("click");
  });
  const firstResult = await loop.run(adapter, firstContext);
  assert.equal(firstResult.navigation, "navigated");
  assert.deepEqual(order, ["delay", "persist:2", "click"]);
  assert.equal(finished, false);

  finished = false;
  const secondResult = await loop.run(adapter, {
    ...firstContext,
    doc: secondDoc,
    url: new URL("https://in.indeed.com/jobs?q=developer&start=10"),
    pageNumber: 2
  });
  assert.equal(secondResult.navigation, "none");
  assert.equal(finished, true);
  assert.equal(capturedCount, 2);

  const cloudflare = new JSDOM("<title>Just a moment...</title><p id='cf-challenge'>Checking your browser</p>");
  assert.match(
    adapter.detectBlock(cloudflare.window.document, new URL("https://in.indeed.com/jobs?q=developer")),
    /access block/
  );
  await assert.rejects(loop.run(adapter, {
    ...firstContext,
    async ensureVisible() { throw new Error("Stop requested"); }
  }), /Stop requested/);

  firstDoc.defaultView.close();
  secondDoc.defaultView.close();
  cloudflare.window.close();
  console.log("PASS Indeed run loop: two pages, last page, prepare-before-click, Stop interruption, Cloudflare detection.");
}

async function testIndeedBackground() {
  const store = {};
  const createdTabs = [];
  const alarmsCreated = [];
  const alarmsCleared = [];
  const browserTabs = [{
    id: 17,
    url: "https://in.indeed.com/jobs?q=developer&from=tracking&token=private&csrf=private",
    active: true
  }];
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
      async query(query) {
        return query && query.active ? browserTabs : browserTabs.concat(createdTabs);
      },
      async sendMessage(_tabId, message) {
        if (message.type === "PING") return { ok: true, ready: true };
        return { ok: true };
      },
      async create(options) {
        const tab = { id: 50 + createdTabs.length, ...options };
        createdTabs.push(tab);
        return tab;
      },
      async update(tabId, updates) {
        const tab = createdTabs.find((item) => item.id === tabId);
        if (tab) Object.assign(tab, updates);
        return tab;
      }
    },
    scripting: {
      async executeScript() {}
    },
    alarms
  };
  const context = vm.createContext({ URL, Date, Math, crypto: crypto.webcrypto, chrome, console });
  loadScripts(context, [
    "src/core/storage.js",
    "src/core/run-guard.js",
    "src/sites/indeed/config.js",
    "src/sites/indeed/selectors.js",
    "src/sites/indeed/parse.js",
    "src/sites/indeed/adapter.js",
    "src/sites/indeed/background.js"
  ]);
  const background = context.JobCollectorIndeedBackground;
  await background.initialize();
  const ownSender = { id: chrome.runtime.id };
  const tabSender = { id: chrome.runtime.id, tab: { id: 17 } };

  store["runs.linkedin"] = { siteId: "linkedin", state: "RUNNING", runId: "linkedin-active" };
  await assert.rejects(
    background.handleMessage({ type: "START_RUN", siteId: "indeed" }, ownSender),
    /already active/
  );
  store["runs.linkedin"].state = "DONE";
  store["runs.naukri"] = { siteId: "naukri", state: "RUNNING", runId: "naukri-active" };
  await assert.rejects(
    background.handleMessage({ type: "START_RUN", siteId: "indeed" }, ownSender),
    /Naukri/
  );
  store["runs.naukri"].state = "DONE";
  const linkedinCooldown = { until: Date.now() + 86400000 };
  const naukriCooldown = { until: Date.now() + 86400000 };
  store["cooldown.linkedin"] = linkedinCooldown;
  store["cooldown.naukri"] = naukriCooldown;
  store["opened.linkedin"] = { "101": true };
  store["opened.naukri"] = { "202": true };
  store["diagnostics.linkedin"] = [{ event: "linkedin-only" }];
  store["diagnostics.naukri"] = [{ event: "naukri-only" }];
  store["budgets.linkedin"] = { jobsToday: 11 };
  store["budgets.naukri"] = { jobsToday: 22 };

  await background.handleMessage({ type: "START_RUN", siteId: "indeed" }, ownSender);
  let state = store["runs.indeed"];
  assert.equal(state.state, "RUNNING");
  assert.equal(state.tabId, 17);
  assert.equal(state.pageNumber, 1);
  assert.equal(state.searchUrl, "https://in.indeed.com/jobs?q=developer");
  assert.doesNotMatch(JSON.stringify(state), /tracking|token|csrf/i);
  assert.doesNotMatch(JSON.stringify(store), /tracking|token|csrf/i);
  assert.equal(store["budgets.indeed"].runsToday, 1);
  assert.ok(store["budgets.indeed"].lastRunAt);
  await background.handleMessage({
    type: "INDEED_PAGE_DIAGNOSTICS",
    siteId: "indeed",
    runId: state.runId,
    pageNumber: 1,
    counters: {
      cards: 32,
      matched: 30,
      invalidId: 1,
      matchedEmpty: 0,
      sponsoredNoDate: 1,
      jsonMissing: 0,
      parseError: 0,
      notInResults: 0
    }
  }, tabSender);
  assert.equal(store["diagnostics.indeed"].length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(store["diagnostics.indeed"][0].counters)), {
    cards: 32,
    matched: 30,
    invalidId: 1,
    matchedEmpty: 0,
    sponsoredNoDate: 1,
    jsonMissing: 0,
    parseError: 0,
    notInResults: 0
  });
  const record = {
    siteId: "indeed",
    jobId: "0123456789abcdef",
    title: "Indeed Role",
    company: "Example",
    location: "Remote",
    url: "https://in.indeed.com/viewjob?jk=0123456789abcdef",
    applyType: "Easy Apply",
    postedText: "1 day ago",
    pubDate: 946684800000,
    applied: false,
    expired: false,
    pageNumber: 1
  };
  const firstCapture = await background.handleMessage({
    type: "SAVE_CAPTURE",
    siteId: "indeed",
    runId: state.runId,
    record
  }, tabSender);
  assert.equal(firstCapture.saved, true);
  assert.equal(store["budgets.indeed"].jobsToday, 1);
  assert.ok(store.records["indeed:0123456789abcdef"]);
  const savedRecord = store.records["indeed:0123456789abcdef"];
  assert.equal(
    savedRecord.postedDateEstimate,
    new Date(Date.parse(savedRecord.capturedAt) - 24 * 60 * 60 * 1000).toISOString()
  );
  assert.equal(savedRecord.firstSeenAt, savedRecord.capturedAt);
  const duplicate = await background.handleMessage({
    type: "SAVE_CAPTURE",
    siteId: "indeed",
    runId: state.runId,
    record
  }, tabSender);
  assert.equal(duplicate.saved, false);
  assert.equal(store["budgets.indeed"].jobsToday, 1);
  delete store.records["indeed:0123456789abcdef"].postedText;
  delete store.records["indeed:0123456789abcdef"].postedDateEstimate;
  const enrichedDuplicate = await background.handleMessage({
    type: "SAVE_CAPTURE",
    siteId: "indeed",
    runId: state.runId,
    record: { ...record, postedText: "1 day ago" }
  }, tabSender);
  assert.equal(enrichedDuplicate.saved, false);
  assert.equal(store.records["indeed:0123456789abcdef"].postedText, "1 day ago");
  assert.ok(store.records["indeed:0123456789abcdef"].postedDateEstimate);
  assert.equal(store["budgets.indeed"].jobsToday, 1);

  const skippedCapture = {
    type: "INDEED_SKIP_CAPTURE",
    siteId: "indeed",
    runId: state.runId,
    jobId: "2123456789abcdef",
    applied: true,
    expired: false
  };
  await background.handleMessage(skippedCapture, tabSender);
  await background.handleMessage(skippedCapture, tabSender);
  assert.equal(store["runs.indeed"].skippedAppliedCount, 1);
  assert.equal(store["runs.indeed"].skippedExpiredCount, 0);
  assert.equal(store.records["indeed:2123456789abcdef"], undefined);
  await background.handleMessage({
    ...skippedCapture,
    jobId: "2223456789abcdef",
    applied: false,
    expired: true
  }, tabSender);
  assert.equal(store["runs.indeed"].skippedAppliedCount, 1);
  assert.equal(store["runs.indeed"].skippedExpiredCount, 1);

  const searchUrl = "https://in.indeed.com/jobs?q=developer";
  await background.handleMessage({
    type: "INDEED_PREPARE_NAVIGATION",
    siteId: "indeed",
    runId: state.runId,
    pageNumber: 2,
    searchUrl
  }, tabSender);
  assert.equal(store["runs.indeed"].navigationPending, true);
  assert.equal(store["runs.indeed"].state, "RUNNING");
  assert.equal(store["runs.indeed"].pageNumber, 2);
  assert.equal(alarmsCreated[0].info.when - Date.now() <= 45000, true);
  await background.resumePendingNavigation(
    17,
    "https://in.indeed.com/jobs?q=developer&start=10"
  );
  const resumed = await background.handleMessage({
    type: "INDEED_RESUME_CHECK",
    siteId: "indeed",
    href: "https://in.indeed.com/jobs?q=developer&start=10"
  }, tabSender);
  assert.equal(resumed.resume, true);
  assert.equal(resumed.runState.pageNumber, 2);
  assert.ok(alarmsCleared.length > 0);
  assert.equal(store["runs.indeed"].navigationPending, false);

  await background.handleMessage({
    type: "INDEED_RUN_FINISHED",
    siteId: "indeed",
    runId: state.runId,
    pageNumber: 2
  }, tabSender);
  assert.equal(store["runs.indeed"].state, "DONE");
  assert.equal(store["runs.indeed"].resultsOpened, true);
  assert.equal(createdTabs.length, 1);

  store["cooldown.indeed"].until = 0;

  await background.handleMessage({ type: "START_RUN", siteId: "indeed" }, ownSender);
  state = store["runs.indeed"];
  const stopCapture = await background.handleMessage({
    type: "SAVE_CAPTURE",
    siteId: "indeed",
    runId: state.runId,
    record: {
      ...record,
      jobId: "1123456789abcdef",
      url: "https://in.indeed.com/viewjob?jk=1123456789abcdef",
      applied: false
    }
  }, tabSender);
  assert.equal(stopCapture.saved, true);
  await background.handleMessage({ type: "STOP_RUN", siteId: "indeed" }, ownSender);
  assert.equal(store["runs.indeed"].state, "STOPPED");
  assert.ok(store.records["indeed:1123456789abcdef"]);
  assert.equal(store["runs.indeed"].resultsOpened, true);
  assert.equal(createdTabs.length, 2);

  store["budgets.indeed"].lastRunAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
  store["budgets.indeed"].runsToday = 0;
  await background.handleMessage({ type: "START_RUN", siteId: "indeed" }, ownSender);
  state = store["runs.indeed"];
  await background.handleMessage({
    type: "INDEED_RUN_FAILED",
    siteId: "indeed",
    runId: state.runId,
    errorCode: "block_detected",
    message: "Cloudflare challenge detected."
  }, tabSender);
  assert.equal(store["runs.indeed"].state, "ERROR");
  assert.equal(store["cooldown.indeed"].until - store["cooldown.indeed"].lastBlockAt, 24 * 60 * 60 * 1000);
  assert.deepEqual(store["cooldown.linkedin"], linkedinCooldown);
  assert.deepEqual(store["cooldown.naukri"], naukriCooldown);
  assert.equal(store["killswitch.linkedin"], undefined);
  assert.equal(store["killswitch.naukri"], undefined);
  assert.equal(store["runs.linkedin"].state, "DONE");
  assert.equal(store["runs.naukri"].state, "DONE");
  assert.deepEqual(store["budgets.linkedin"], { jobsToday: 11 });
  assert.deepEqual(store["budgets.naukri"], { jobsToday: 22 });
  assert.deepEqual(store["diagnostics.linkedin"], [{ event: "linkedin-only" }]);
  assert.deepEqual(store["diagnostics.naukri"], [{ event: "naukri-only" }]);
  assert.deepEqual(store["opened.linkedin"], { "101": true });
  assert.deepEqual(store["opened.naukri"], { "202": true });

  store["cooldown.indeed"].until = 0;
  store["budgets.indeed"].lastRunAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
  await background.handleMessage({ type: "START_RUN", siteId: "indeed" }, ownSender);
  state = store["runs.indeed"];
  await background.handleMessage({
    type: "INDEED_RUN_FAILED",
    siteId: "indeed",
    runId: state.runId,
    errorCode: "block_detected",
    message: "Access denied."
  }, tabSender);
  assert.equal(store["cooldown.indeed"].until - store["cooldown.indeed"].lastBlockAt, 48 * 60 * 60 * 1000);

  store["cooldown.indeed"].until = 0;
  store["budgets.indeed"].runsToday = 1;
  store["budgets.indeed"].lastRunAt = new Date().toISOString();

  store["budgets.indeed"].runsToday = 3;
  await assert.rejects(
    background.handleMessage({ type: "START_RUN", siteId: "indeed" }, ownSender),
    /Daily Indeed run limit/
  );
  store["budgets.indeed"].runsToday = 0;
  store["budgets.indeed"].runsToday = 0;
  await background.handleMessage({ type: "START_RUN", siteId: "indeed" }, ownSender);
  state = store["runs.indeed"];
  await background.handleMessage({
    type: "INDEED_PREPARE_NAVIGATION",
    siteId: "indeed",
    runId: state.runId,
    pageNumber: 2,
    searchUrl: "https://in.indeed.com/jobs?q=developer"
  }, tabSender);
  await alarms.onAlarm.emit({ name: `indeed-navigation:${state.runId}` });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store["runs.indeed"].state, "ERROR");
  assert.equal(store["runs.indeed"].terminalReason, "page_load_failed");

  store["runs.indeed"] = {
    siteId: "indeed",
    runId: "stale-indeed-run",
    state: "RUNNING",
    tabId: 17,
    capturedCount: 0,
    lastActionAt: new Date(Date.now() - 16 * 60 * 1000).toISOString()
  };
  await background.recoverStaleRun();
  assert.equal(store["runs.indeed"].state, "ERROR");
  assert.equal(store["runs.indeed"].terminalReason, "stale");
  assert.deepEqual(store["cooldown.linkedin"], linkedinCooldown);
  assert.deepEqual(store["cooldown.naukri"], naukriCooldown);
  store["runs.indeed"] = {
    siteId: "indeed",
    runId: "stale-indeed-navigation",
    state: "RUNNING",
    tabId: 17,
    pageNumber: 2,
    navigationPending: true,
    capturedCount: 0,
    lastActionAt: new Date(Date.now() - 46 * 1000).toISOString()
  };
  await background.recoverStaleRun();
  assert.equal(store["runs.indeed"].state, "ERROR");
  assert.equal(store["runs.indeed"].terminalReason, "page_load_failed");
  assert.deepEqual(store["cooldown.linkedin"], linkedinCooldown);
  assert.deepEqual(store["cooldown.naukri"], naukriCooldown);

  console.log("PASS Indeed background: global lock, site-scoped state/cooldown/kill-switch, stale recovery, limits, dedupe, resume, results-once, and timeout.");
}

Promise.resolve()
  .then(testIndeedRunLoop)
  .then(testIndeedBackground)
  .then(() => console.log("Indeed runtime simulations passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
