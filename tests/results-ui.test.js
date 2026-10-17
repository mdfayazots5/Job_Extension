"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.style = { setProperty() {} };
    this.className = "";
    this.value = "";
    this.hidden = false;
    this.checked = false;
    this.href = "";
    this.target = "";
    this.rel = "";
    this._text = "";
    this.tabIndex = 0;
    this.focused = false;
    this.clickCount = 0;
    this.classList = {
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force) classes.add(name);
        else classes.delete(name);
        this.className = Array.from(classes).join(" ");
      }
    };
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._text = String(value);
    this.children.forEach((child) => {
      child.parentElement = null;
    });
    this.children = [];
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this._text = "";
    this.children.forEach((child) => {
      child.parentElement = null;
    });
    children.forEach((child) => {
      child.parentElement = this;
    });
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }

  focus() {
    this.focused = true;
  }

  closest() {
    return this;
  }

  async dispatch(name, event = {}) {
    const dispatched = {
      ...event,
      target: event.target || this,
      currentTarget: this,
      preventDefault: event.preventDefault || (() => {}),
      stopPropagation: event.stopPropagation || (() => {})
    };
    return this.listeners[name]?.(dispatched);
  }

  click() {
    this.clickCount += 1;
    return this.dispatch("click");
  }

  remove() {}
}

function createPage(storage, search = "") {
  const legacyJobs = storage.jobsById || {};
  storage.records = {
    ...(storage.records || {}),
    ...Object.fromEntries(Object.entries(legacyJobs).map(([jobId, record]) => [
      `linkedin:${jobId}`,
      record
    ]))
  };
  storage["opened.linkedin"] = storage["opened.linkedin"] || storage.openedJobsById || {};
  storage["runs.linkedin"] = storage["runs.linkedin"] || storage.collectorState || null;
  storage["ui.linkedin.selectedTab"] = storage["ui.linkedin.selectedTab"]
    || storage.resultsSelectedTab
    || null;
  const ids = [
    "easy-tab",
    "direct-tab",
    "company-tab",
    "linkedin-site",
    "naukri-site",
    "indeed-site",
    "linkedin-site-count",
    "naukri-site-count",
    "indeed-site-count",
    "site-switcher",
    "results-panel",
    "column-headings",
    "job-table-body",
    "empty-state",
    "search",
    "search-label",
    "applicant-review-filter",
    "hide-opened",
    "hide-visited",
    "hide-visited-control",
    "hide-sponsored",
    "hide-sponsored-control",
    "role-sort",
    "company-sort",
    "posted-sort",
    "role-header",
    "company-header",
    "posted-header",
    "run-subtitle",
    "site-run-footer",
    "indeed-skipped-footer",
    "dates-footer",
    "parse-warning-footer",
    "total-count",
    "skipped-count",
    "feedback"
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement("div", id)]));
  elements.get("hide-sponsored").checked = new URLSearchParams(search).get("site") === "indeed";
  const storageListeners = [];
  const downloadedFiles = [];
  const blobsByUrl = new Map();
  class TestURL extends URL {}
  TestURL.createObjectURL = (blob) => {
    const href = `blob:collector-test/${blobsByUrl.size + 1}`;
    blobsByUrl.set(href, blob);
    return href;
  };
  TestURL.revokeObjectURL = (href) => blobsByUrl.delete(href);
  const document = {
    body: new FakeElement("body"),
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      Object.defineProperty(element, "id", {
        get() { return this._id || ""; },
        set(value) {
          this._id = value;
          if (value) elements.set(value, this);
        }
      });
      if (tagName.toLowerCase() === "a") {
        element.click = () => {
          if (element.download) {
            downloadedFiles.push({
              filename: element.download,
              blob: blobsByUrl.get(element.href)
            });
            return;
          }
          return FakeElement.prototype.click.call(element);
        };
      }
      return element;
    }
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys
              .filter((key) => Object.prototype.hasOwnProperty.call(storage, key))
              .map((key) => [key, storage[key]]));
          }
          return Object.prototype.hasOwnProperty.call(storage, keys)
            ? { [keys]: storage[keys] }
            : {};
        },
        async set(updates) {
          const changes = {};
          for (const [key, newValue] of Object.entries(updates)) {
            changes[key] = { oldValue: storage[key], newValue };
            storage[key] = newValue;
          }
          for (const listener of storageListeners) {
            listener(changes, "local");
          }
        }
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        }
      }
    }
  };
  const context = vm.createContext({
    document,
    chrome,
    URL: TestURL,
    URLSearchParams,
    Blob,
    location: {
      search,
      href: `https://extension.test/results.html${search}`,
      assign(href) { this.assignedHref = href; }
    },
    setTimeout() { return 1; },
    Intl,
    Date,
    console
  });
  for (const file of [
    "config.js",
    "src/core/storage.js",
    "src/sites/linkedin/selectors.js",
    "src/sites/linkedin/metadata.js",
    "src/sites/linkedin/adapter.js",
    "src/sites/naukri/config.js",
    "src/sites/naukri/selectors.js",
    "src/sites/naukri/adapter.js",
    "src/sites/indeed/config.js",
    "src/sites/indeed/selectors.js",
    "src/sites/indeed/parse.js",
    "src/sites/indeed/adapter.js",
    "src/sites/registry.js"
  ]) {
    vm.runInContext(
      fs.readFileSync(file, "utf8"),
      context,
      { filename: file }
    );
  }
  vm.runInContext(
    fs.readFileSync("results.js", "utf8"),
    context,
    { filename: "results.js" }
  );
  return {
    elements,
    storage,
    location: context.location,
    downloadedFiles,
    blobsByUrl,
    updateStorage(key, value) {
      return chrome.storage.local.set({ [key]: value });
    }
  };
}

