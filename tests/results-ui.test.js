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
    this.disabled = false;
    this.checked = false;
    this.href = "";
    this.target = "";
    this.rel = "";
    this._text = "";
    this.tabIndex = 0;
    this.focused = false;
    this.clickCount = 0;
    this.open = false;
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

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }
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
    "all-tab",
    "easy-tab",
    "direct-tab",
    "company-tab",
    "linkedin-site",
    "naukri-site",
    "indeed-site",
    "linkedin-site-count",
    "naukri-site-count",
    "indeed-site-count",
    "brand-link",
    "settings-button",
    "settings-menu",
    "history-button",
    "export-button",
    "skip-titles-button",
    "history-dialog",
    "history-close",
    "history-from",
    "history-to",
    "history-error",
    "history-linkedin-received",
    "history-linkedin-opened",
    "history-naukri-received",
    "history-naukri-opened",
    "history-indeed-received",
    "history-indeed-opened",
    "skip-title-dialog",
    "skip-title-heading",
    "skip-title-close",
    "skip-title-form",
    "skip-title-input",
    "skip-title-submit",
    "skip-title-cancel-edit",
    "skip-title-error",
    "skip-title-empty",
    "skip-title-list",
    "site-switcher",
    "results-panel",
    "column-headings",
    "job-table-body",
    "empty-state",
    "search",
    "search-label",
    "applicant-review-filter",
    "location-filter-control",
    "filter-location-hyderabad",
    "filter-location-bengaluru",
    "filter-location-other",
    "experience-filter-control",
    "filter-experience-under-3",
    "filter-experience-4-5",
    "filter-experience-6-plus",
    "hide-selected-jobs",
    "view-hidden-jobs",
    "clear-hidden-jobs",
    "role-sort",
    "company-sort",
    "posted-sort",
    "role-header",
    "company-header",
    "posted-header",
    "run-subtitle",
    "site-run-footer",
    "parse-warning-footer",
    "feedback",
    "summary-total",
    "summary-site",
    "summary-total-note",
    "summary-easy",
    "summary-easy-share",
    "summary-reviewing",
    "summary-reviewing-share",
    "summary-fresh",
    "showing-count"
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement("div", id)]));
  const storageListeners = [];
  const downloadedFiles = [];
  const blobsByUrl = new Map();
  const history = {
    replaceState(_state, _title, href) { this.replacedHref = href; }
  };
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
    history,
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
    history,
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
        location: "Hyderabad, Telangana",
        applicantReviewStatus: "actively-reviewing",
        url: "https://www.linkedin.com/jobs/view/101/?tracking=ignored"
      }),
      "102": job("102", "Easy Apply", {
        company: "Alpha",
        location: "Bangalore Urban, Karnataka"
      }),
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
  assert.equal(elements.has("total-count"), false);
  assert.equal(elements.has("hide-opened"), false);
  assert.equal(elements.has("hide-hidden-jobs"), false);
  assert.equal(elements.has("skipped-count"), false);
  assert.equal(elements.get("results-panel").attributes["aria-labelledby"], "easy-tab");
  assert.equal(elements.get("location-filter-control").hidden, false);
  assert.equal(elements.get("experience-filter-control").hidden, true);
  assert.equal(elements.get("skip-titles-button").hidden, false);
  assert.equal(elements.get("brand-link").href, "results.html?site=linkedin");

  const roleSortPage = createPage({
    records: {
      "linkedin:401": job("401", "Easy Apply", { title: "Zulu Role" }),
      "linkedin:402": job("402", "Easy Apply", { title: "Alpha Role" })
    },
    "ui.lastSite": "linkedin",
    "ui.linkedin.selectedTab": "All"
  });
  await settle();
  const roleNames = () => roleSortPage.elements.get("job-table-body").children.map((row) => (
    findAll(row, (item) => item.className === "role-title")[0].textContent
  ));
  await roleSortPage.elements.get("role-sort").dispatch("click");
  assert.deepEqual(roleNames(), ["Alpha Role", "Zulu Role"]);
  await roleSortPage.elements.get("role-sort").dispatch("click");
  assert.deepEqual(roleNames(), ["Zulu Role", "Alpha Role"]);

  await elements.get("all-tab").dispatch("click");
  assert.equal(elements.get("all-tab").getAttribute("aria-selected"), "true");
  assert.equal(elements.get("results-panel").attributes["aria-labelledby"], "all-tab");
  assert.equal(elements.get("job-table-body").children.length, 4);
  await elements.get("easy-tab").dispatch("click");

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

  elements.get("filter-location-hyderabad").checked = true;
  await elements.get("filter-location-hyderabad").dispatch("change");
  await settle();
  assert.equal(elements.get("job-table-body").children.length, 1);
  assert.equal(storage["ui.linkedin.filters"].locations[0], "hyderabad");
  elements.get("filter-location-hyderabad").checked = false;
  elements.get("filter-location-bengaluru").checked = true;
  await elements.get("filter-location-bengaluru").dispatch("change");
  await settle();
  assert.equal(elements.get("job-table-body").children.length, 1);
  assert.equal(storage["ui.linkedin.filters"].locations[0], "bengaluru");
  const linkedinReloaded = createPage(storage);
  await settle();
  assert.equal(linkedinReloaded.elements.get("filter-location-bengaluru").checked, true);
  assert.equal(linkedinReloaded.elements.get("job-table-body").children.length, 1);
  elements.get("filter-location-bengaluru").checked = false;
  await elements.get("filter-location-bengaluru").dispatch("change");
  await settle();

  const apply = findAll(rows[0], (item) => item.className === "apply-link")[0];
  assert.equal(apply.href, "https://www.linkedin.com/jobs/view/101/");
  assert.equal(apply.target, "_blank");
  assert.equal(apply.rel, "noopener noreferrer");
  await apply.dispatch("click");
  await settle();
  assert.equal(storage["opened.linkedin"]["101"], true);
  assert.equal(elements.get("job-table-body").children.length, 1);
  assert.equal(elements.get("clear-hidden-jobs").disabled, false);
  await elements.get("clear-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(storage["opened.linkedin"]["101"], true);
  assert.equal(elements.get("job-table-body").children.length, 3);
  await elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  const openedLinkedInRow = elements.get("job-table-body").children[0];
  await findAll(openedLinkedInRow, (item) => item.getAttribute("aria-label") === "Mark 101 as not opened")[0]
    .dispatch("click");
  await settle();
  await elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  await elements.get("easy-tab").dispatch("click");

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
  assert.equal(elements.get("job-table-body").children.length, 1);

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
    experience: "2-5 Yrs",
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
    experience: "3 Yrs",
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
  assert.equal(naukriPage.elements.get("brand-link").href, "results.html?site=naukri");
  assert.equal(naukriPage.elements.get("linkedin-site-count").textContent, "1");
  assert.equal(naukriPage.elements.get("naukri-site-count").textContent, "4");
  assert.ok(naukriPage.elements.get("linkedin-site").className.includes("is-empty") === false);
  assert.deepEqual(
    naukriPage.elements.get("column-headings").children.map((heading) => heading.textContent),
    ["", "#", "Role", "Company", "Location", "Exp", "Salary", "Posted↓", "Apply"]
  );
  assert.equal(naukriPage.elements.get("easy-tab").textContent, "Easy Apply (1)");
  assert.equal(naukriPage.elements.get("direct-tab").textContent, "Direct Apply (1)");
  assert.equal(naukriPage.elements.get("company-tab").textContent, "Company Apply (2)");

  const naukriPostedSortPage = createPage({
    records: {
      "naukri:8101": {
        ...naukriPrimary,
        jobId: "8101",
        title: "One Week Old",
        postedText: "1 week ago",
        postedDateEstimate: "2026-10-20T10:00:00.000Z"
      },
      "naukri:8102": {
        ...naukriPrimary,
        jobId: "8102",
        title: "Four Days Old",
        postedText: "4 days ago",
        postedDateEstimate: "2026-10-10T10:00:00.000Z"
      },
      "naukri:8103": {
        ...naukriPrimary,
        jobId: "8103",
        title: "Two Days Old",
        postedText: "2 days ago",
        postedDateEstimate: "2026-10-12T10:00:00.000Z"
      }
    },
    "ui.lastSite": "naukri",
    "ui.naukri.selectedTab": "All"
  }, "?site=naukri");
  await settle();
  const naukriPostedTitles = () => naukriPostedSortPage.elements
    .get("job-table-body")
    .children
    .map((row) => findAll(row, (item) => item.className === "role-title")[0].textContent);
  assert.deepEqual(naukriPostedTitles(), ["Two Days Old", "Four Days Old", "One Week Old"]);
  await naukriPostedSortPage.elements.get("posted-sort").dispatch("click");
  assert.deepEqual(naukriPostedTitles(), ["One Week Old", "Four Days Old", "Two Days Old"]);

  naukriPage.elements.get("filter-location-bengaluru").checked = true;
  await naukriPage.elements.get("filter-location-bengaluru").dispatch("change");
  await settle();
  assert.equal(naukriPage.elements.get("job-table-body").children.length, 2);
  assert.equal(naukriPage.storage["ui.naukri.filters"].locations[0], "bengaluru");
  naukriPage.elements.get("filter-location-bengaluru").checked = false;
  await naukriPage.elements.get("filter-location-bengaluru").dispatch("change");
  await settle();
  const experienceFilterRecords = ["0-2 Yrs", "3 Yrs", "4-5 Yrs", "6+ Yrs", "7 Yrs", "2-5 Yrs"];
  const experienceFilterPage = createPage({
    records: Object.fromEntries(experienceFilterRecords.map((experience, index) => {
      const id = String(9201 + index);
      return [`naukri:${id}`, {
        ...naukriPrimary,
        jobId: id,
        title: `Experience ${experience}`,
        experience,
        applyType: "Company Apply",
        companyApplyJob: true
      }];
    })),
    "ui.lastSite": "naukri",
    "ui.naukri.selectedTab": "All",
    "ui.naukri.filters": { locations: [], experienceYears: [] }
  }, "?site=naukri");
  await settle();
  const under3 = experienceFilterPage.elements.get("filter-experience-under-3");
  under3.checked = true;
  await under3.dispatch("change");
  await settle();
  assert.equal(experienceFilterPage.elements.get("job-table-body").children.length, 3);
  assert.deepEqual(
    Array.from(experienceFilterPage.storage["ui.naukri.filters"].experienceYears),
    ["under-3"]
  );
  const legacyExperiencePage = createPage({
    records: experienceFilterPage.storage.records,
    "ui.lastSite": "naukri",
    "ui.naukri.selectedTab": "All",
    "ui.naukri.filters": { locations: [], experienceYears: [5] }
  }, "?site=naukri");
  await settle();
  assert.equal(legacyExperiencePage.elements.get("filter-experience-under-3").checked, false);
  assert.equal(legacyExperiencePage.elements.get("filter-experience-4-5").checked, true);
  assert.equal(legacyExperiencePage.elements.get("filter-experience-6-plus").checked, true);

  under3.checked = false;
  const fourToFive = experienceFilterPage.elements.get("filter-experience-4-5");
  fourToFive.checked = true;
  await fourToFive.dispatch("change");
  await settle();
  assert.equal(experienceFilterPage.elements.get("job-table-body").children.length, 2);
  fourToFive.checked = false;
  const sixPlus = experienceFilterPage.elements.get("filter-experience-6-plus");
  sixPlus.checked = true;
  await sixPlus.dispatch("change");
  await settle();
  assert.equal(experienceFilterPage.elements.get("job-table-body").children.length, 2);
  sixPlus.checked = false;
  await sixPlus.dispatch("change");
  await settle();
  assert.match(naukriPage.elements.get("search").placeholder, /agency, or skills/);
  assert.ok(naukriPage.elements.get("run-subtitle").hidden);
  assert.equal(naukriPage.elements.get("site-run-footer").hidden, false);
  assert.equal(naukriPage.elements.get("experience-filter-control").hidden, false);
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
  assert.equal(naukriPage.elements.get("job-table-body").children.length, 1);
  await naukriPage.elements.get("clear-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(naukriStorage["opened.naukri"]["021026012531"], true);
  await naukriPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  const openedNaukriRow = naukriPage.elements.get("job-table-body").children.find((row) => (
    row.getAttribute("aria-label").startsWith("<Senior & Staff Engineer>")
  ));
  await findAll(openedNaukriRow, (item) => item.getAttribute("aria-label") === "Mark 021026012531 as not opened")[0]
    .dispatch("click");
  await settle();
  await naukriPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  await naukriPage.elements.get("company-tab").dispatch("click");
  naukriRows = naukriPage.elements.get("job-table-body").children;

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

  const naukriSearchPage = createPage({
    records: {
      "naukri:9101": {
        ...naukriPrimary,
        jobId: "9101",
        title: "Dot Net Developer with Angular",
        company: "Angular Systems",
        skills: ["JavaScript", "Angular"]
      },
      "naukri:9102": {
        ...naukriPrimary,
        jobId: "9102",
        title: "Backend Engineer",
        company: "Backend Systems",
        skills: ["Java", "Spring"]
      },
      "naukri:9103": {
        ...naukriPrimary,
        jobId: "9103",
        title: "JavaScript Developer",
        company: "Frontend Systems",
        skills: ["React"]
      }
    },
    "ui.lastSite": "naukri",
    "ui.naukri.selectedTab": "All"
  }, "?site=naukri");
  await settle();
  naukriSearchPage.elements.get("search").value = "Java";
  await naukriSearchPage.elements.get("search").dispatch("input");
  assert.deepEqual(
    naukriSearchPage.elements.get("job-table-body").children.map((row) => row.getAttribute("aria-label")),
    ["Backend Engineer at Backend Systems"]
  );

  const hiddenJobsStorage = {
    records: Object.fromEntries(
      Object.entries(naukriStorage.records).filter(([key]) => key.startsWith("naukri:"))
    ),
    "ui.lastSite": "naukri",
    "ui.naukri.selectedTab": "Company Apply",
    "runs.naukri": { state: "DONE", capturedCount: 4 },
    "hidden.naukri": {}
  };
  const selectAllJobsStorage = {
    records: Object.fromEntries(
      Object.entries(naukriStorage.records).filter(([key]) => key.startsWith("naukri:"))
    ),
    "ui.lastSite": "naukri",
    "ui.naukri.selectedTab": "All",
    "runs.naukri": { state: "DONE", capturedCount: 4 },
    "hidden.naukri": {}
  };
  const selectAllJobsPage = createPage(selectAllJobsStorage);
  await settle();
  const selectAllJobs = selectAllJobsPage.elements.get("select-all-jobs");
  assert.ok(selectAllJobs);
  assert.equal(selectAllJobs.disabled, false);
  selectAllJobs.checked = true;
  await selectAllJobs.dispatch("change");
  const selectedRows = selectAllJobsPage.elements.get("job-table-body").children;
  assert.equal(selectedRows.length, 4);
  assert.equal(
    findAll(
      selectAllJobsPage.elements.get("job-table-body"),
      (item) => item.className === "job-selection" && item.checked
    ).length,
    4
  );
  assert.equal(selectAllJobsPage.elements.get("hide-selected-jobs").disabled, false);
  await selectAllJobsPage.elements.get("hide-selected-jobs").dispatch("click");
  await settle();
  assert.equal(selectAllJobsPage.elements.get("job-table-body").children.length, 0);
  assert.equal(Object.keys(selectAllJobsStorage["hidden.naukri"]).length, 4);
  assert.equal(selectAllJobsPage.elements.get("view-hidden-jobs").disabled, false);
  await selectAllJobsPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(selectAllJobsPage.elements.get("view-hidden-jobs").textContent, "View All Jobs");
  assert.equal(selectAllJobsPage.elements.get("view-hidden-jobs").getAttribute("aria-pressed"), "true");
  assert.equal(selectAllJobsPage.elements.get("job-table-body").children.length, 4);
  assert.equal(Object.keys(selectAllJobsStorage["hidden.naukri"]).length, 4);
  await selectAllJobsPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(selectAllJobsPage.elements.get("job-table-body").children.length, 0);
  assert.equal(Object.keys(selectAllJobsStorage["hidden.naukri"]).length, 4);

  const openedJobsPage = createPage({
    records: {
      "linkedin:991": job("991", "Easy Apply"),
      "linkedin:992": job("992", "Easy Apply")
    },
    "ui.lastSite": "linkedin",
    "ui.linkedin.selectedTab": "Easy Apply",
    "opened.linkedin": { "991": true },
    "hidden.linkedin": {}
  });
  await settle();
  assert.equal(openedJobsPage.elements.get("job-table-body").children.length, 1);
  await openedJobsPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(openedJobsPage.elements.get("job-table-body").children.length, 1);
  assert.equal(openedJobsPage.elements.get("job-table-body").children[0].getAttribute("aria-label"), "Role 991 at Company 991");
  assert.equal(openedJobsPage.storage["opened.linkedin"]["991"], true);
  assert.equal(openedJobsPage.storage["hidden.linkedin"] && Object.keys(openedJobsPage.storage["hidden.linkedin"]).length, 0);
  await openedJobsPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(openedJobsPage.elements.get("job-table-body").children.length, 1);
  assert.equal(openedJobsPage.storage["opened.linkedin"]["991"], true);

  const hideJobsPage = createPage(hiddenJobsStorage);
  await settle();
  hideJobsPage.elements.get("filter-location-bengaluru").checked = true;
  await hideJobsPage.elements.get("filter-location-bengaluru").dispatch("change");
  hideJobsPage.elements.get("filter-experience-under-3").checked = true;
  await hideJobsPage.elements.get("filter-experience-under-3").dispatch("change");
  await settle();
  const selectedRow = hideJobsPage.elements.get("job-table-body").children[0];
  const rowSelection = findAll(selectedRow, (item) => item.className === "job-selection")[0];
  rowSelection.checked = true;
  await rowSelection.dispatch("change");
  assert.equal(hideJobsPage.elements.get("hide-selected-jobs").disabled, false);
  await hideJobsPage.elements.get("hide-selected-jobs").dispatch("click");
  await settle();
  assert.equal(hideJobsPage.elements.get("job-table-body").children.length, 1);
  assert.equal(hideJobsPage.elements.get("hide-selected-jobs").disabled, true);
  assert.equal(hideJobsPage.elements.get("clear-hidden-jobs").disabled, false);
  assert.equal(hideJobsPage.elements.get("view-hidden-jobs").disabled, false);
  assert.deepEqual(Object.keys(hiddenJobsStorage["hidden.naukri"]), [
    findAll(selectedRow, (item) => item.className === "apply-link")[0].href
      .split("job=")[1]
  ]);
  await hideJobsPage.elements.get("clear-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(Object.keys(hiddenJobsStorage["hidden.naukri"]).length, 1);
  assert.equal(hideJobsPage.elements.get("job-table-body").children.length, 3);
  assert.equal(hideJobsPage.elements.get("clear-hidden-jobs").disabled, true);
  await hideJobsPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(hideJobsPage.elements.get("job-table-body").children.length, 1);
  await hideJobsPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(hiddenJobsStorage["hidden.linkedin"], undefined);
  const refreshedHideJobsPage = createPage(hiddenJobsStorage);
  await settle();
  assert.equal(refreshedHideJobsPage.elements.get("job-table-body").children.length, 3);
  await refreshedHideJobsPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(refreshedHideJobsPage.elements.get("job-table-body").children.length, 1);
  assert.equal(Object.keys(hiddenJobsStorage["hidden.naukri"]).length, 1);
  await refreshedHideJobsPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(refreshedHideJobsPage.elements.get("job-table-body").children.length, 3);
  assert.equal(refreshedHideJobsPage.elements.get("clear-hidden-jobs").disabled, true);
  assert.equal(Object.keys(hiddenJobsStorage["hidden.naukri"]).length, 1);
  assert.deepEqual(Array.from(hiddenJobsStorage["ui.naukri.filters"].locations), []);
  assert.deepEqual(Array.from(hiddenJobsStorage["ui.naukri.filters"].experienceYears), []);
  assert.equal(hiddenJobsStorage["ui.naukri.selectedTab"], "All");

  await naukriPage.elements.get("linkedin-site").dispatch("click");
  await settle();
  assert.equal(naukriStorage["ui.lastSite"], "linkedin");
  assert.equal(naukriPage.location.assignedHref, "https://extension.test/results.html");
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
  assert.equal(emptyPage.elements.has("total-count"), false);
  assert.ok(emptyPage.elements.get("linkedin-site").className.includes("is-empty"));
  assert.ok(emptyPage.elements.get("naukri-site").className.includes("is-empty"));
  assert.ok(emptyPage.elements.get("indeed-site").className.includes("is-empty"));
  assert.match(emptyPage.elements.get("empty-state").textContent, /No jobs captured/);

  const historyToday = new Date();
  const formatLocalDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  const asCapturedRecord = (siteId, jobId, capturedDate) => ({
    siteId,
    jobId,
    title: `${siteId} history role`,
    company: `${siteId} history company`,
    applyType: "Easy Apply",
    capturedAt: new Date(
      capturedDate.getFullYear(),
      capturedDate.getMonth(),
      capturedDate.getDate(),
      12
    ).toISOString()
  });
  const lastMonth = new Date(historyToday.getFullYear(), historyToday.getMonth(), 0);
  const historyPage = createPage({
    records: {
      "linkedin:history-1": asCapturedRecord("linkedin", "history-1", historyToday),
      "linkedin:history-2": asCapturedRecord("linkedin", "history-2", lastMonth),
      "naukri:history-1": asCapturedRecord("naukri", "history-1", historyToday),
      "indeed:history-1": asCapturedRecord("indeed", "history-1", historyToday)
    },
    "opened.linkedin": { "history-1": true },
    "opened.naukri": { "history-1": true },
    "opened.indeed": {}
  }, "?site=indeed");
  await settle();
  await historyPage.elements.get("history-button").dispatch("click");
  await settle();
  assert.equal(historyPage.elements.get("history-dialog").open, true);
  assert.equal(
    historyPage.elements.get("history-from").value,
    formatLocalDate(new Date(historyToday.getFullYear(), historyToday.getMonth(), 1))
  );
  assert.equal(historyPage.elements.get("history-to").value, formatLocalDate(historyToday));
  assert.equal(historyPage.elements.get("history-linkedin-received").textContent, "1");
  assert.equal(historyPage.elements.get("history-linkedin-opened").textContent, "1");
  assert.equal(historyPage.elements.get("history-naukri-received").textContent, "1");
  assert.equal(historyPage.elements.get("history-naukri-opened").textContent, "1");
  assert.equal(historyPage.elements.get("history-indeed-received").textContent, "1");
  assert.equal(historyPage.elements.get("history-indeed-opened").textContent, "0");
  historyPage.elements.get("history-from").value = formatLocalDate(historyToday);
  await historyPage.elements.get("history-from").dispatch("change");
  await settle();
  assert.equal(historyPage.elements.get("history-linkedin-received").textContent, "1");
  historyPage.elements.get("history-from").value = formatLocalDate(
    new Date(historyToday.getFullYear(), historyToday.getMonth(), historyToday.getDate() + 1)
  );
  await historyPage.elements.get("history-from").dispatch("change");
  assert.match(historyPage.elements.get("history-error").textContent, /must be on or before/);
  await historyPage.elements.get("history-close").dispatch("click");
  assert.equal(historyPage.elements.get("history-dialog").open, false);

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
        capturedAt: "2026-10-17T12:00:00.000Z"
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
  assert.equal(indeedPage.elements.get("brand-link").href, "results.html?site=indeed");
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 2);
  assert.equal(indeedPage.elements.get("easy-tab").textContent, "Easy Apply (1)");
  assert.equal(indeedPage.elements.get("company-tab").textContent, "Company Apply (1)");
  assert.equal(indeedPage.elements.get("parse-warning-footer").hidden, true);
  assert.equal(indeedPage.elements.has("dates-footer"), false);
  assert.equal(indeedPage.elements.get("skip-titles-button").hidden, false);
  const skipTitlePage = createPage({
    records: {},
    "indeed:skipTitles": ["Senior Software Engineer"]
  }, "?site=indeed");
  await settle();
  await skipTitlePage.elements.get("settings-button").dispatch("click");
  assert.equal(skipTitlePage.elements.get("settings-menu").hidden, false);
  assert.equal(skipTitlePage.elements.get("settings-button").getAttribute("aria-expanded"), "true");
  await skipTitlePage.elements.get("skip-titles-button").dispatch("click");
  assert.equal(skipTitlePage.elements.get("settings-menu").hidden, true);
  assert.equal(skipTitlePage.elements.get("skip-title-dialog").open, true);
  assert.equal(skipTitlePage.elements.get("skip-title-list").children.length, 1);
  assert.equal(skipTitlePage.elements.get("skip-title-list").children[0].textContent, "Senior Software EngineerEditDelete");
  skipTitlePage.elements.get("skip-title-input").value = "Software Engineer";
  await skipTitlePage.elements.get("skip-title-form").dispatch("submit");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(skipTitlePage.storage["indeed:skipTitles"])), [
    "Senior Software Engineer",
    "Software Engineer"
  ]);
  const editableTitleRow = skipTitlePage.elements.get("skip-title-list").children[1];
  const editTitleButton = findAll(editableTitleRow, (item) => item.tagName === "BUTTON")[0];
  await editTitleButton.dispatch("click");
  skipTitlePage.elements.get("skip-title-input").value = "Principal Software Engineer";
  await skipTitlePage.elements.get("skip-title-form").dispatch("submit");
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(skipTitlePage.storage["indeed:skipTitles"])), [
    "Senior Software Engineer",
    "Principal Software Engineer"
  ]);
  const updatedTitleRow = skipTitlePage.elements.get("skip-title-list").children[1];
  const deleteTitleButton = findAll(updatedTitleRow, (item) => item.tagName === "BUTTON")[1];
  await deleteTitleButton.dispatch("click");
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(skipTitlePage.storage["indeed:skipTitles"])),
    ["Senior Software Engineer"]
  );
  await skipTitlePage.elements.get("skip-title-close").dispatch("click");
  assert.equal(skipTitlePage.elements.get("skip-title-dialog").open, false);
  for (const [siteId, siteLabel] of [["linkedin", "LinkedIn"], ["naukri", "Naukri"]]) {
    const platformSettingsPage = createPage({
      [`${siteId}:skipTitles`]: ["Existing exact title"]
    }, `?site=${siteId}`);
    await settle();
    assert.equal(platformSettingsPage.elements.get("skip-titles-button").hidden, false);
    await platformSettingsPage.elements.get("settings-button").dispatch("click");
    await platformSettingsPage.elements.get("skip-titles-button").dispatch("click");
    assert.equal(
      platformSettingsPage.elements.get("skip-title-heading").textContent,
      `Skip titles — ${siteLabel}`
    );
    platformSettingsPage.elements.get("skip-title-input").value = `${siteLabel} exact title`;
    await platformSettingsPage.elements.get("skip-title-form").dispatch("submit");
    await settle();
    assert.deepEqual(
      JSON.parse(JSON.stringify(platformSettingsPage.storage[`${siteId}:skipTitles`])),
      ["Existing exact title", `${siteLabel} exact title`]
    );
  }
  await indeedPage.elements.get("easy-tab").dispatch("click");
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 1);
  indeedPage.elements.get("filter-location-other").checked = true;
  await indeedPage.elements.get("filter-location-other").dispatch("change");
  await settle();
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 1);
  assert.equal(indeedPage.storage["ui.indeed.filters"].locations[0], "other");
  indeedPage.elements.get("filter-location-other").checked = false;
  await indeedPage.elements.get("filter-location-other").dispatch("change");
  await settle();
  assert.deepEqual(
    indeedPage.elements.get("column-headings").children.map((heading) => heading.textContent),
    ["", "#", "Role", "Company", "Location", "Salary", "Type", "Posted↓", "Apply"]
  );
  assert.equal(indeedPage.elements.get("company-tab").hidden, false);
  assert.equal(indeedPage.elements.has("indeed-skipped-footer"), false);
  await indeedPage.elements.get("company-tab").dispatch("click");
  let sponsoredRows = indeedPage.elements.get("job-table-body").children;
  assert.equal(sponsoredRows.length, 1);
  assert.equal(findAll(sponsoredRows[0], (item) => item.className === "posted-relative")[0].textContent, "No date (sponsored)");
  assert.equal(findAll(sponsoredRows[0], (item) => item.className.includes("sponsored-chip"))[0].textContent, "Sponsored");
  await indeedPage.elements.get("easy-tab").dispatch("click");
  assert.ok(indeedPage.elements.get("naukri-site").className.includes("is-empty") === false);
  let indeedRows = indeedPage.elements.get("job-table-body").children;
  const indeedRow = indeedRows[0];
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 1);
  assert.equal(findAll(indeedRow, (item) => item.className === "salary-cell")[0].textContent, "—");
  assert.equal(findAll(indeedRow, (item) => item.className === "type-cell")[0].textContent, "—");
  const indeedApply = findAll(indeedRow, (item) => item.className === "apply-link")[0];
  assert.equal(indeedApply.href, "https://in.indeed.com/viewjob?jk=0123456789abcdef");
  assert.equal(indeedApply.target, "_blank");
  assert.equal(indeedApply.rel, "noopener noreferrer");
  await indeedApply.dispatch("click");
  await settle();
  assert.equal(indeedPage.storage["opened.indeed"]["0123456789abcdef"], true);
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 0);
  const indeedOpenedReload = createPage(indeedPage.storage, "?site=indeed");
  await settle();
  assert.equal(indeedOpenedReload.elements.get("job-table-body").children.length, 0);
  await indeedPage.elements.get("clear-hidden-jobs").dispatch("click");
  await settle();
  assert.equal(indeedPage.storage["opened.indeed"]["0123456789abcdef"], true);
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 1);
  await indeedPage.elements.get("easy-tab").dispatch("click");
  await settle();
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 0);
  assert.equal(indeedPage.storage["opened.linkedin"]["101"], true);
  assert.equal(indeedPage.storage["opened.naukri"]["021026012531"], true);
  const indeedReloadedPage = createPage(indeedPage.storage, "?site=indeed");
  await settle();
  assert.equal(indeedReloadedPage.elements.get("job-table-body").children.length, 0);
  indeedRows = indeedPage.elements.get("job-table-body").children;
  assert.equal(indeedPage.storage["opened.indeed"]["0123456789abcdef"], true);
  assert.equal(indeedPage.storage["opened.linkedin"]["101"], true);
  assert.equal(indeedPage.storage["opened.naukri"]["021026012531"], true);
  assert.equal(JSON.stringify({
    linkedin: indeedPage.storage.records["linkedin:101"],
    naukri: indeedPage.storage.records["naukri:021026012531"]
  }), otherSiteRecordsBeforeIndeedAction);

  const indeedVisitedPage = createPage({
    records: {
      "indeed:6123456789abcdef": {
        siteId: "indeed",
        jobId: "6123456789abcdef",
        title: "Visited Indeed Role",
        company: "Indeed Company",
        location: "Remote",
        url: "https://in.indeed.com/viewjob?jk=6123456789abcdef",
        applyType: "Easy Apply",
        visited: true
      },
      "indeed:7123456789abcdef": {
        siteId: "indeed",
        jobId: "7123456789abcdef",
        title: "Unvisited Indeed Role",
        company: "Indeed Company",
        location: "Remote",
        url: "https://in.indeed.com/viewjob?jk=7123456789abcdef",
        applyType: "Easy Apply",
        visited: false
      }
    },
    "ui.lastSite": "indeed",
    "ui.indeed.selectedTab": "All",
    "opened.indeed": {},
    "hidden.indeed": {}
  }, "?site=indeed");
  await settle();
  assert.equal(indeedVisitedPage.elements.get("job-table-body").children.length, 1);
  assert.equal(
    indeedVisitedPage.elements.get("job-table-body").children[0].getAttribute("aria-label"),
    "Unvisited Indeed Role at Indeed Company"
  );
  assert.equal(indeedVisitedPage.elements.get("view-hidden-jobs").disabled, false);
  await indeedVisitedPage.elements.get("view-hidden-jobs").dispatch("click");
  await settle();
  const visitedRows = indeedVisitedPage.elements.get("job-table-body").children;
  assert.equal(visitedRows.length, 1);
  assert.equal(visitedRows[0].getAttribute("aria-label"), "Visited Indeed Role at Indeed Company");
  assert.equal(findAll(visitedRows[0], (item) => item.className.includes("visited-chip"))[0].textContent, "Visited");
  assert.equal(indeedVisitedPage.storage["opened.indeed"]["6123456789abcdef"], undefined);

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
  assert.equal(indeedPage.elements.get("parse-warning-footer").hidden, true);
  assert.equal(indeedPage.elements.get("parse-warning-footer").textContent, "");
  const justPostedIndeedPage = createPage({
    records: {
      "indeed:3123456789abcdef": {
        siteId: "indeed",
        jobId: "3123456789abcdef",
        title: "Just Posted Role",
        company: "Indeed Company",
        location: "Remote",
        url: "https://in.indeed.com/viewjob?jk=3123456789abcdef",
        applyType: "Easy Apply",
        postedText: "Just posted",
        postedDateEstimate: "2026-10-20T00:00:00.000Z"
      },
      "indeed:4123456789abcdef": {
        siteId: "indeed",
        jobId: "4123456789abcdef",
        title: "Today Role",
        company: "Indeed Company",
        location: "Remote",
        url: "https://in.indeed.com/viewjob?jk=4123456789abcdef",
        applyType: "Company Site",
        postedText: "Today",
        postedDateEstimate: "2026-10-20T00:00:00.000Z"
      },
      "indeed:5123456789abcdef": {
        siteId: "indeed",
        jobId: "5123456789abcdef",
        title: "Older Role",
        company: "Indeed Company",
        location: "Remote",
        url: "https://in.indeed.com/viewjob?jk=5123456789abcdef",
        applyType: "Company Site",
        postedText: "2 days ago",
        postedDateEstimate: "2026-10-19T00:00:00.000Z"
      }
    },
    "ui.lastSite": "indeed",
    "ui.indeed.selectedTab": "All"
  }, "?site=indeed");
  await settle();
  assert.equal(justPostedIndeedPage.elements.get("summary-fresh").textContent, "2");
  await indeedPage.elements.get("company-tab").dispatch("click");
  assert.equal(indeedPage.elements.get("company-tab").textContent, "Company Apply (3)");
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
    "Sponsored Indeed Role"
  );
  assert.equal(
    findAll(indeedPage.elements.get("job-table-body").children[0], (item) => item.className === "posted-relative")[0].textContent,
    "No date (sponsored)"
  );
  await indeedPage.elements.get("salary-sort").dispatch("click");
  assert.equal(indeedPage.elements.get("salary-header").attributes["aria-sort"], "ascending");
  indeedPage.elements.get("search").value = "Remote";
  await indeedPage.elements.get("search").dispatch("input");
  assert.equal(indeedPage.elements.get("job-table-body").children.length, 1);
  await indeedPage.elements.get("naukri-site").dispatch("click");
  await settle();
  assert.equal(indeedPage.location.assignedHref, "https://extension.test/results.html");

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
  assert.equal(postedSortPage.elements.has("dates-footer"), false);
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
  assert.equal(terminalPage.downloadedFiles.length, 0);
  assert.equal(terminalStorage["runs.linkedin"].htmlReportDownloaded, undefined);
  await terminalPage.elements.get("export-button").dispatch("click");
  await settle();
  assert.equal(terminalPage.downloadedFiles.length, 1);
  assert.match(
    terminalPage.downloadedFiles[0].filename,
    /^linkedin-jobs-\d{4}-\d{2}-\d{2}-\d{4}\.html$/
  );
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
  assert.match(reportHtml, /data-location="hyderabad"/);
  assert.match(reportHtml, /\.company-mark/);
  assert.match(reportHtml, /@media\(max-width:720px\)/);
  assert.match(reportHtml, /const savedTab = "Easy Apply"/);
  assert.doesNotMatch(reportHtml, /Company apply URL|Job link/);
  const reportScript = reportHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(reportScript, "standalone report includes its own interaction script");
  assert.doesNotThrow(() => new vm.Script(reportScript[1]));
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
  assert.equal(indeedReportPage.downloadedFiles.length, 0);
  await indeedReportPage.elements.get("export-button").dispatch("click");
  await settle();
  assert.equal(indeedReportPage.downloadedFiles.length, 1);
  const indeedReport = await indeedReportPage.downloadedFiles[0].blob.text();
  assert.doesNotMatch(indeedReport, /id="hide-visited"/);
  assert.match(indeedReport, /data-location="other"/);
  assert.doesNotMatch(indeedReport, /Skipped: \d+ applied, \d+ expired|Dates: \d+ from list data/);
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
  assert.equal(legacyReportPage.downloadedFiles.length, 0);
  await legacyReportPage.elements.get("export-button").dispatch("click");
  await settle();
  assert.equal(legacyReportPage.downloadedFiles.length, 1);

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
  assert.equal(stoppedPage.downloadedFiles.length, 0);
  await stoppedPage.elements.get("export-button").dispatch("click");
  await settle();
  assert.equal(stoppedPage.downloadedFiles.length, 1);
  assert.equal(stoppedPage.history.replacedHref, "https://extension.test/results.html");
  assert.match(
    await stoppedPage.downloadedFiles[0].blob.text(),
    /Company Site/
  );

  const popupHtml = fs.readFileSync("popup.html", "utf8");
  const resultsHtml = fs.readFileSync("results.html", "utf8");
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  assert.match(resultsHtml, /id="filter-location-hyderabad"/);
  assert.match(resultsHtml, /id="filter-location-bengaluru"/);
  assert.match(resultsHtml, /id="filter-location-other"/);
  assert.match(resultsHtml, /id="filter-experience-under-3"/);
  assert.match(resultsHtml, /id="filter-experience-4-5"/);
  assert.match(resultsHtml, /id="filter-experience-6-plus"/);
  assert.match(resultsHtml, /Experience \(years\)/);
  assert.match(resultsHtml, /> 3Y and below</);
  assert.match(resultsHtml, /> 4-5Y</);
  assert.match(resultsHtml, /> 6Y\+</);
  const headerStart = resultsHtml.indexOf('<header class="app-header">');
  const summaryStart = resultsHtml.indexOf('class="summary-cards header-summary"');
  const switcherStart = resultsHtml.indexOf('id="site-switcher"');
  const actionsStart = resultsHtml.indexOf('class="header-actions"');
  const headerEnd = resultsHtml.indexOf("</header>", headerStart);
  assert.ok(headerStart < summaryStart && summaryStart < switcherStart);
  assert.ok(switcherStart < actionsStart && actionsStart < headerEnd);
  assert.match(resultsHtml, /id="brand-link"[^>]*aria-label="JobFlow results"/);
  assert.doesNotMatch(resultsHtml, /class="brand-name"|class="brand-version"|Captured jobs/);
  assert.match(resultsHtml, /id="settings-button"[^>]*aria-label="Settings"/);
  assert.match(resultsHtml, /id="settings-menu"[^>]*hidden/);
  assert.match(resultsHtml, /id="history-button"[^>]*>History<\/button>/);
  assert.match(resultsHtml, /id="export-button"[^>]*>Export<\/button>/);
  assert.match(resultsHtml, /id="skip-titles-button"[^>]*>Skip Title<\/button>/);
  assert.match(resultsHtml, /id="skip-title-dialog"[^>]*>/);
  assert.match(resultsHtml, /id="skip-title-input"/);
  assert.match(resultsHtml, /id="skip-title-list"/);
  assert.match(resultsHtml, /id="history-dialog"[^>]*>/);
  assert.match(resultsHtml, /id="history-from" type="date"/);
  assert.match(resultsHtml, /id="history-to" type="date"/);
  assert.match(resultsHtml, /history-linkedin-received/);
  assert.match(resultsHtml, /history-naukri-opened/);
  assert.match(resultsHtml, /history-indeed-opened/);
  assert.doesNotMatch(resultsHtml, /id="hide-opened"|id="hide-hidden-jobs"/);
  assert.match(resultsHtml, /id="hide-selected-jobs"[^>]*>Hide JD<\/button>/);
  assert.match(resultsHtml, /id="view-hidden-jobs"[^>]*>View Hidden Jobs<\/button>/);
  assert.match(resultsHtml, /id="clear-hidden-jobs"[^>]*>Clear<\/button>/);
  assert.ok(
    resultsHtml.indexOf('id="hide-selected-jobs"')
    < resultsHtml.indexOf('id="view-hidden-jobs"')
    && resultsHtml.indexOf('id="view-hidden-jobs"')
    < resultsHtml.indexOf('id="clear-hidden-jobs"')
  );
  assert.doesNotMatch(resultsHtml, /id="total-count"/);
  assert.doesNotMatch(resultsHtml, /id="indeed-skipped-footer"|id="dates-footer"/);
  assert.doesNotMatch(resultsHtml, /skipped-count|skipped \(no apply option\)/);
  assert.doesNotMatch(resultsHtml, /id="hide-(?:visited|sponsored)"/);
  assert.doesNotMatch(popupHtml, /copy-diagnostics|Copy flow log/i);
  assert.doesNotMatch(popupHtml, /Enable flow logs|Disable flow logs|flow-logging|flow-log-details/i);
  assert.doesNotMatch(fs.readFileSync("popup.js", "utf8"), /toggleFlowLogging|NAUKRI_SET_FLOW_LOGGING/);
  assert.deepEqual(manifest.permissions, ["storage", "scripting", "tabs", "alarms", "nativeMessaging"]);
}

run().then(() => {
  console.log("Results UI tests passed: table behavior, safe standalone reports, terminal downloads, and popup controls.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
