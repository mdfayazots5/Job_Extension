"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

let messageListener = null;
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
    querySelector() { return null; },
    querySelectorAll() { return []; }
  },
  window: {
    location: { href: "https://www.naukri.com/dot-net-developer-jobs" },
    addEventListener() {},
    scrollBy() {}
  },
  chrome: {
    runtime: {
      sendMessage: async () => ({ ok: true, resume: false }),
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
console.log("Naukri content script PING acknowledges an installed script even before result cards are ready.");