function findAll(element, predicate, found = []) {
  if (predicate(element)) {
    found.push(element);
  }
  for (const child of element.children) {
    findAll(child, predicate, found);
  }
  return found;
}

function job(jobId, applyType, overrides = {}) {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: `Company ${jobId}`,
    location: "Remote",
    url: `https://www.linkedin.com/jobs/view/${jobId}/?tracking=ignored`,
    applyType,
    companyApplyUrl: null,
    companyLogoUrl: null,
    postedType: "Posted",
    postedText: "2 days ago",
    postedDateEstimate: "2026-10-14",
    capturedAt: "2026-10-16T12:00:00.000Z",
    pageNumber: 1,
    ...overrides
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function run() {
  const storage = {
    jobsById: {
      "101": job("101", "Easy Apply", {
        title: '<img src=x onerror="alert(1)"> Engineer 😊',
        company: "Zeta",
        applicantReviewStatus: "actively-reviewing",
        url: "https://www.linkedin.com/jobs/view/101/?tracking=ignored"
      }),
      "102": job("102", "Easy Apply", { company: "Alpha" }),
      "201": job("201", "Company Site", {
        company: "Beta",
        companyApplyUrl: null
      }),
      "301": job("301", "Unknown")
    },
    openedJobsById: {},
    collectorState: { startedAt: "2026-10-16T12:00:00.000Z", state: "RUNNING" },
    resultsSelectedTab: "Easy Apply"
  };
  const { elements, updateStorage } = createPage(storage);
  await settle();
  assert.equal(elements.get("easy-tab").textContent, "Easy Apply (2)");
  assert.equal(elements.get("company-tab").textContent, "Company Apply (1)");
  assert.equal(elements.get("total-count").textContent, "4 jobs");
  assert.equal(elements.get("skipped-count").textContent, "1 skipped (no apply option)");
  assert.equal(elements.get("results-panel").attributes["aria-labelledby"], "easy-tab");

  let rows = elements.get("job-table-body").children;
  assert.equal(rows.length, 2);
  assert.equal(
    findAll(rows[0], (item) => item.className === "role-title")[0].textContent,
    '<img src=x onerror="alert(1)"> Engineer 😊'
  );
  assert.equal(findAll(rows[0], (item) => item.tagName === "IMG").length, 0);
  assert.equal(
    findAll(rows[0], (item) => item.className.includes("review-status-tag"))[0].textContent,
    "Actively reviewing applicants"
  );
  assert.equal(
    findAll(rows[1], (item) => item.className.includes("review-status-tag"))[0].textContent,
    "No status shown"
  );
  const reviewFilter = elements.get("applicant-review-filter");
  reviewFilter.value = "actively-reviewing";
  await reviewFilter.dispatch("change");
  assert.equal(elements.get("job-table-body").children.length, 1);
  reviewFilter.value = "not-indicated";
  await reviewFilter.dispatch("change");
  assert.equal(elements.get("job-table-body").children.length, 1);
  reviewFilter.value = "";
  await reviewFilter.dispatch("change");

  const apply = findAll(rows[0], (item) => item.className === "apply-link")[0];
  assert.equal(apply.href, "https://www.linkedin.com/jobs/view/101/");
  assert.equal(apply.target, "_blank");
  assert.equal(apply.rel, "noopener noreferrer");
  await apply.dispatch("click");
  await settle();
  assert.equal(storage["opened.linkedin"]["101"], true);
  const reloadedPage = createPage(storage);
  await settle();
  assert.ok(reloadedPage.elements.get("job-table-body").children[0].className.includes("is-opened"));
  rows = elements.get("job-table-body").children;
  assert.ok(rows[0].className.includes("is-opened"));
  const undo = findAll(rows[0], (item) => (
    item.tagName === "A" && item.textContent === "undo"
  ))[0];
  await undo.dispatch("click", {
    preventDefault() {},
    stopPropagation() {}
  });
  await settle();
  assert.equal(storage["opened.linkedin"]["101"], undefined);

  await elements.get("company-sort").dispatch("click");
  rows = elements.get("job-table-body").children;
  assert.equal(findAll(rows[0], (item) => item.className === "company-name")[0].textContent, "Alpha");
  assert.equal(elements.get("company-header").attributes["aria-sort"], "ascending");
  assert.equal(elements.get("posted-header").attributes["aria-sort"], "none");

  await rows[0].dispatch("keydown", { key: "ArrowDown" });
  assert.equal(rows[1].focused, true);
  const keyboardApply = findAll(rows[1], (item) => item.className === "apply-link")[0];
  await rows[1].dispatch("keydown", { key: "Enter" });
  assert.equal(keyboardApply.clickCount, 1);
  await settle();
  assert.equal(storage["opened.linkedin"]["101"], true);
  elements.get("hide-opened").checked = true;
  await elements.get("hide-opened").dispatch("change");
  assert.equal(elements.get("job-table-body").children.length, 1);
  elements.get("hide-opened").checked = false;
  await elements.get("hide-opened").dispatch("change");

  await elements.get("company-tab").dispatch("click");
  rows = elements.get("job-table-body").children;
  assert.equal(rows.length, 1);
  const companyApply = findAll(rows[0], (item) => item.className === "apply-link")[0];
  assert.equal(companyApply.href, "https://www.linkedin.com/jobs/view/201/");
  assert.equal(findAll(rows[0], (item) => item.className === "via-linkedin")[0].textContent, "via LinkedIn");
  assert.equal(storage["ui.linkedin.selectedTab"], "Company Site");

  const liveJobs = {
    ...Object.fromEntries(Object.entries(storage.records)
      .filter(([key]) => key.startsWith("linkedin:"))
      .map(([key, record]) => [key.slice("linkedin:".length), record])),
    "202": job("202", "Company Site", {
    company: "Aardvark",
    companyApplyUrl: "https://careers.example/jobs/202"
    })
  };
  await updateStorage("records", Object.fromEntries(Object.entries(liveJobs).map(([jobId, record]) => [
    `linkedin:${jobId}`,
    record
  ])));
  assert.equal(elements.get("company-tab").textContent, "Company Apply (2)");

  const naukriPrimary = {
    siteId: "naukri",
    jobId: "021026012531",
    title: "<Senior & Staff Engineer>",
    company: "R&D <Systems>",
    postedBy: "Talent & Co",
    logo: null,
    experience: "5-8 Yrs",
    salary: "4-6.5 Lacs PA",
    locationRaw: "Hybrid - Bengaluru, Pune",
    workMode: "Hybrid",
    locations: ["Bengaluru", "Pune"],
    skills: ["C++ <x>", "Systems & Design"],
    walkIn: true,
    walkInDates: "03 Oct - 24 Oct",
    postedText: "3+ weeks ago",
    postedDateEstimate: "2026-09-26T12:00:00.000Z",
    postedApprox: true,
    postedType: "Posted",
    applyType: "Company Apply",
    companyApplyJob: true,
    applyRedirectUrl: "https://company.example/apply?job=021026012531",
    url: "https://www.naukri.com/job-listings-senior-021026012531"
  };
  const naukriConsultant = {
    ...naukriPrimary,
    jobId: "021026012532",
    title: "Platform Engineer",
    company: "Example Health",
    postedBy: "Talent & Co",
    companyApplyJob: false,
    applyRedirectUrl: null,
    applyType: "Easy Apply",
    questionnaireIdPresent: true,
    walkIn: false,
    walkInDates: null,
    skills: ["Node.js"],
    postedApprox: false,
    url: "https://www.naukri.com/job-listings-platform-021026012532"
  };
  const naukriCompany = {
    ...naukriPrimary,
    jobId: "021026012533",
    title: "Direct Hire Engineer",
    company: "Direct Company",
    postedBy: null,
    companyApplyJob: true,
    applyType: "Company Apply",
    walkIn: false,
    walkInDates: null,
    skills: ["Java"],
    postedApprox: false,
    url: "https://www.naukri.com/job-listings-direct-021026012533"
  };
  const naukriDirect = {
    ...naukriConsultant,
    jobId: "021026012534",
    title: "Direct Apply Engineer",
    company: "Direct Applicant",
    questionnaireIdPresent: false,
    applyType: "Direct Apply",
    url: "https://www.naukri.com/job-listings-direct-apply-021026012534"
  };
  const naukriStorage = {
    records: {
      "linkedin:101": job("101", "Easy Apply"),
      "naukri:021026012531": naukriPrimary,
      "naukri:021026012532": naukriConsultant,
      "naukri:021026012533": naukriCompany,
      "naukri:021026012534": naukriDirect
    },
    "opened.linkedin": { "101": true },
    "opened.naukri": {},
    "runs.naukri": {
      runId: "naukri-view-run",
      state: "DONE",
      startedAt: "2026-10-17T10:00:00.000Z",
      capturedCount: 4
    },
    "ui.naukri.selectedTab": "Company Apply"
  };
  const linkedinRecordBeforeSiteSwitch = JSON.stringify(naukriStorage.records["linkedin:101"]);
  const naukriPage = createPage(naukriStorage, "?site=naukri");
  await settle();
  assert.equal(naukriPage.elements.has("site-title"), false);
  assert.equal(naukriPage.storage["ui.lastSite"], "naukri");
  assert.equal(naukriPage.elements.get("linkedin-site-count").textContent, "1");
  assert.equal(naukriPage.elements.get("naukri-site-count").textContent, "4");
  assert.ok(naukriPage.elements.get("linkedin-site").className.includes("is-empty") === false);
  assert.deepEqual(
    naukriPage.elements.get("column-headings").children.map((heading) => heading.textContent),
    ["#", "Role", "Company", "Location", "Exp", "Salary", "Posted↓", "Apply"]
  );
  assert.equal(naukriPage.elements.get("easy-tab").textContent, "Easy Apply (1)");
  assert.equal(naukriPage.elements.get("direct-tab").textContent, "Direct Apply (1)");
  assert.equal(naukriPage.elements.get("company-tab").textContent, "Company Apply (2)");
  assert.match(naukriPage.elements.get("search").placeholder, /agency, or skills/);
  assert.ok(naukriPage.elements.get("run-subtitle").hidden);
  assert.equal(naukriPage.elements.get("site-run-footer").hidden, false);
  assert.match(naukriPage.elements.get("site-run-footer").textContent, /4 captured/);
  let naukriRows = naukriPage.elements.get("job-table-body").children;
  assert.equal(naukriRows.length, 2);
  assert.equal(naukriPage.elements.get("direct-tab").hidden, false);
  await naukriPage.elements.get("direct-tab").dispatch("click");
  assert.equal(naukriPage.elements.get("job-table-body").children.length, 1);
  assert.match(
    findAll(naukriPage.elements.get("job-table-body").children[0], (item) => item.className === "role-title")[0].textContent,
    /Direct Apply Engineer/
  );
  await naukriPage.elements.get("company-tab").dispatch("click");
  assert.equal(
    findAll(naukriRows[0], (item) => item.className === "role-title")[0].textContent,
    "<Senior & Staff Engineer>"
  );
  const specialRow = naukriRows.find((row) => (
    findAll(row, (item) => item.className === "role-title")[0].textContent === naukriPrimary.title
  ));
  assert.equal(findAll(specialRow, (item) => item.className === "company-name")[0].textContent, "R&D <Systems>");
  assert.equal(findAll(specialRow, (item) => item.className === "posted-by")[0].textContent, "via Talent & Co");
  assert.equal(
    findAll(specialRow, (item) => item.className === "apply-link")[0].href,
    "https://company.example/apply?job=021026012531"
  );
  assert.equal(findAll(specialRow, (item) => item.className === "work-mode-chip")[0].textContent, "Hybrid");
  assert.equal(findAll(specialRow, (item) => item.className === "walk-in-badge")[0].textContent, "Walk-in");
  assert.equal(findAll(specialRow, (item) => item.className === "walk-in-dates")[0].textContent, "03 Oct - 24 Oct");
  const approximateDate = findAll(specialRow, (item) => item.className === "absolute-date")[0];
  assert.match(approximateDate.textContent, /^~/);
  assert.match(approximateDate.attributes.title, /Approximate date/);
  const naukriApply = findAll(specialRow, (item) => item.className === "apply-link")[0];
  assert.equal(naukriApply.href, naukriPrimary.applyRedirectUrl);
  assert.equal(naukriApply.target, "_blank");
  assert.equal(naukriApply.rel, "noopener noreferrer");
  await naukriApply.dispatch("click");
  await settle();
  assert.equal(naukriStorage["opened.naukri"]["021026012531"], true);
  assert.equal(naukriStorage["opened.linkedin"]["101"], true);
  naukriRows = naukriPage.elements.get("job-table-body").children;
  const naukriUndo = findAll(naukriRows[0], (item) => item.textContent === "undo")[0];
  await naukriUndo.dispatch("click", { preventDefault() {}, stopPropagation() {} });
  await settle();
  assert.equal(naukriStorage["opened.naukri"]["021026012531"], undefined);

  naukriPage.elements.get("search").value = "Senior & Staff";
  await naukriPage.elements.get("search").dispatch("input");
  assert.equal(naukriPage.elements.get("job-table-body").children.length, 1);
  naukriPage.elements.get("search").value = "R&D <Systems>";
  await naukriPage.elements.get("search").dispatch("input");
  assert.equal(naukriPage.elements.get("job-table-body").children.length, 1);
  naukriPage.elements.get("search").value = "Systems & Design";
  await naukriPage.elements.get("search").dispatch("input");
  assert.equal(naukriPage.elements.get("job-table-body").children.length, 1);
  naukriPage.elements.get("search").value = "C++ <x>";
  await naukriPage.elements.get("search").dispatch("input");
  assert.equal(naukriPage.elements.get("job-table-body").children.length, 1);
  assert.equal(naukriPage.elements.get("job-table-body").children[0].getAttribute("aria-label")
    .includes("<Senior & Staff Engineer>"), true);
  naukriPage.elements.get("search").value = "Talent & Co";
  await naukriPage.elements.get("search").dispatch("input");
  assert.equal(naukriPage.elements.get("job-table-body").children.length, 1);
  naukriPage.elements.get("search").value = "";
  await naukriPage.elements.get("company-sort").dispatch("click");
  assert.equal(
    findAll(naukriPage.elements.get("job-table-body").children[0], (item) => (
      item.className === "company-name"
    ))[0].textContent,
    "Direct Company"
  );
  await naukriPage.elements.get("linkedin-site").dispatch("click");
  await settle();
  assert.equal(naukriStorage["ui.lastSite"], "linkedin");
  assert.match(naukriPage.location.assignedHref, /[?&]site=linkedin/);
  assert.equal(naukriStorage["opened.linkedin"]["101"], true);
  assert.equal(JSON.stringify(naukriStorage.records["linkedin:101"]), linkedinRecordBeforeSiteSwitch);

  const rememberedNaukriPage = createPage({
    records: naukriStorage.records,
    "ui.lastSite": "naukri",
    "opened.naukri": {}
  });
  await settle();
  assert.equal(rememberedNaukriPage.elements.has("site-title"), false);

  const zeroStorage = {
    jobsById: {},
    openedJobsById: {},
    collectorState: null,
    resultsSelectedTab: null
  };
  const emptyPage = createPage(zeroStorage);
  await settle();
  assert.equal(emptyPage.elements.get("total-count").textContent, "0 jobs");
  assert.ok(emptyPage.elements.get("linkedin-site").className.includes("is-empty"));
  assert.ok(emptyPage.elements.get("naukri-site").className.includes("is-empty"));
  assert.ok(emptyPage.elements.get("indeed-site").className.includes("is-empty"));
  assert.match(emptyPage.elements.get("empty-state").textContent, /No Easy Apply jobs captured/);

  const indeedPage = createPage({
    records: {
      "indeed:0123456789abcdef": {
        siteId: "indeed",
        jobId: "0123456789abcdef",
        title: "Indeed Role",
        company: "Indeed Company",
        location: "Remote",
        url: "https://in.indeed.com/viewjob?jk=0123456789abcdef",
        applyType: "Easy Apply",
        postedText: "5 days ago",
        capturedAt: "2026-10-17T12:00:00.000Z",
        visited: true
      },
      "indeed:8123456789abcdef": {
        siteId: "indeed",
        jobId: "8123456789abcdef",
        title: "Sponsored Indeed Role",
        company: "Sponsored Indeed Co",
        location: "Austin",
        url: "https://in.indeed.com/viewjob?jk=8123456789abcdef",
        applyType: "Company Site",
        sponsored: true,
        postedType: "Unknown",
        postedText: null,
        postedDateEstimate: null
      },
      "linkedin:101": job("101", "Easy Apply"),
      "naukri:021026012531": naukriPrimary
    },
    "runs.indeed": {
      siteId: "indeed",
      state: "DONE",
      capturedCount: 1,
      skippedAppliedCount: 2,
      skippedExpiredCount: 3
    },
    "opened.indeed": {},
    "opened.linkedin": { "101": true },
    "opened.naukri": { "021026012531": true }
  }, "?site=indeed");
  const otherSiteRecordsBeforeIndeedAction = JSON.stringify({
    linkedin: indeedPage.storage.records["linkedin:101"],
    naukri: indeedPage.storage.records["naukri:021026012531"]
  });
  await settle();
  assert.equal(indeedPage.elements.get("indeed-site").getAttribute("aria-pressed"), "true");
  assert.equal(indeedPage.elements.get("indeed-site-count").textContent, "2");
  assert.equal(indeedPage.elements.get("easy-tab").textContent, "Easy Apply (1)");
  assert.equal(indeedPage.elements.get("company-tab").textContent, "Company Apply (0)");
  assert.equal(indeedPage.elements.get("hide-sponsored").checked, true);
  assert.equal(indeedPage.elements.get("parse-warning-footer").textContent, "1 sponsored hidden");
  assert.equal(
    indeedPage.elements.get("dates-footer").textContent,
    "Dates: 1 from list data, 1 sponsored (no date), 0 unavailable"
  );
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 1);
  assert.deepEqual(
    indeedPage.elements.get("column-headings").children.map((heading) => heading.textContent),
    ["#", "Role", "Company", "Location", "Salary", "Type", "Posted↓", "Apply"]
  );
  assert.equal(indeedPage.elements.get("company-tab").hidden, false);
  assert.equal(indeedPage.elements.get("parse-warning-footer").hidden, false);
  assert.equal(indeedPage.elements.get("hide-visited-control").hidden, false);
  assert.equal(indeedPage.elements.get("hide-visited").checked, false);
  assert.equal(indeedPage.elements.get("indeed-skipped-footer").textContent, "Skipped: 2 applied, 3 expired");
  indeedPage.elements.get("hide-sponsored").checked = false;
  await indeedPage.elements.get("hide-sponsored").dispatch("change");
  assert.equal(indeedPage.elements.get("company-tab").textContent, "Company Apply (1)");
  assert.equal(indeedPage.elements.get("parse-warning-footer").textContent, "");
  await indeedPage.elements.get("company-tab").dispatch("click");
  let sponsoredRows = indeedPage.elements.get("job-table-body").children;
  assert.equal(sponsoredRows.length, 1);
  assert.equal(findAll(sponsoredRows[0], (item) => item.className === "posted-relative")[0].textContent, "No date (sponsored)");
  assert.equal(findAll(sponsoredRows[0], (item) => item.className.includes("sponsored-chip"))[0].textContent, "Sponsored");
  indeedPage.elements.get("hide-sponsored").checked = true;
  await indeedPage.elements.get("hide-sponsored").dispatch("change");
  assert.equal(indeedPage.elements.get("company-tab").textContent, "Company Apply (0)");
  await indeedPage.elements.get("easy-tab").dispatch("click");
  assert.ok(indeedPage.elements.get("naukri-site").className.includes("is-empty") === false);
  let indeedRows = indeedPage.elements.get("job-table-body").children;
  const indeedRow = indeedRows[0];
  assert.equal(findAll(indeedRow, (item) => item.className.includes("visited-chip"))[0].textContent, "Visited");
  indeedPage.elements.get("hide-visited").checked = true;
  await indeedPage.elements.get("hide-visited").dispatch("change");
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 0);
  indeedPage.elements.get("hide-visited").checked = false;
  await indeedPage.elements.get("hide-visited").dispatch("change");
  indeedRows = indeedPage.elements.get("job-table-body").children;
  assert.equal(findAll(indeedRow, (item) => item.className === "salary-cell")[0].textContent, "—");
  assert.equal(findAll(indeedRow, (item) => item.className === "type-cell")[0].textContent, "—");
  const indeedApply = findAll(indeedRow, (item) => item.className === "apply-link")[0];
  assert.equal(indeedApply.href, "https://in.indeed.com/viewjob?jk=0123456789abcdef");
  assert.equal(indeedApply.target, "_blank");
  assert.equal(indeedApply.rel, "noopener noreferrer");
  await indeedApply.dispatch("click");
  await settle();
  assert.equal(indeedPage.storage["opened.indeed"]["0123456789abcdef"], true);
  assert.equal(indeedPage.storage["opened.linkedin"]["101"], true);
  assert.equal(indeedPage.storage["opened.naukri"]["021026012531"], true);
  const indeedReloadedPage = createPage(indeedPage.storage, "?site=indeed");
  await settle();
  assert.ok(indeedReloadedPage.elements.get("job-table-body").children[0].className.includes("is-opened"));
  indeedRows = indeedPage.elements.get("job-table-body").children;
  const indeedUndo = findAll(indeedRows[0], (item) => item.textContent === "undo")[0];
  await indeedUndo.dispatch("click", { preventDefault() {}, stopPropagation() {} });
  await settle();
  assert.equal(indeedPage.storage["opened.indeed"]["0123456789abcdef"], undefined);
  assert.equal(indeedPage.storage["opened.linkedin"]["101"], true);
  assert.equal(indeedPage.storage["opened.naukri"]["021026012531"], true);
  assert.equal(JSON.stringify({
    linkedin: indeedPage.storage.records["linkedin:101"],
    naukri: indeedPage.storage.records["naukri:021026012531"]
  }), otherSiteRecordsBeforeIndeedAction);

  const indeedCompanyRecord = {
    siteId: "indeed",
    jobId: "1123456789abcdef",
    title: "Older Role",
    company: "Indeed Company Two",
    location: "Remote",
    workMode: "Remote",
    salary: "₹50,000 - ₹1,00,000 a month",
    jobType: "Full-time",
    sponsored: false,
    urgentlyHiring: true,
    postedText: "30+ days ago",
    postedApprox: true,
    postedDateEstimate: "2026-09-01T00:00:00.000Z",
    parseWarning: "Indeed JSON unavailable",
    url: "https://in.indeed.com/viewjob?jk=1123456789abcdef",
    applyType: "Company Site"
  };
  const indeedSecondCompanyRecord = {
    ...indeedCompanyRecord,
    jobId: "2123456789abcdef",
    title: "Austin Role",
    company: "Indeed Company Three",
    location: "Austin",
    workMode: null,
    salary: "$80,000 a year",
    jobType: "Contract",
    sponsored: false,
    urgentlyHiring: false,
    postedText: "2 days ago",
    postedApprox: false,
    postedDateEstimate: "2026-10-15T00:00:00.000Z",
    postedText: null,
    parseWarning: null,
    url: "https://in.indeed.com/viewjob?jk=2123456789abcdef"
  };
  await indeedPage.updateStorage("records", {
    ...indeedPage.storage.records,
    "indeed:1123456789abcdef": indeedCompanyRecord,
    "indeed:2123456789abcdef": indeedSecondCompanyRecord
  });
  assert.equal(indeedPage.elements.get("indeed-site-count").textContent, "4");
  assert.equal(indeedPage.elements.get("parse-warning-footer").hidden, false);
  assert.equal(indeedPage.elements.get("parse-warning-footer").textContent, "1 sponsored hidden");
  await indeedPage.elements.get("company-tab").dispatch("click");
  assert.equal(indeedPage.elements.get("company-tab").textContent, "Company Apply (2)");
  indeedRows = indeedPage.elements.get("job-table-body").children;
  const indeedCompanyRow = indeedRows.find((row) => (
    findAll(row, (item) => item.className === "role-title")[0].textContent === "Older Role"
  ));
  assert.equal(findAll(indeedCompanyRow, (item) => item.className === "location-text")[0].textContent, "Remote");
  assert.equal(findAll(indeedCompanyRow, (item) => item.className === "work-mode-chip")[0].textContent, "Remote");
  assert.equal(findAll(indeedCompanyRow, (item) => item.className === "salary-cell")[0].textContent, "₹50,000 - ₹1,00,000 a month");
  assert.equal(findAll(indeedCompanyRow, (item) => item.className === "type-cell")[0].textContent, "Full-time");
  assert.equal(findAll(indeedCompanyRow, (item) => item.className.includes("hiring-chip"))[0].textContent, "Urgently hiring");
  assert.equal(findAll(indeedCompanyRow, (item) => item.className === "posted-relative")[0].textContent, "30+ days");
  const indeedCompanyApply = findAll(indeedCompanyRow, (item) => item.className === "apply-link")[0];
  assert.equal(indeedCompanyApply.href, indeedCompanyRecord.url);
  assert.equal(indeedCompanyApply.target, "_blank");
  assert.equal(indeedCompanyApply.rel, "noopener noreferrer");
  const indeedApproxDate = findAll(indeedCompanyRow, (item) => item.className === "posted-relative")[0];
  assert.equal(indeedApproxDate.textContent, "30+ days");
  assert.match(indeedApproxDate.attributes.title, /exact date is unavailable/);
  assert.equal(findAll(indeedCompanyRow, (item) => item.className === "absolute-date").length, 0);
  await indeedPage.elements.get("location-sort").dispatch("click");
  assert.equal(indeedPage.elements.get("location-header").attributes["aria-sort"], "ascending");
  assert.equal(
    findAll(indeedPage.elements.get("job-table-body").children[0], (item) => item.className === "role-title")[0].textContent,
    "Austin Role"
  );
  assert.equal(
    findAll(indeedPage.elements.get("job-table-body").children[0], (item) => item.className === "posted-relative")[0].textContent,
    "Posted date"
  );
  await indeedPage.elements.get("salary-sort").dispatch("click");
  assert.equal(indeedPage.elements.get("salary-header").attributes["aria-sort"], "ascending");
  indeedPage.elements.get("search").value = "Remote";
  await indeedPage.elements.get("search").dispatch("input");
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 1);
  await indeedPage.elements.get("naukri-site").dispatch("click");
  await settle();
  assert.match(indeedPage.location.assignedHref, /[?&]site=naukri/);

  const postedSortPage = createPage({
    records: {
      "indeed:3123456789abcdef": {
        siteId: "indeed",
        jobId: "3123456789abcdef",
        title: "Newest Role",
        company: "Newest Co",
        applyType: "Easy Apply",
        postedText: "Today",
        capturedAt: "2026-10-17T12:00:00.000Z",
        url: "https://in.indeed.com/viewjob?jk=3123456789abcdef"
      },
      "indeed:4123456789abcdef": {
        siteId: "indeed",
        jobId: "4123456789abcdef",
        title: "Relative Date Role",
        company: "Relative Co",
        applyType: "Easy Apply",
        postedText: "18 days ago",
        capturedAt: "2026-10-17T12:00:00.000Z",
        url: "https://in.indeed.com/viewjob?jk=4123456789abcdef"
      },
      "indeed:5123456789abcdef": {
        siteId: "indeed",
        jobId: "5123456789abcdef",
        title: "Legacy Timestamp Role",
        company: "Legacy Co",
        applyType: "Easy Apply",
        pubDate: Date.parse("2026-10-10T12:00:00.000Z") / 1000,
        url: "https://in.indeed.com/viewjob?jk=5123456789abcdef"
      },
      "indeed:6123456789abcdef": {
        siteId: "indeed",
        jobId: "6123456789abcdef",
        title: "Approximate Role",
        company: "Approximate Co",
        applyType: "Easy Apply",
        postedText: "30+ days ago",
        postedApprox: true,
        capturedAt: "2026-10-17T12:00:00.000Z",
        url: "https://in.indeed.com/viewjob?jk=6123456789abcdef"
      },
      "indeed:7123456789abcdef": {
        siteId: "indeed",
        jobId: "7123456789abcdef",
        title: "Unknown Date Role",
        company: "Unknown Co",
        applyType: "Easy Apply",
        capturedAt: "2026-10-18T12:00:00.000Z",
        url: "https://in.indeed.com/viewjob?jk=7123456789abcdef"
      }
    }
  }, "?site=indeed");
  await settle();
  const titlesInPostedOrder = () => postedSortPage.elements.get("job-table-body").children.map((row) => (
    findAll(row, (item) => item.className === "role-title")[0].textContent
  ));
  assert.deepEqual(titlesInPostedOrder(), [
    "Newest Role",
    "Legacy Timestamp Role",
    "Relative Date Role",
    "Approximate Role",
    "Unknown Date Role"
  ]);
  assert.equal(
    postedSortPage.elements.get("dates-footer").textContent,
    "Dates: 4 from list data, 0 sponsored (no date), 1 unavailable"
  );
  const legacyPostedRow = postedSortPage.elements.get("job-table-body").children[1];
  assert.equal(findAll(legacyPostedRow, (item) => item.className === "posted-relative")[0].textContent, "Posted date");
  assert.match(findAll(legacyPostedRow, (item) => item.className === "absolute-date")[0].textContent, /10 Oct 2026/);
  const relativePostedRow = postedSortPage.elements.get("job-table-body").children[2];
  assert.match(findAll(relativePostedRow, (item) => item.className === "absolute-date")[0].textContent, /29 Sep 2026/);
  const unknownPostedRow = postedSortPage.elements.get("job-table-body").children[4];
  const unknownPostedText = findAll(unknownPostedRow, (item) => item.className === "posted-relative")[0];
  assert.equal(unknownPostedText.textContent, "Date unavailable");
  assert.equal(unknownPostedText.dataset.state, "unavailable");
  assert.match(
    findAll(unknownPostedRow, (item) => item.className === "first-seen")[0].textContent,
    /First seen .*(?:18|Oct).*2026/
  );
  await postedSortPage.elements.get("posted-sort").dispatch("click");
  assert.deepEqual(titlesInPostedOrder(), [
    "Approximate Role",
    "Relative Date Role",
    "Legacy Timestamp Role",
    "Newest Role",
    "Unknown Date Role"
  ]);

  const terminalStorage = {
    jobsById: {
      "101": job("101", "Easy Apply", {
        title: '<img src=x onerror="alert(1)"> Engineer 😊'
      })
    },
    openedJobsById: {},
    collectorState: {
      runId: "terminal-run",
      state: "DONE",
      startedAt: "2026-10-16T12:00:00.000Z"
    },
    resultsSelectedTab: "Easy Apply"
  };
  const terminalPage = createPage(terminalStorage, "?runId=terminal-run");
  await settle();
  await settle();
  assert.equal(terminalPage.downloadedFiles.length, 1);
  assert.match(
    terminalPage.downloadedFiles[0].filename,
    /^linkedin-jobs-\d{4}-\d{2}-\d{2}-\d{4}\.html$/
  );
  assert.equal(terminalStorage["runs.linkedin"].htmlReportDownloaded, true);
  assert.equal(terminalStorage["runs.linkedin"].htmlReportVersion, 3);
  const reportHtml = await terminalPage.downloadedFiles[0].blob.text();
  assert.ok(reportHtml.includes("\\u003cimg src=x onerror="));
  assert.doesNotMatch(reportHtml, /<img src=x onerror=/);
  assert.match(reportHtml, /role="tablist"/);
  assert.match(reportHtml, /id="easy-tab"/);
  assert.match(reportHtml, /id="company-tab"/);
  assert.match(reportHtml, /id="search"/);
  assert.match(reportHtml, /id="applicant-review-filter"/);
  assert.match(reportHtml, /applicantReviewStatus/);
  assert.match(reportHtml, /id="hide-opened"/);
  assert.match(reportHtml, /\.company-mark/);
  assert.match(reportHtml, /@media\(max-width:720px\)/);
  assert.match(reportHtml, /const savedTab = "Easy Apply"/);
  assert.doesNotMatch(reportHtml, /Company apply URL|Job link/);
  const reportScript = reportHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(reportScript, "standalone report includes its own interaction script");
  assert.doesNotThrow(() => new vm.Script(reportScript[1]));
  await terminalPage.updateStorage("runs.linkedin", terminalStorage["runs.linkedin"]);
  assert.equal(terminalPage.downloadedFiles.length, 1);

  const indeedReportPage = createPage({
    records: {
      "indeed:0123456789abcdef": {
        siteId: "indeed",
        jobId: "0123456789abcdef",
        title: "Visited Indeed Role",
        company: "Indeed Company",
        location: "Remote",
        visited: true,
        applyType: "Company Site",
        url: "https://in.indeed.com/viewjob?jk=0123456789abcdef"
      }
    },
    "runs.indeed": {
      runId: "indeed-terminal-run",
      siteId: "indeed",
      state: "DONE",
      startedAt: "2026-10-17T10:00:00.000Z",
      capturedCount: 1,
      skippedAppliedCount: 2,
      skippedExpiredCount: 1
    },
    "opened.indeed": {},
    "ui.indeed.selectedTab": "Company Site"
  }, "?site=indeed&runId=indeed-terminal-run");
  await settle();
  await settle();
  assert.equal(indeedReportPage.downloadedFiles.length, 1);
  const indeedReport = await indeedReportPage.downloadedFiles[0].blob.text();
  assert.match(indeedReport, /id="hide-visited"/);
  assert.match(indeedReport, /Skipped: 2 applied, 1 expired/);
  assert.match(indeedReport, /visited-chip/);
  const indeedReportScript = indeedReport.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(indeedReportScript);
  assert.doesNotThrow(() => new vm.Script(indeedReportScript[1]));

  const legacyReportPage = createPage({
    jobsById: { "101": job("101", "Easy Apply") },
    openedJobsById: {},
    collectorState: {
      runId: "legacy-report-run",
      state: "DONE",
      startedAt: "2026-10-16T12:00:00.000Z",
      htmlReportDownloaded: true
    },
    resultsSelectedTab: "Easy Apply"
  }, "?runId=legacy-report-run");
  await settle();
  await settle();
  assert.equal(legacyReportPage.downloadedFiles.length, 1);
  assert.equal(legacyReportPage.storage["runs.linkedin"].htmlReportVersion, 3);

  const stoppedPage = createPage({
    jobsById: { "201": job("201", "Company Site") },
    openedJobsById: {},
    collectorState: {
      runId: "stopped-run",
      state: "STOPPED",
      startedAt: "2026-10-16T12:00:00.000Z"
    },
    resultsSelectedTab: "Company Site"
  }, "?runId=stopped-run");
  await settle();
  await settle();
  assert.equal(stoppedPage.downloadedFiles.length, 1);
  assert.match(
    await stoppedPage.downloadedFiles[0].blob.text(),
    /Company Site/
  );

  const popupHtml = fs.readFileSync("popup.html", "utf8");
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.doesNotMatch(popupHtml, /copy-diagnostics|Copy flow log/i);
  assert.doesNotMatch(popupHtml, /Enable flow logs|Disable flow logs|flow-logging|flow-log-details/i);
  assert.doesNotMatch(fs.readFileSync("popup.js", "utf8"), /toggleFlowLogging|NAUKRI_SET_FLOW_LOGGING/);
  assert.deepEqual(manifest.permissions, ["storage", "scripting", "tabs", "alarms"]);
}

run().then(() => {
  console.log("Results UI tests passed: table behavior, safe standalone reports, terminal downloads, and popup controls.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
