"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function run() {
  const messages = [];
  let clock = 0;
  const runState = {
    siteId: "indeed",
    state: "RUNNING",
    runId: "empty-page-run",
    pageNumber: 1,
    capturedCount: 0
  };
  let messageListener;
  const document = {
    title: "",
    body: { innerText: "", textContent: "" },
    visibilityState: "visible",
    querySelector(selector) {
      return selector === "#mosaic-provider-jobcards" ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const window = {
    location: { href: "https://in.indeed.com/jobs?q=developer" },
    innerHeight: 800,
    scrollBy() {},
    addEventListener() {}
  };
  const chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        return { ok: true };
      },
      onMessage: {
        addListener(listener) { messageListener = listener; }
      }
    },
    storage: {
      local: {
        async get(key) {
          return key === "runs.indeed" ? { [key]: runState } : {};
        }
      }
    }
  };
  class FastDate extends Date {
    static now() { return clock; }
  }
  const context = vm.createContext({
    URL,
    Date: FastDate,
    Math,
    document,
    window,
    chrome,
    console,
    setTimeout(callback, milliseconds) {
      clock += milliseconds;
      return global.setTimeout(callback, 0);
    },
    clearTimeout
  });
  for (const file of [
    "src/sites/indeed/config.js",
    "src/sites/indeed/selectors.js",
    "src/sites/indeed/parse.js",
    "src/sites/indeed/adapter.js",
    "src/core/run-loop.js",
    "src/sites/indeed/collector.js"
  ]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }

  assert.equal(typeof messageListener, "function");
  await new Promise((resolve, reject) => {
    const returnedAsync = messageListener(
      { type: "START_RUN", siteId: "indeed", runId: runState.runId },
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

  for (let attempt = 0; attempt < 100 && !messages.some((message) => message.type === "INDEED_RUN_FAILED"); attempt += 1) {
    await new Promise((resolve) => global.setTimeout(resolve, 2));
  }
  const failures = messages.filter((message) => message.type === "INDEED_RUN_FAILED");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorCode, "block_detected");
  assert.match(failures[0].message, /0 job cards on two consecutive checks/);
  console.log("PASS Indeed collector: two consecutive zero-card checks stop the run once as a block.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
