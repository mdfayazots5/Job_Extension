"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

async function run() {
const context = vm.createContext({
  URL,
  Date,
  setTimeout,
  location: { origin: "https://in.indeed.com" }
});
for (const file of [
  "src/sites/indeed/config.js",
  "src/sites/indeed/selectors.js",
  "src/sites/indeed/parse.js",
  "src/sites/indeed/adapter.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

const adapter = context.JobCollectorIndeedAdapter;
const parser = context.JobCollectorIndeedParser;
assert.equal(adapter.limits.maxPages, 50);
assert.equal(adapter.limits.maxJobsPerRun, 500);
assert.equal(adapter.limits.maxJobsPerDay, 5000);
assert.equal(context.JobCollectorIndeedConfig.excludedRoleTerms, undefined);
assert.equal(adapter.shouldSkipRole({ title: "Software Engineer" }), false);
assert.equal(adapter.shouldSkipRole({ title: "Software Engineer" }, ["Software Engineer"]), true);
assert.equal(adapter.shouldSkipRole({ title: " software engineer " }, ["Software Engineer"]), true);
assert.equal(adapter.shouldSkipRole({ title: "Senior Software Engineer" }, ["Software Engineer"]), false);
assert.equal(adapter.shouldSkipRole({ title: "Software Engineer II" }, ["Software Engineer"]), false);
assert.equal(adapter.shouldSkipRole({ title: ".NET Developer" }, [".NET Developer"]), true);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.JobCollectorIndeedConfig.pageDelayMs)),
  { min: 4000, max: 8000 }
);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.JobCollectorIndeedConfig.resumeDelayMs)),
  { min: 2000, max: 5000 }
);
assert.equal(context.JobCollectorIndeedConfig.microPauseEveryPages, 3);
const fixtureDirectory = path.join(__dirname, "..", ".github", "tests", "fixtures");
const fullFixture = new JSDOM(
  fs.readFileSync(path.join(fixtureDirectory, "indeed-serp-full.html"), "utf8"),
  { url: "https://in.indeed.com/jobs?q=developer" }
);
const doc = fullFixture.window.document;
const records = parser.parsePage({ doc });
const fullPageDiagnostics = parser.parsePageWithDiagnostics({ doc });
const jsonMetadata = parser.readJobMetadata(doc);
const jsonResults = [...jsonMetadata.resultsById.values()];
const recordsById = new Map(records.map((record) => [record.jobId, record]));
const mismatches = records
  .filter((record) => typeof record.indeedApplyEnabled === "boolean")
  .filter((record) => record.easyApplyBadge !== record.indeedApplyEnabled)
  .map((record) => record.jobId);

assert.equal(jsonMetadata.warning, null, jsonMetadata.warning || "");
assert.equal(doc.querySelectorAll("#mosaic-provider-jobcards div.job_seen_beacon").length, 32);
assert.deepEqual(
  JSON.parse(JSON.stringify(fullPageDiagnostics.diagnostics)),
  {
    cards: 32,
    matched: 30,
    invalidId: 2,
    matchedEmpty: 0,
    sponsoredNoDate: 0,
    jsonMissing: 0,
    parseError: 0,
    notInResults: 0
  }
);
assert.equal(doc.scripts.length > 0, true);
assert.equal([...doc.scripts].some((script) => (
  script.textContent.includes('window.mosaic.providerData["mosaic-provider-jobcards"] =')
)), true);
assert.equal(records.length, 15);
assert.equal(new Set(records.map((record) => record.jobId)).size, records.length);
assert.equal(recordsById.has("789abcdef0123456"), false);
assert.ok(records.every((record) => record.postedText || record.postedApprox));
assert.ok(records.every((record) => record.applied === false));
assert.equal(recordsById.get("4599c67b6397324f").visited, true);
assert.ok(records.every((record) => typeof record.expired === "boolean"));
assert.ok(records.every((record) => typeof record.saved === "boolean"));
assert.ok(records.every((record) => typeof record.applyCount === "number"));
assert.equal(records.filter((record) => record.easyApplyBadge).length, jsonResults.filter((record) => record.indeedApplyEnabled === true).length);
assert.equal(mismatches.length, 0, `Apply badge/JSON mismatches: ${mismatches.join(", ")}`);
assert.equal(records.some((record) => record.sponsored), false);
assert.ok(records.every((record) => (
  (() => {
    const normalized = adapter.normalize({ ...record, capturedAt: "2026-10-17T12:00:00.000Z" });
    return normalized.postedApprox
      ? normalized.postedText === "30+ days ago" && normalized.postedDateEstimate === null
      : Boolean(normalized.postedDateEstimate);
  })()
)));

