"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let messageListener = null;
let documentClickListener = null;
let testCards = [];
const runtimeMessages = [];
const titleSelectors = [
  "a.title",
  "a[href*='/job-listings']",
  ".jobTuple-title a",
  ".jobTitle a",
  ".job-title a",
  "h2 a",
  "a[href*='job-listings']"
];
const context = vm.createContext({
  URL,
  Date,
  Math,
  console,
  document: {
    title: "Naukri results",
    body: { innerText: "Search results" },
    readyState: "complete",
    visibilityState: "visible",
    addEventListener(type, listener) {
      if (type === "click") {
        documentClickListener = listener;
      }
    },
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector.startsWith(".srp-jobtuple-wrapper[data-job-id]")
        || selector.startsWith(".jobTuple[data-job-id]")
        || selector.startsWith(".jobTupleWrapper[data-job-id]")
        || selector.startsWith(".jobtuple-wrapper[data-job-id]")
        || selector.startsWith(".job-card[data-job-id]")
        || selector.startsWith("[data-job-id].jobTuple")
        || selector.startsWith("[data-job-id].job-card")
        || selector.startsWith("[data-job-id].jobTupleWrapper")
        ? testCards
        : [];
    }
  },
  window: {
    location: { href: "https://www.naukri.com/dot-net-developer-jobs" },
    addEventListener() {},
    scrollBy() {}
  },
  chrome: {
    runtime: {
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        return { ok: true, resume: false };
      },
      onMessage: {
        addListener(listener) { messageListener = listener; }
      }
    },
    storage: {
      local: {
        async get() { return {}; }
      }
    }
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
});

for (const file of [
  "src/sites/naukri/config.js",
  "src/sites/naukri/selectors.js",
  "src/sites/naukri/adapter.js",
  "src/core/run-loop.js",
  "src/sites/naukri/collector.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

function ping(siteId) {
  let response;
  messageListener({ type: "PING", siteId }, {}, (value) => {
    response = value;
  });
  return response;
}

assert.deepEqual(JSON.parse(JSON.stringify(ping("naukri"))), {
  ok: true,
  ready: false,
  error: "Open a Naukri search results page to start."
});
assert.equal(ping("linkedin").ok, false);
assert.equal(typeof documentClickListener, "function");

let titleLink;
const jobCard = {
  getAttribute(name) {
    return name === "data-job-id" ? "021026012531" : null;
  },
  closest() { return null; },
  contains(element) { return element === titleLink; },
  querySelector(selector) {
    return titleSelectors.includes(selector) ? titleLink : null;
  },
  querySelectorAll(selector) {
    return titleSelectors.includes(selector) ? [titleLink] : [];
  }
};
titleLink = {
  nodeType: 1,
  closest(selector) { return selector === "a" ? titleLink : null; }
};
testCards = [jobCard];
documentClickListener({
  defaultPrevented: false,
  target: titleLink
});

setImmediate(() => {
  assert.ok(runtimeMessages.some((message) => (
    message.type === "SYNC_JOB_STATUSES"
    && message.siteId === "naukri"
    && message.updates[0].jobId === "021026012531"
    && message.updates[0].opened === true
  )));
  console.log("Naukri content script acknowledges installation and persists opened status for user-opened job titles.");
});
