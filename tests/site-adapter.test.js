"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = vm.createContext({
  URL,
  window: {
    location: { href: "https://www.linkedin.com/jobs/search-results/" },
    getComputedStyle() {
      return { display: "block", visibility: "visible", opacity: "1", overflowY: "auto" };
    }
  }
});
for (const file of [
  "config.js",
  "src/sites/linkedin/selectors.js",
  "src/sites/linkedin/metadata.js",
  "src/sites/linkedin/adapter.js",
  "src/sites/indeed/config.js",
  "src/sites/indeed/selectors.js",
  "src/sites/indeed/parse.js",
  "src/sites/indeed/adapter.js",
  "src/sites/registry.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

const adapter = context.JobCollectorSiteRegistry.getAdapter("linkedin");
assert.equal(adapter.id, "linkedin");
assert.equal(adapter.label, "LinkedIn");
assert.equal(
  adapter.matchesUrl(new URL("https://www.linkedin.com/jobs/search-results/?keywords=engineer")),
  true
);
assert.equal(
  adapter.matchesUrl(new URL("https://www.linkedin.com/jobs/view/123/")),
  false
);
assert.deepEqual(
  JSON.parse(JSON.stringify(adapter.normalize({ jobId: "123", title: "Engineer" }))),
  {
    jobId: "123",
    title: "Engineer",
    siteId: "linkedin",
    url: "https://www.linkedin.com/jobs/view/123/"
  }
);
assert.equal(
  adapter.ui.applyUrl({
    jobId: "123",
    applyType: "Company Site",
    companyApplyUrl: "https://careers.example/jobs/123"
  }),
  "https://careers.example/jobs/123"
);
assert.equal(
  adapter.ui.applyUrl({
    jobId: "123",
    applyType: "Company Site",
    companyApplyUrl: "javascript:alert(1)"
  }),
  "https://www.linkedin.com/jobs/view/123/"
);
assert.deepEqual(
  JSON.parse(JSON.stringify(adapter.ui.tabs)),
  [
    { id: "Easy Apply", label: "Easy Apply" },
    { id: "Company Site", label: "Company Apply" }
  ]
);
const indeedAdapter = context.JobCollectorSiteRegistry.getAdapter("indeed");
assert.equal(indeedAdapter.label, "Indeed");
assert.equal(
  context.JobCollectorSiteRegistry.getAdapterForUrl("https://in.indeed.com/jobs?q=developer"),
  indeedAdapter
);
assert.equal(
  context.JobCollectorSiteRegistry.getAdapterForUrl("https://in.indeed.com/jobs"),
  null
);
console.log("Site-adapter tests passed: LinkedIn behavior and Indeed search URL routing.");
