"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

async function run() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync("src/core/run-loop.js", "utf8"), context);
  const loop = context.JobCollectorRunLoop;
  const pages = [];
  const progress = [];
  const finalized = [];
  let livePage = 1;
  const adapter = {
    limits: { maxPages: 3, maxJobsPerRun: 50 },
    async collectPage({ pageNumber }) {
      pages.push(pageNumber);
      return { capturedCount: pageNumber };
    },
    getCurrentPage() {
      return livePage;
    },
    hasNextPage() {
      return livePage < 2;
    },
    async goNextPage({ setNextPage }) {
      livePage += 1;
      setNextPage(livePage, {});
      return "inplace";
    }
  };
  const contextForRun = {
    doc: {},
    url: new URL("https://example.test/jobs"),
    pageNumber: 1,
    ensureVisible: async () => {},
    checkBlock() {},
    async readStats() {
      return { capturedCount: pages.length };
    },
    async writeProgress(pageNumber, _stats, phase) {
      progress.push([pageNumber, phase]);
    },
    async finish(pageNumber, stats) {
      finalized.push([pageNumber, stats.capturedCount]);
    },
    getContainer() {
      return {};
    },
    setPage() {},
    setNextPage(pageNumber) {
      contextForRun.nextPageNumber = pageNumber;
    },
    onPage() {}
  };
  const completed = await loop.run(adapter, contextForRun);
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(progress, [[1, "RUNNING"], [1, "PAGINATING"], [2, "RUNNING"]]);
  assert.deepEqual(finalized, [[2, 2]]);
  assert.equal(completed.navigation, "none");

  let navigationCollects = 0;
  const navigatedAdapter = {
    limits: { maxPages: 4, maxJobsPerRun: 50 },
    async collectPage() {
      navigationCollects += 1;
      return { capturedCount: 1 };
    },
    getCurrentPage() {
      return 1;
    },
    hasNextPage() {
      return true;
    },
    async goNextPage() {
      return "navigated";
    }
  };
  const navigated = await loop.run(navigatedAdapter, {
    ...contextForRun,
    pageNumber: 1,
    nextPageNumber: undefined,
    setPage() {},
    setNextPage() {}
  });
  assert.equal(navigationCollects, 1);
  assert.equal(navigated.pageNumber, 2);
  assert.equal(navigated.navigation, "navigated");

  let historicalRecordCollectionCalls = 0;
  const historicalRecordAdapter = {
    limits: { maxPages: 1, maxJobsPerRun: 500 },
    async collectPage() {
      historicalRecordCollectionCalls += 1;
      return { capturedCount: 515 };
    },
    getCurrentPage() {
      return 1;
    },
    hasNextPage() {
      return false;
    },
    async goNextPage() {
      return "none";
    }
  };
  let runCapturedCount = 0;
  const historicalRecordContext = {
    ...contextForRun,
    pageNumber: 1,
    async readStats() {
      return { capturedCount: 515 };
    },
    async readRunCapturedCount() {
      return runCapturedCount;
    },
    async finish() {},
    setPage() {}
  };
  await loop.run(historicalRecordAdapter, historicalRecordContext);
  assert.equal(historicalRecordCollectionCalls, 1);

  runCapturedCount = 500;
  await loop.run(historicalRecordAdapter, historicalRecordContext);
  assert.equal(historicalRecordCollectionCalls, 1);
  console.log("Run-loop tests passed: adapter-owned collection and both pagination modes.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