const easyRemote = recordsById.get("f7aa12a87283a6a4");
assert.ok(easyRemote);
const capturedAt = "2026-10-17T12:00:00.000Z";
const normalizedEasyRemote = adapter.normalize({ ...easyRemote, capturedAt });
assert.equal(normalizedEasyRemote.applyType, "Easy Apply");
assert.equal(normalizedEasyRemote.postedText, "5 days ago");
assert.equal(normalizedEasyRemote.workMode, "Remote");
assert.equal(
  normalizedEasyRemote.postedDateEstimate,
  new Date(Date.parse(capturedAt) - 5 * 24 * 60 * 60 * 1000).toISOString()
);

const postedDateCases = [
  ["Just posted", capturedAt],
  ["Today", capturedAt],
  ["1 day ago", "2026-10-16T12:00:00.000Z"],
  ["5 days ago", "2026-10-12T12:00:00.000Z"],
  ["30+ days ago", null]
];
for (const [postedText, expectedDate] of postedDateCases) {
  const payload = {
    metaData: {
      mosaicProviderJobCardsModel: {
        results: [{
          jobkey: "0123456789abcdef",
          formattedRelativeTime: postedText,
          pubDate: 946684800000
        }]
      }
    }
  };
  const postedFixture = new JSDOM(`
    <div id="mosaic-provider-jobcards">
      <div class="job_seen_beacon">
        <a class="jcs-JobTitle" data-jk="0123456789abcdef" href="/viewjob?jk=0123456789abcdef">
          <h3 class="jobTitle"><span title="Date Test Role">Date Test Role</span></h3>
        </a>
      </div>
    </div>
    <aside id="jobDescriptionText">100 days ago</aside>
    <script>window.mosaic.providerData["mosaic-provider-jobcards"] = ${JSON.stringify(payload)};</script>
  `, { url: "https://in.indeed.com/jobs?q=date-test" });
  const [parsed] = parser.parsePage({ doc: postedFixture.window.document });
  assert.equal(parsed.postedText, postedText);
  const normalized = adapter.normalize({ ...parsed, capturedAt });
  assert.equal(normalized.postedDateEstimate, expectedDate, `${postedText} estimate`);
  assert.equal(normalized.postedApprox, postedText === "30+ days ago", `${postedText} approximate flag`);
  postedFixture.window.close();
}

const secondsDate = adapter.normalize({
  jobId: "0123456789abcdef",
  pubDate: 1791781200
});
assert.equal(secondsDate.postedDateEstimate, new Date(1791781200000).toISOString());

const singleQuoteFixture = new JSDOM(`
  <div id="mosaic-provider-jobcards">
    <div class="job_seen_beacon">
      <a class="jcs-JobTitle" data-jk="0123456789abcdef" href="/viewjob?jk=0123456789abcdef">
        <h3 class="jobTitle"><span title="Single Quote Role">Single Quote Role</span></h3>
      </a>
    </div>
  </div>
  <script>window.mosaic.providerData['mosaic-provider-jobcards'] = {
    "metaData":{"mosaicProviderJobCardsModel":{"results":[
      {"jobkey":"0123456789abcdef","formattedRelativeTime":"Today","pubDate":1791781200}
    ]}}
  };</script>
`, { url: "https://in.indeed.com/jobs?q=single-quote" });
const [singleQuoteRecord] = parser.parsePage({ doc: singleQuoteFixture.window.document });
assert.equal(singleQuoteRecord.postedText, "Today");
assert.equal(singleQuoteRecord.pubDate, 1791781200);

const olderEasyApply = adapter.normalize(recordsById.get("21576f319e0b9ff2"));
assert.equal(olderEasyApply.applyType, "Easy Apply");
assert.equal(olderEasyApply.postedApprox, true);
assert.equal(olderEasyApply.postedDateEstimate, null);

const companySite = adapter.normalize(recordsById.get("b05d56db1108c908"));
assert.equal(companySite.applyType, "Company Site");

