"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const context = vm.createContext({ URL, Date });
for (const file of [
  "src/sites/naukri/config.js",
  "src/sites/naukri/selectors.js",
  "src/sites/naukri/adapter.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

const selectors = context.JobCollectorNaukriSelectors;
const adapter = context.JobCollectorNaukriAdapter;
const fixturePath = path.join(__dirname, "fixtures", "naukri-search-results.html");
const fixture = new JSDOM(fs.readFileSync(fixturePath, "utf8"));
const capturedAt = "2026-10-17T10:32:40.983Z";
const records = adapter.parsePage({ doc: fixture.window.document, capturedAt });
const failures = [];

function check(label, actual, expected, raw) {
  try {
    const comparable = actual !== null && typeof actual === "object"
      ? JSON.parse(JSON.stringify(actual))
      : actual;
    assert.deepEqual(comparable, expected);
    console.log(`PASS ${label}`);
  } catch (_error) {
    const detail = `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; raw=${JSON.stringify(raw)}`;
    failures.push(detail);
    console.error(`FAIL ${detail}`);
  }
}

check("fixture yields exactly 20 result records", records.length, 20, String(records.length));
check(
  "fixture result IDs contain no duplicates",
  new Set(records.map((record) => record.jobId)).size,
  records.length,
  records.map((record) => record.jobId).join(", ")
);
check(
  "widget and promo cards are excluded",
  records.some((record) => record.jobId === "promo-widget" || record.jobId === "similar-promo"),
  false,
  `result wrappers=${records.length}; all wrappers=${fixture.window.document.querySelectorAll(".srp-jobtuple-wrapper[data-job-id]").length}`
);

function assertExpectedRecord(jobId, fields) {
  const record = records.find((candidate) => candidate.jobId === jobId);
  if (!record) {
    for (const [field, expected] of Object.entries(fields)) {
      check(`${jobId}.${field}`, undefined, expected, null);
    }
    return;
  }
  for (const [field, expected] of Object.entries(fields)) {
    check(`${jobId}.${field}`, record[field], expected, record[field]);
  }
}

assertExpectedRecord("021026012531", {
  walkIn: true,
  walkInDates: "03 Oct - 24 Oct",
  salary: "4-6.5 Lacs PA"
});
assertExpectedRecord("161026017170", {
  company: "Siemens Healthcare",
  postedBy: "Sunovaa Tech"
});
assertExpectedRecord("131026921932", {
  company: "Leading Client",
  postedBy: "Tekskills"
});
assertExpectedRecord("100826024367", {
  workMode: "Hybrid",
  locations: ["Bengaluru", "Pune", "Chennai"]
});
assertExpectedRecord("100625501151", { postedApprox: true });

const modernHtml = `<div class="jobTuple" data-job-id="modern-1">
  <div class="jobTuple-title"><a href="/job-listings-modern-role-123?src=fixture">Modern .NET Developer</a></div>
  <div class="companyName">Modern Systems</div>
  <div class="postedBy">Posted by Modern Consult</div>
  <img class="companyLogo" src="/images/logo.png">
  <div class="experience"><span>3-5 Yrs</span></div>
  <div class="salary"><span>10-15 Lacs PA</span></div>
  <div class="location"><span title="Hybrid - Hyderabad, Bengaluru">Hybrid - Hyderabad, Bengaluru</span></div>
  <ul class="keySkills"><li>ASP.NET</li><li>SQL</li></ul>
  <div class="posted-date">2 days ago</div>
</div>`;
const modernRecord = adapter.parsePage({ doc: new JSDOM(modernHtml).window.document, capturedAt })[0];
check("modern card title is parsed", modernRecord.title, "Modern .NET Developer", modernRecord.title);
check("modern card company is parsed", modernRecord.company, "Modern Systems", modernRecord.company);
check("modern card postedBy is parsed", modernRecord.postedBy, "Modern Consult", modernRecord.postedBy);
check("modern card experience is parsed", modernRecord.experience, "3-5 Yrs", modernRecord.experience);
check("modern card work mode and locations are parsed", { workMode: modernRecord.workMode, locations: modernRecord.locations }, { workMode: "Hybrid", locations: ["Hyderabad", "Bengaluru"] }, modernRecord.locationRaw);
check("modern card salary is parsed", modernRecord.salary, "10-15 Lacs PA", modernRecord.salary);
check("modern card skill list is parsed", modernRecord.skills, ["ASP.NET", "SQL"], modernRecord.skills);
check("modern card posted date is estimated", modernRecord.postedDateEstimate, "2026-10-15T10:32:40.983Z", modernRecord.postedText);
const cardFlagRecords = adapter.parsePage({
  doc: new JSDOM(`
    <div class="srp-jobtuple-wrapper" data-job-id="company" data-company-apply-job="true">
      <a class="title" href="/company-job">Company apply role</a>
    </div>
    <div class="srp-jobtuple-wrapper" data-job-id="easy" data-company-apply-job="false">
      <a class="title" href="/easy-job">Easy apply role</a>
    </div>
  `).window.document,
  capturedAt
});
check(
  "companyApplyJob flags already on result cards are captured",
  cardFlagRecords.map((record) => record.companyApplyJob),
  [true, false],
  cardFlagRecords
);

const syntheticHtml = `<div class="srp-jobtuple-wrapper" data-job-id="synthetic-1">
  <a class="title" href="/job-listings-role-123?tracking=ignored">Synthetic Role</a>
  <div class="comp-name">Example Company</div>
  <div class="client-company-name">Posted by Example Consultant</div>
  <img class="logoImage" src="/images/no-logo-placeholder.png">
  <div class="exp-wrap"><span>2-4 Yrs</span></div>
  <div class="sal-wrap"><span>4-6.5 Lacs PA</span></div>
  <div class="loc-wrap"><span title="Hybrid - Bengaluru, Pune, Chennai ">Locations</span></div>
  <ul class="tags-gt"><li>Java</li><li>Cloud</li></ul>
  <span class="ttc__walk-in">Walk-in</span>
  <span class="walkDateWdth">03 Oct - 24 Oct</span>
  <span class="job-post-day">1+ weeks ago</span>
</div>
<div class="naukri-wdgt-section">
  <div class="cust-job-tuple">Widget promotion</div>
  <div class="srp-jobtuple-wrapper" data-job-id="widget-should-not-appear">
    <a class="title" href="/widget">Widget card</a>
  </div>
</div>
<div class="similar-jobs"><div class="cust-job-tuple">Similar job promotion</div></div>`;
const syntheticDoc = new JSDOM(syntheticHtml).window.document;
const syntheticRecords = adapter.parsePage({ doc: syntheticDoc, capturedAt });
check("synthetic widget wrappers are excluded", syntheticRecords.length, 1, String(syntheticRecords.length));

const synthetic = syntheticRecords[0];
check("synthetic card uses title text", synthetic.title, "Synthetic Role", synthetic.title);
check("synthetic URL query is removed", synthetic.url, "https://www.naukri.com/job-listings-role-123", synthetic.url);
check("synthetic postedBy prefix is removed", synthetic.postedBy, "Example Consultant", synthetic.postedBy);
check("placeholder logo becomes null", synthetic.logo, null, "/images/no-logo-placeholder.png");
check("salary is parsed", synthetic.salary, "4-6.5 Lacs PA", synthetic.salary);
check(
  "work mode and locations are parsed",
  { workMode: synthetic.workMode, locations: synthetic.locations },
  { workMode: "Hybrid", locations: ["Bengaluru", "Pune", "Chennai"] },
  synthetic.locationRaw
);
check("walk-in dates are parsed", synthetic.walkInDates, "03 Oct - 24 Oct", synthetic.walkInDates);
check("N+ weeks is approximate", synthetic.postedApprox, true, synthetic.postedText);
check("N+ weeks is estimated from capture time", synthetic.postedDateEstimate, "2026-10-10T10:32:40.983Z", synthetic.postedText);
check("posted type is Posted", synthetic.postedType, "Posted", synthetic.postedType);
check("apply type is Naukri", synthetic.applyType, "Naukri", synthetic.applyType);
check("missing API flag stays unclassified in raw record", synthetic.companyApplyJob, null, synthetic.companyApplyJob);
check("false companyApplyJob maps to Easy Apply", adapter.ui.tabFor({ companyApplyJob: false }), "Easy Apply", false);
check("true companyApplyJob maps to Company Apply", adapter.ui.tabFor({ companyApplyJob: true }), "Company Apply", true);
check(
  "questionnaireIdPresent true maps to Easy Apply",
  adapter.ui.tabFor({ companyApplyJob: false, questionnaireIdPresent: true }),
  "Easy Apply",
  true
);
check(
  "questionnaireIdPresent false maps to Direct Apply",
  adapter.ui.tabFor({ companyApplyJob: false, questionnaireIdPresent: false }),
  "Direct Apply",
  false
);
check(
  "company application takes precedence over questionnaire presence",
  adapter.ui.tabFor({ companyApplyJob: true, questionnaireIdPresent: true }),
  "Company Apply",
  "companyApplyJob=true"
);
check(
  "Naukri exposes Easy, Direct, and Company Apply tabs",
  adapter.ui.tabs.map((tab) => tab.id),
  ["Easy Apply", "Direct Apply", "Company Apply"],
  adapter.ui.tabs
);
check("apply URL is the record URL", adapter.ui.applyUrl(synthetic), synthetic.url, synthetic.url);
check(
  "Company Apply uses Naukri's applyRedirectUrl",
  adapter.ui.applyUrl({
    ...synthetic,
    companyApplyJob: true,
    applyType: "Company Apply",
    applyRedirectUrl: "https://company.example/apply?job=123&source=naukri"
  }),
  "https://company.example/apply?job=123&source=naukri",
  "applyRedirectUrl"
);
check(
  "invalid applyRedirectUrl falls back to the job listing",
  adapter.ui.applyUrl({
    ...synthetic,
    companyApplyJob: true,
    applyRedirectUrl: "javascript:alert(1)"
  }),
  synthetic.url,
  "unsafe applyRedirectUrl"
);
check(
  "API apply flags and redirect URLs are indexed by job ID",
  adapter.parseApplicationDetails({
    jobDetails: [
      {
        jobId: "1001",
        companyApplyJob: true,
        questionnaireIdPresent: false,
        applyRedirectUrl: "https://company.example/apply?id=1001"
      },
      { jobId: "1002", companyApplyJob: false, questionnaireIdPresent: true },
      { jobId: "1003", companyApplyJob: false, questionnaireIdPresent: false }
    ]
  }),
  {
    "1001": {
      companyApplyJob: true,
      questionnaireIdPresent: false,
      applyRedirectUrl: "https://company.example/apply?id=1001"
    },
    "1002": {
      companyApplyJob: false,
      questionnaireIdPresent: true,
      applyRedirectUrl: null
    },
    "1003": {
      companyApplyJob: false,
      questionnaireIdPresent: false,
      applyRedirectUrl: null
    }
  },
  "jobDetails"
);
assert.throws(
  () => adapter.parseApplicationDetails({ jobDetails: [{ jobId: "1003" }] }),
  /missing the companyApplyJob flag/
);
assert.throws(
  () => adapter.parseApplicationDetails({}),
  /does not contain a jobDetails list/
);
check(
  "normalized API record retains apply classification",
  adapter.normalize({ jobId: "1004", companyApplyJob: true }).applyType,
  "Company Apply",
  "companyApplyJob=true"
);
check(
  "normalized questionnaire response retains Direct Apply classification",
  adapter.normalize({
    jobId: "1005",
    companyApplyJob: false,
    questionnaireIdPresent: false
  }).applyType,
  "Direct Apply",
  "questionnaireIdPresent=false"
);

const noSalaryHtml = `<div class="srp-jobtuple-wrapper" data-job-id="salary-null">
  <a class="title" href="/job">Role</a>
  <div class="sal-wrap"><span>Not disclosed</span></div>
  <div class="loc-wrap"><span title="Pune">Pune</span></div>
  <span class="job-post-day">Today</span>
</div>`;
const noSalaryRecord = adapter.parsePage({
  doc: new JSDOM(noSalaryHtml).window.document,
  capturedAt
})[0];
check("Not disclosed salary becomes null", noSalaryRecord.salary, null, "Not disclosed");
check("Today estimates to capture timestamp", noSalaryRecord.postedDateEstimate, capturedAt, "Today");

const placeholderWidget = syntheticDoc.querySelector(selectors.SELECTORS.excludedContainers);
check(
  "Naukri URL matching is scoped to the jobs site",
  adapter.matchesUrl(new URL("https://www.naukri.com/dot-net-developer-jobs")),
  true,
  "https://www.naukri.com/jobs/"
);
check(
  "Next anchor indicates a following page",
  adapter.hasNextPage(new JSDOM('<div id="lastCompMark"><a>Next</a></div>').window.document),
  true,
  '<a>Next</a>'
);
check(
  "accessible Next control indicates a following page",
  adapter.hasNextPage(new JSDOM("<button aria-label='Next page'>›</button>").window.document),
  true,
  "button aria-label=Next page"
);
check(
  "disabled Next anchor indicates last page",
  adapter.hasNextPage(new JSDOM('<div id="lastCompMark"><a disabled>Next</a></div>').window.document),
  false,
  '<a disabled>Next</a>'
);
check(
  "missing Next anchor indicates last page",
  adapter.hasNextPage(new JSDOM('<div id="lastCompMark"><a>Previous</a></div>').window.document),
  false,
  '<a>Previous</a>'
);
check(
  "selected pagination link reports current page",
  adapter.getCurrentPage(
    new JSDOM('<div id="lastCompMark"><a class="selected">2</a></div>').window.document,
    new URL("https://www.naukri.com/dot-net-developer-jobs")
  ),
  2,
  'a.selected text="2"'
);
check(
  "URL trailing page number is fallback",
  adapter.getCurrentPage(
    new JSDOM("<div></div>").window.document,
    new URL("https://www.naukri.com/dot-net-developer-jobs-3")
  ),
  3,
  "dot-net-developer-jobs-3"
);
check(
  "access denied page is detected",
  adapter.detectBlock(
    new JSDOM("<title>Access Denied</title><body></body>").window.document,
    new URL("https://www.naukri.com/dot-net-developer-jobs")
  ),
  "Naukri access block detected in page content.",
  "Access Denied"
);
check("expected widget fixture exists", Boolean(placeholderWidget), true, placeholderWidget && placeholderWidget.className);

if (failures.length) {
  console.error(`Naukri fixture contract failures: ${failures.length}`);
  process.exitCode = 1;
} else {
  console.log("Naukri adapter tests passed: fixture contract and parsing cases.");
}
