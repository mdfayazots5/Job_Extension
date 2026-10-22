"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const dom = new JSDOM(`
  <section id="detail-pane">
    <a href="/company/information-services-group/life/"></a>
    <a href="/company/information-services-group/life/">
      <img src="https://media.example/isg-logo.png" alt="">
    </a>
    <a href="/company/information-services-group/life/">ISG (Information Services Group)</a>
  </section>
`, { url: "https://www.linkedin.com/jobs/search-results/" });
const context = vm.createContext({
  URL,
  document: dom.window.document,
  window: dom.window
});
vm.runInContext(
  fs.readFileSync("src/sites/linkedin/selectors.js", "utf8"),
  context,
  { filename: "src/sites/linkedin/selectors.js" }
);

const selectors = context.JobCollectorSelectors;
const pane = dom.window.document.getElementById("detail-pane");
const errors = [];
const companyLink = selectors.getDetailCompanyLink(pane, errors);

assert.equal(selectors.getDetailCompanyName(pane, errors), "ISG (Information Services Group)");
assert.equal(selectors.getDetailCompanyLogoUrl(companyLink, errors), "https://media.example/isg-logo.png");
assert.deepEqual(errors, []);
console.log("LinkedIn selector tests passed: company name and logo are found when empty company links precede them.");