assert.equal(recordsById.get("4599c67b6397324f").salary, "₹50,000 - ₹1,00,000 a month");
assert.equal(
  normalizedEasyRemote.url,
  "https://in.indeed.com/viewjob?jk=f7aa12a87283a6a4"
);
assert.equal(/\/(?:rc\/clk|pagead\/clk|applystart)/i.test(normalizedEasyRemote.url), false);
assert.equal(adapter.ui.applyUrl(normalizedEasyRemote), normalizedEasyRemote.url);

const listFixture = new JSDOM(
  fs.readFileSync(path.join(fixtureDirectory, "indeed-list.html"), "utf8"),
  { url: "https://in.indeed.com/jobs?q=developer" }
);
const domOnlyRecords = parser.parsePage({ doc: listFixture.window.document });
assert.equal(domOnlyRecords.length, 15);
assert.equal(new Set(domOnlyRecords.map((record) => record.jobId)).size, domOnlyRecords.length);
assert.equal(domOnlyRecords.some((record) => record.jobId === "789abcdef0123456"), false);
assert.ok(domOnlyRecords.every((record) => record.postedText === null));
assert.ok(domOnlyRecords.every((record) => record.parseWarning));
assert.ok(domOnlyRecords.every((record) => (
  record.applied === null
  && record.saved === null
  && record.visited === null
  && record.expired === null
  && record.applyCount === null
)));
assert.ok(domOnlyRecords.every((record) => adapter.getSkipReason(record) === null));
const unavailableDateRecord = adapter.normalize({
  ...domOnlyRecords[0],
  capturedAt: "2026-10-17T12:00:00.000Z"
});
assert.equal(unavailableDateRecord.postedText, "Date unavailable");
assert.equal(unavailableDateRecord.postedDateEstimate, null);
assert.equal(unavailableDateRecord.firstSeenAt, "2026-10-17T12:00:00.000Z");
const retryResult = await parser.parsePageWithRetry({
  doc: listFixture.window.document
});
assert.equal(retryResult.records.length, 15);
assert.ok(retryResult.records.every((record) => record.parseWarning.startsWith("jsonMissing:")));
assert.ok(retryResult.records.every((record) => record.title && record.company && record.location));
assert.deepEqual(
  JSON.parse(JSON.stringify(retryResult.diagnostics)),
  {
    cards: 32,
    matched: 0,
    invalidId: 2,
    matchedEmpty: 0,
    sponsoredNoDate: 0,
    jsonMissing: 30,
    parseError: 0,
    notInResults: 0
  }
);
listFixture.window.close();

const pageTwoFixture = new JSDOM(
  fs.readFileSync(path.join(fixtureDirectory, "indeed-serp-full.html"), "utf8"),
  { url: "https://in.indeed.com/jobs?q=developer&start=10" }
);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(pageTwoFixture.window.document.readyState, "complete");
assert.equal(
  [...pageTwoFixture.window.document.scripts].some((script) => (
    script.textContent.includes("mosaic-provider-jobcards")
  )),
  true
);
assert.equal(parser.parsePage({ doc: pageTwoFixture.window.document }).length, 15);
pageTwoFixture.window.close();

const bracePayload = {
  metaData: {
    mosaicProviderJobCardsModel: {
      results: [{
        jobkey: "0123456789abcdef",
        formattedRelativeTime: "Today",
        employerNote: 'Contains {braces} and an escaped quote: "still text"'
      }]
    }
  }
};
const braceFixture = new JSDOM(`
  <div id="mosaic-provider-jobcards">
    <div class="job_seen_beacon">
      <a class="jcs-JobTitle" data-jk="0123456789abcdef" href="/viewjob?jk=0123456789abcdef">
        <h3 class="jobTitle"><span title="Brace Test Role">Brace Test Role</span></h3>
      </a>
    </div>
    <div class="job_seen_beacon">
      <a class="jcs-JobTitle" data-jk="1123456789abcdef" href="/viewjob?jk=1123456789abcdef">
        <h3 class="jobTitle"><span title="Empty Date Role">Empty Date Role</span></h3>
      </a>
    </div>
  </div>
  <script>window.mosaic.providerData["mosaic-provider-jobcards"] = ${JSON.stringify(bracePayload)};</script>
`, { url: "https://in.indeed.com/jobs?q=brace" });
bracePayload.metaData.mosaicProviderJobCardsModel.results.push({
  jobkey: "1123456789abcdef",
  employerNote: "Matched jobkey with no date fields"
});
braceFixture.window.document.scripts[braceFixture.window.document.scripts.length - 1].textContent =
  `window.mosaic.providerData["mosaic-provider-jobcards"] = ${JSON.stringify(bracePayload)};`;
