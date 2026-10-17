"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function load(context, files) {
  for (const file of files) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
}

function assertAdapterContract(adapter) {
  assert.equal(typeof adapter.id, "string");
  assert.equal(typeof adapter.label, "string");
  for (const method of ["matchesUrl", "detectBlock", "getCurrentPage", "collectPage", "hasNextPage", "goNextPage", "normalize"]) {
    assert.equal(typeof adapter[method], "function", `${adapter.id}.${method}`);
  }
  assert.ok(adapter.limits && typeof adapter.limits === "object");
  assert.ok(adapter.ui && typeof adapter.ui === "object");
  assert.equal(typeof adapter.ui.applyUrl, "function");
  assert.equal(typeof adapter.ui.accent, "string");
  assert.ok(Array.isArray(adapter.ui.tabs));
  assert.ok(Array.isArray(adapter.ui.columns));
}

const active = vm.createContext({ URL, window: { location: { href: "https://www.linkedin.com/jobs/search-results/" } } });
load(active, [
  "config.js",
  "src/sites/linkedin/selectors.js",
  "src/sites/linkedin/metadata.js",
  "src/sites/linkedin/adapter.js",
  "src/sites/naukri/config.js",
  "src/sites/naukri/selectors.js",
  "src/sites/naukri/adapter.js"
]);
assertAdapterContract(active.JobCollectorLinkedInAdapter);
assertAdapterContract(active.JobCollectorNaukriAdapter);

const indeed = vm.createContext({});
load(indeed, ["src/sites/indeed/selectors.js", "src/sites/indeed/adapter.js"]);
assert.equal(indeed.JobCollectorIndeedAdapter.id, "indeed");
assert.equal(indeed.JobCollectorIndeedAdapter.label, "Indeed");
assert.throws(() => indeed.JobCollectorIndeedAdapter.matchesUrl(new URL("https://indeed.example/")), /not implemented/);
console.log("Site adapter contract tests passed: active adapters conform; Indeed is an expected unimplemented stub.");