const braceResult = parser.parsePageWithDiagnostics({ doc: braceFixture.window.document });
const braceRecord = braceResult.records[0];
assert.equal(braceRecord.postedText, "Today");
assert.equal(braceResult.diagnostics.matchedEmpty, 1);
assert.match(braceResult.records[1].parseWarning, /formattedRelativeTime is empty/);
assert.equal(
  parser.readJobMetadata(braceFixture.window.document).resultsById
    .get("0123456789abcdef").employerNote,
  bracePayload.metaData.mosaicProviderJobCardsModel.results[0].employerNote
);
braceFixture.window.close();

const sponsoredFixture = new JSDOM(`
  <div id="mosaic-provider-jobcards">
    <div class="job_seen_beacon">
      <a class="jcs-JobTitle" data-jk="858c318db80b7744" href="/pagead/clk?jk=858c318db80b7744">
        <h3 class="jobTitle"><span title="Sponsored Fixture Role">Sponsored Fixture Role</span></h3>
      </a>
      <div data-testid="company-name">Sponsored Co</div>
      <div data-testid="text-location">Remote</div>
    </div>
    <div class="job_seen_beacon">
      <a class="jcs-JobTitle" data-jk="789abcdef0123456" href="/viewjob?jk=789abcdef0123456">
        <h3 class="jobTitle"><span title="Fake Fixture Role">Fake Fixture Role</span></h3>
      </a>
    </div>
  </div>
  <script>window.mosaic.providerData["mosaic-provider-jobcards"] = ${JSON.stringify({
    metaData: { mosaicProviderJobCardsModel: { results: [] } }
  })};</script>
`, { url: "https://in.indeed.com/jobs?q=sponsored" });
const sponsoredParse = parser.parsePageWithDiagnostics({ doc: sponsoredFixture.window.document });
assert.equal(sponsoredParse.records.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(sponsoredParse.diagnostics)),
  {
    cards: 2,
    matched: 0,
    invalidId: 1,
    matchedEmpty: 0,
    sponsoredNoDate: 1,
    jsonMissing: 0,
    parseError: 0,
    notInResults: 0
  }
);
const sponsoredRecord = adapter.normalize({
  ...sponsoredParse.records[0],
  capturedAt: "2026-10-17T12:00:00.000Z"
});
assert.equal(sponsoredRecord.jobId, "858c318db80b7744");
assert.equal(sponsoredRecord.sponsored, true);
assert.equal(sponsoredRecord.postedType, "Unknown");
assert.equal(sponsoredRecord.postedText, null);
assert.equal(sponsoredRecord.postedDateEstimate, null);
sponsoredFixture.window.close();

const syntheticDom = new JSDOM(
  fs.readFileSync(path.join(fixtureDirectory, "indeed-serp-full.html"), "utf8"),
  { url: "https://in.indeed.com/jobs?q=developer" }
);
const syntheticScript = [...syntheticDom.window.document.querySelectorAll("script")]
  .find((candidate) => candidate.textContent.includes('window.mosaic.providerData["mosaic-provider-jobcards"] ='));
const assignment = 'window.mosaic.providerData["mosaic-provider-jobcards"] =';
const syntheticResults = jsonResults.map((result) => ({ ...result }));
const syntheticApplied = syntheticResults
  .find((result) => result.jobkey === easyRemote.jobId);
syntheticApplied.appliedOrGreater = true;
const syntheticPayload = {
  metaData: {
    mosaicProviderJobCardsModel: {
      results: syntheticResults
    }
  }
};
syntheticScript.textContent = `${assignment}${JSON.stringify(syntheticPayload)};`;
const syntheticRecords = parser.parsePage({ doc: syntheticDom.window.document });
const syntheticAppliedRecord = syntheticRecords.find((record) => record.jobId === easyRemote.jobId);
assert.equal(syntheticAppliedRecord.applied, true);
const syntheticSkipTally = { applied: 0, expired: 0 };
const syntheticSkipReason = adapter.getSkipReason(syntheticAppliedRecord);
if (syntheticSkipReason) {
  syntheticSkipTally.applied += Number(syntheticSkipReason.applied);
  syntheticSkipTally.expired += Number(syntheticSkipReason.expired);
}
assert.deepEqual(
  JSON.parse(JSON.stringify(syntheticSkipReason)),
  { applied: true, expired: false }
);
assert.deepEqual(syntheticSkipTally, { applied: 1, expired: 0 });
syntheticDom.window.close();

const malformedJsonFixture = new JSDOM(`
  <div id="mosaic-provider-jobcards">
    <div class="job_seen_beacon">
      <a class="jcs-JobTitle" data-jk="0123456789abcdef" href="/rc/clk?jk=0123456789abcdef">
        <h3 class="jobTitle"><span title="Fallback Role">Fallback Role</span></h3>
      </a>
    </div>
  </div>
  <script>window.mosaic.providerData["mosaic-provider-jobcards"] = {"metaData":};</script>
`, { url: "https://in.indeed.com/jobs?q=fallback" });
const malformedRecords = parser.parsePage({ doc: malformedJsonFixture.window.document });
assert.equal(malformedRecords.length, 1);
assert.equal(malformedRecords[0].postedText, null);
assert.match(malformedRecords[0].parseWarning, /could not be parsed/);
const malformedDiagnostics = parser.parsePageWithDiagnostics({
  doc: malformedJsonFixture.window.document
});
assert.equal(malformedDiagnostics.diagnostics.parseError, 1);
const malformedRetry = await parser.parsePageWithRetry({
  doc: malformedJsonFixture.window.document
});
assert.equal(malformedRetry.records.length, 1);
assert.ok(malformedRetry.records[0].parseWarning.startsWith("parseError:"));

const asyncRecords = await adapter.collectPage({
  doc,
  runId: "indeed-test-run",
  pageNumber: 1,
  collectPageWork() { return records; }
});
assert.equal(asyncRecords.length, records.length);
assert.equal(adapter.matchesUrl(new URL("https://in.indeed.com/jobs?q=developer")), true);
assert.equal(adapter.matchesUrl(new URL("https://in.indeed.com/q-developer-jobs.html")), true);
assert.equal(adapter.matchesUrl(new URL("https://indeed.com/jobs?q=developer")), false);
assert.equal(adapter.getCurrentPage(doc, new URL("https://in.indeed.com/jobs?q=developer&start=20")), 2);
assert.equal(adapter.getCurrentPage(null, new URL("https://in.indeed.com/jobs?q=developer&start=20")), 3);
assert.equal(adapter.hasNextPage(doc), true);
await assert.rejects(
  adapter.goNextPage({ doc, url: new URL("https://in.indeed.com/jobs?q=developer"), pageNumber: 1 }),
  /does not preserve the active \/jobs search/
);
const paginationDom = new JSDOM(
  '<a data-testid="pagination-page-next" href="/jobs?q=developer&start=10">Next</a>',
  { url: "https://in.indeed.com/jobs?q=developer" }
);
let paginationClicks = 0;
paginationDom.window.document.querySelector("a").addEventListener("click", (event) => {
  event.preventDefault();
  paginationClicks += 1;
});
await assert.rejects(
  adapter.goNextPage({
    doc: paginationDom.window.document,
    url: new URL("https://in.indeed.com/jobs?q=developer"),
    pageNumber: 1
  }),
  /requires persisted navigation state/
);
let preparedPage = 0;
assert.equal(await adapter.goNextPage({
  doc: paginationDom.window.document,
  url: new URL("https://in.indeed.com/jobs?q=developer"),
  pageNumber: 1,
  async prepareNavigation(page) { preparedPage = page; }
}), "navigated");
assert.equal(preparedPage, 2);
assert.equal(paginationClicks, 1);

console.log(`PASS DOM job-card nodes deduplicated to ${records.length} valid records; placeholder excluded`);
console.log(`PASS JSON results: ${jsonResults.length}; badge/API apply mismatches: ${mismatches.length}`);
console.log("PASS Indeed normalization, canonical URLs, DOM-only fallback, and adapter contract");

fullFixture.window.close();
listFixture.window.close();
malformedJsonFixture.window.close();
singleQuoteFixture.window.close();
paginationDom.window.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
