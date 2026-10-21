"use strict";

const RESULT_PARAMS = new URLSearchParams(globalThis.location.search);
const REQUESTED_SITE_ID = RESULT_PARAMS.get("site") || RESULT_PARAMS.get("siteId");
const ALL_TAB = "All";
const EXPERIENCE_BANDS = ["under-3", "4-5", "6-plus"];
let SITE_ID = REQUESTED_SITE_ID || "linkedin";
const STORAGE_API = globalThis.JobCollectorStorage;
let SITE_ADAPTER = globalThis.JobCollectorSiteRegistry.getAdapter(SITE_ID);
if (!SITE_ADAPTER) {
  throw new Error(`No results adapter is registered for site "${SITE_ID}".`);
}
let STORAGE_KEYS = getStorageKeys(SITE_ID);
let APPLY_TABS = SITE_ADAPTER.ui.tabs.map((tab) => tab.id);
let TAB_LABELS = Object.fromEntries(SITE_ADAPTER.ui.tabs.map((tab) => [tab.id, tab.label]));
const elements = {
  brandLink: document.getElementById("brand-link"),
  siteSwitcher: document.getElementById("site-switcher"),
  linkedinSite: document.getElementById("linkedin-site"),
  naukriSite: document.getElementById("naukri-site"),
  indeedSite: document.getElementById("indeed-site"),
  linkedinSiteCount: document.getElementById("linkedin-site-count"),
  naukriSiteCount: document.getElementById("naukri-site-count"),
  indeedSiteCount: document.getElementById("indeed-site-count"),
  settingsButton: document.getElementById("settings-button"),
  settingsMenu: document.getElementById("settings-menu"),
  historyButton: document.getElementById("history-button"),
  exportButton: document.getElementById("export-button"),
  skipTitlesButton: document.getElementById("skip-titles-button"),
  historyDialog: document.getElementById("history-dialog"),
  historyClose: document.getElementById("history-close"),
  historyFrom: document.getElementById("history-from"),
  historyTo: document.getElementById("history-to"),
  historyError: document.getElementById("history-error"),
  historyCounts: {
    linkedin: {
      received: document.getElementById("history-linkedin-received"),
      opened: document.getElementById("history-linkedin-opened")
    },
    naukri: {
      received: document.getElementById("history-naukri-received"),
      opened: document.getElementById("history-naukri-opened")
    },
    indeed: {
      received: document.getElementById("history-indeed-received"),
      opened: document.getElementById("history-indeed-opened")
    }
  },
  skipTitleDialog: document.getElementById("skip-title-dialog"),
  skipTitleHeading: document.getElementById("skip-title-heading"),
  skipTitleClose: document.getElementById("skip-title-close"),
  skipTitleForm: document.getElementById("skip-title-form"),
  skipTitleInput: document.getElementById("skip-title-input"),
  skipTitleSubmit: document.getElementById("skip-title-submit"),
  skipTitleCancelEdit: document.getElementById("skip-title-cancel-edit"),
  skipTitleError: document.getElementById("skip-title-error"),
  skipTitleEmpty: document.getElementById("skip-title-empty"),
  skipTitleList: document.getElementById("skip-title-list"),
  easyTab: document.getElementById("easy-tab"),
  allTab: document.getElementById("all-tab"),
  directTab: document.getElementById("direct-tab"),
  companyTab: document.getElementById("company-tab"),
  panel: document.getElementById("results-panel"),
  columnHeadings: document.getElementById("column-headings"),
  tableBody: document.getElementById("job-table-body"),
  empty: document.getElementById("empty-state"),
  search: document.getElementById("search"),
  searchLabel: document.getElementById("search-label"),
  applicantReviewFilter: document.getElementById("applicant-review-filter"),
  locationFilterControl: document.getElementById("location-filter-control"),
  locationFilters: {
    hyderabad: document.getElementById("filter-location-hyderabad"),
    bengaluru: document.getElementById("filter-location-bengaluru"),
    other: document.getElementById("filter-location-other")
  },
  experienceFilterControl: document.getElementById("experience-filter-control"),
  experienceFilters: {
    "under-3": document.getElementById("filter-experience-under-3"),
    "4-5": document.getElementById("filter-experience-4-5"),
    "6-plus": document.getElementById("filter-experience-6-plus")
  },
  hideSelectedJobs: document.getElementById("hide-selected-jobs"),
  viewHiddenJobs: document.getElementById("view-hidden-jobs"),
  clearHiddenJobs: document.getElementById("clear-hidden-jobs"),
  sortButtons: {
    role: document.getElementById("role-sort"),
    company: document.getElementById("company-sort"),
    posted: document.getElementById("posted-sort")
  },
  sortHeaders: {
    role: document.getElementById("role-header"),
    company: document.getElementById("company-header"),
    posted: document.getElementById("posted-header")
  },
  subtitle: document.getElementById("run-subtitle"),
  siteRunFooter: document.getElementById("site-run-footer"),
  parseWarningFooter: document.getElementById("parse-warning-footer"),
  summaryTotal: document.getElementById("summary-total"),
  summarySite: document.getElementById("summary-site"),
  summaryTotalNote: document.getElementById("summary-total-note"),
  summaryEasy: document.getElementById("summary-easy"),
  summaryEasyShare: document.getElementById("summary-easy-share"),
  summaryReviewing: document.getElementById("summary-reviewing"),
  summaryReviewingShare: document.getElementById("summary-reviewing-share"),
  summaryFresh: document.getElementById("summary-fresh"),
  showingCount: document.getElementById("showing-count"),
  feedback: document.getElementById("feedback")
};
const LAST_SITE_KEY = "ui.lastSite";
const HISTORY_OPENED_KEYS = ["linkedin", "naukri", "indeed"].map(
  (siteId) => STORAGE_API.keysForSite(siteId).openedJobs
);

function getSkipTitlesStorageKey(siteId = SITE_ID) {
  return `${siteId}:skipTitles`;
}

let storageSnapshot = {
  jobsById: {},
  openedJobsById: {},
  hiddenJobsById: {},
  filterSettings: { locations: [], experienceYears: [], hideOpened: true, hideHiddenJobs: true },
  collectorState: null,
  resultsSelectedTab: null,
  skipTitles: []
};
let selectedTab = APPLY_TABS[0];
let showingHiddenJobs = false;
let tabBeforeHiddenJobsView = null;
let editingSkipTitle = null;
let siteCounts = { linkedin: 0, naukri: 0, indeed: 0 };
let openedWriteQueue = Promise.resolve();
let hiddenWriteQueue = Promise.resolve();
let filterWriteQueue = Promise.resolve();
const selectedJobIds = new Set();
let visibleJobIds = [];
let sortState = { key: "posted", direction: "descending" };

function getStorageKeys(siteId) {
  return Object.freeze({
    ...STORAGE_API.keysForSite(siteId),
    jobs: "records",
    opened: STORAGE_API.keysForSite(siteId).openedJobs,
    hidden: STORAGE_API.keysForSite(siteId).hiddenJobs,
    filters: STORAGE_API.keysForSite(siteId).filters
  });
}

function configureSite(siteId) {
  const adapter = globalThis.JobCollectorSiteRegistry.getAdapter(siteId);
  if (!adapter) {
    throw new Error(`No results adapter is registered for site "${siteId}".`);
  }
  SITE_ID = siteId;
  SITE_ADAPTER = adapter;
  STORAGE_KEYS = getStorageKeys(siteId);
  APPLY_TABS = adapter.ui.tabs.map((tab) => tab.id);
  TAB_LABELS = Object.fromEntries(adapter.ui.tabs.map((tab) => [tab.id, tab.label]));
  selectedTab = ALL_TAB;
  elements.brandLink.href = `results.html?site=${encodeURIComponent(siteId)}`;
  document.title = `${adapter.label} Jobs`;
  elements.applicantReviewFilter.closest("label").hidden = siteId !== "linkedin";
  elements.subtitle.hidden = siteId !== "linkedin";
  elements.siteRunFooter.hidden = siteId !== "naukri";
  elements.experienceFilterControl.hidden = siteId !== "naukri";
  elements.parseWarningFooter.hidden = true;
  elements.search.placeholder = siteId === "naukri"
    ? "Search role, company, agency, or skills"
    : siteId === "indeed"
      ? "Search role, company, or location"
    : "Search role or company";
  elements.searchLabel.textContent = siteId === "naukri"
    ? "Search jobs by role, company, hiring agency, or skills"
    : siteId === "indeed"
      ? "Search jobs by role, company, or location"
    : "Search jobs by role or company";
  elements.easyTab.hidden = false;
  elements.directTab.hidden = !adapter.ui.tabs.some((tab) => tab.id === "Direct Apply");
  elements.companyTab.hidden = !adapter.ui.tabs.some((tab) => (
    tab.id === "Company Apply" || tab.id === "Company Site"
  ));
  elements.skipTitlesButton.hidden = false;
  elements.skipTitleHeading.textContent = `Skip titles — ${adapter.label}`;
  closeSettingsMenu();
  elements.linkedinSite.setAttribute("aria-pressed", String(siteId === "linkedin"));
  elements.naukriSite.setAttribute("aria-pressed", String(siteId === "naukri"));
  elements.indeedSite.setAttribute("aria-pressed", String(siteId === "indeed"));
  document.body.dataset.site = siteId;
  if (siteId === "naukri" || siteId === "indeed") {
    document.body.style.setProperty("--site-accent", adapter.ui.accent);
  }
  renderHeaders();
  renderTabLabels();
}

function renderTabLabels() {
  elements.allTab.hidden = false;
  elements.allTab.textContent = "All (0)";
  for (const [index, tab] of APPLY_TABS.entries()) {
    const button = getTabButton(tab, index);
    button.hidden = false;
    button.textContent = `${TAB_LABELS[tab]} (0)`;
  }
  for (const button of [elements.easyTab, elements.directTab, elements.companyTab]) {
    if (!APPLY_TABS.some((tab, index) => getTabButton(tab, index) === button)) {
      button.hidden = true;
    }
  }
}

function getTabButton(tab, index = APPLY_TABS.indexOf(tab)) {
  if (tab === ALL_TAB) {
    return elements.allTab;
  }
  if (tab === "Direct Apply") {
    return elements.directTab;
  }
  if (tab === "Company Apply" || tab === "Company Site") {
    return elements.companyTab;
  }
  return index === 0 ? elements.easyTab : elements.companyTab;
}

function renderHeaders() {
  elements.columnHeadings.replaceChildren();
  elements.sortButtons = {};
  elements.sortHeaders = {};
  for (const column of SITE_ADAPTER.ui.columns) {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = column.label;
    if (column.id === "number") {
      heading.className = "number-column";
    } else if (column.sortable) {
      heading.id = `${column.id}-header`;
      heading.setAttribute("aria-sort", "none");
      const button = document.createElement("button");
      button.id = `${column.id}-sort`;
      button.className = "sort-button";
      button.type = "button";
      button.dataset.sort = column.id;
      button.textContent = column.label;
      button.addEventListener("click", () => {
        sortState = {
          key: column.id,
          direction: sortState.key === column.id && sortState.direction === "ascending"
            ? "descending"
            : "ascending"
        };
        render();
      });
      heading.replaceChildren(button);
      elements.sortButtons[column.id] = button;
      elements.sortHeaders[column.id] = heading;
    } else if (column.id === "apply") {
      heading.className = "apply-column";
    }
    if (column.id === "number") {
      const selectHeading = document.createElement("th");
      selectHeading.className = "select-column";
      const selectAllJobs = document.createElement("input");
      selectAllJobs.id = "select-all-jobs";
      selectAllJobs.className = "job-selection select-all-jobs";
      selectAllJobs.type = "checkbox";
      selectAllJobs.setAttribute("aria-label", "Select all visible jobs to hide");
      selectAllJobs.title = "Select all visible jobs to hide";
      selectAllJobs.addEventListener("change", () => {
        for (const jobId of visibleJobIds) {
          if (selectAllJobs.checked) {
            selectedJobIds.add(jobId);
          } else {
            selectedJobIds.delete(jobId);
          }
        }
        render();
      });
      selectHeading.appendChild(selectAllJobs);
      elements.selectAllJobs = selectAllJobs;
      elements.columnHeadings.appendChild(selectHeading);
    }
    elements.columnHeadings.appendChild(heading);
  }
}

function renderSiteCounts(namespacedRecords) {
  const records = namespacedRecords && typeof namespacedRecords === "object"
    ? namespacedRecords
    : {};
  siteCounts = {
    linkedin: Object.keys(records).filter((key) => key.startsWith("linkedin:")).length,
    naukri: Object.keys(records).filter((key) => key.startsWith("naukri:")).length,
    indeed: Object.keys(records).filter((key) => key.startsWith("indeed:")).length
  };
  elements.linkedinSiteCount.textContent = String(siteCounts.linkedin);
  elements.naukriSiteCount.textContent = String(siteCounts.naukri);
  elements.indeedSiteCount.textContent = String(siteCounts.indeed);
  elements.linkedinSite.classList.toggle("is-empty", siteCounts.linkedin === 0);
  elements.naukriSite.classList.toggle("is-empty", siteCounts.naukri === 0);
  elements.indeedSite.classList.toggle("is-empty", siteCounts.indeed === 0);
}

function getRecords() {
  const jobs = storageSnapshot.jobsById || {};
  if (typeof jobs !== "object" || Array.isArray(jobs)) {
    throw new Error("Stored jobs data is not a job-ID keyed object.");
  }
  return Object.values(jobs).filter((record) => (
    record && typeof record === "object" && !Array.isArray(record)
  ));
}

function getRecordsForTab(records, tab) {
  if (tab === ALL_TAB) {
    return records;
  }
  return records.filter((record) => getRecordTab(record) === tab);
}

function normalizeFilterSettings(value) {
  const settings = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const allowedLocations = ["hyderabad", "bengaluru", "other"];
  const selectedLocations = Array.isArray(settings.locations)
    ? settings.locations.filter((location) => allowedLocations.includes(location))
    : [];
  const selectedExperience = normalizeExperienceBands(settings.experienceYears);
  return {
    locations: Array.from(new Set(selectedLocations)),
    experienceYears: Array.from(new Set(selectedExperience)),
    hideOpened: true,
    hideHiddenJobs: true
  };
}

function normalizeExperienceBands(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const selected = new Set();
  for (const value of values) {
    if (EXPERIENCE_BANDS.includes(value)) {
      selected.add(value);
      continue;
    }
    const legacyYear = Number(value);
    if (legacyYear >= 0 && legacyYear <= 3) {
      selected.add("under-3");
    } else if (legacyYear === 4) {
      selected.add("4-5");
    } else if (legacyYear >= 5) {
      selected.add("4-5");
      selected.add("6-plus");
    }
  }
  return EXPERIENCE_BANDS.filter((band) => selected.has(band));
}

function setFilterControls(settings) {
  for (const [location, checkbox] of Object.entries(elements.locationFilters)) {
    checkbox.checked = settings.locations.includes(location);
  }
  for (const [band, checkbox] of Object.entries(elements.experienceFilters)) {
    checkbox.checked = settings.experienceYears.includes(band);
  }
}

function readFilterControls() {
  return {
    locations: Object.entries(elements.locationFilters)
      .filter(([, checkbox]) => checkbox.checked)
      .map(([location]) => location),
    experienceYears: Object.entries(elements.experienceFilters)
      .filter(([, checkbox]) => checkbox.checked)
      .map(([band]) => band),
    hideOpened: true,
    hideHiddenJobs: true
  };
}

function getRecordLocation(record) {
  return [
    record.location,
    record.locationRaw,
    Array.isArray(record.locations) ? record.locations.join(", ") : ""
  ].filter((value) => typeof value === "string").join(", ");
}

function matchesLocationFilter(record, selectedLocations) {
  if (selectedLocations.length === 0) {
    return true;
  }
  const location = getRecordLocation(record);
  const hasHyderabad = /\bhyderabad\b/i.test(location);
  const hasBengaluru = /\b(?:bengaluru|bangalore)\b/i.test(location);
  return selectedLocations.some((selected) => (
    selected === "hyderabad" && hasHyderabad
    || selected === "bengaluru" && hasBengaluru
    || selected === "other" && !hasHyderabad && !hasBengaluru
  ));
}

function matchesExperienceFilter(record, selectedBands) {
  if (SITE_ID !== "naukri" || selectedBands.length === 0) {
    return true;
  }
  const value = String(record.experience || "").trim();
  const range = value.match(/(\d+(?:\.\d+)?)\s*(?:(?:-\s*|to\s*)(\d+(?:\.\d+)?|\+)|(\+))/i);
  let minimum;
  let maximum;
  if (range) {
    minimum = Number(range[1]);
    maximum = range[2] === "+" || range[3]
      ? Infinity
      : Number(range[2]);
  } else {
    const single = value.match(/^\s*(\d+(?:\.\d+)?)\s*(?:yrs?|years?)\b/i);
    if (!single) {
      return false;
    }
    minimum = Number(single[1]);
    maximum = minimum;
  }
  const bands = {
    "under-3": [0, 3],
    "4-5": [4, 5],
    "6-plus": [6, Infinity]
  };
  return selectedBands.some((band) => (
    minimum <= bands[band][1] && maximum >= bands[band][0]
  ));
}

function matchesJobFilters(record, settings) {
  return matchesLocationFilter(record, settings.locations)
    && matchesExperienceFilter(record, settings.experienceYears);
}

function matchesSearchTerm(value, term) {
  if (!term) {
    return true;
  }
  if (/\s/.test(term)) {
    return value.includes(term);
  }
  const isWordCharacter = (character) => /[\p{L}\p{N}_]/u.test(character);
  let index = value.indexOf(term);
  while (index !== -1) {
    const before = index > 0 ? value[index - 1] : "";
    const after = value[index + term.length] || "";
    if (
      (!isWordCharacter(term[0]) || !isWordCharacter(before))
      && (!isWordCharacter(term[term.length - 1]) || !isWordCharacter(after))
    ) {
      return true;
    }
    index = value.indexOf(term, index + 1);
  }
  return false;
}

function getRecordTab(record) {
  return typeof SITE_ADAPTER.ui.tabFor === "function"
    ? SITE_ADAPTER.ui.tabFor(record)
    : record.applyType;
}

function isRecordOpened(record) {
  const jobId = String(record.jobId || "");
  return storageSnapshot.openedJobsById[jobId] === true
    || (SITE_ID === "indeed" && record.visited === true);
}

function validHttpUrl(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch (_error) {
    return null;
  }
}

function getLinkedInJobUrl(record) {
  if (typeof record.jobId !== "string" || !/^\d+$/.test(record.jobId)) {
    return null;
  }
  return `https://www.linkedin.com/jobs/view/${record.jobId}/`;
}

function getApplyUrl(record, tab) {
  return validHttpUrl(SITE_ADAPTER.ui.applyUrl({ ...record, applyType: tab }));
}

async function readSiteJobs() {
  return STORAGE_API.getJobs(SITE_ID);
}

function unpackSiteJobs(namespacedRecords) {
  const prefix = `${SITE_ID}:`;
  return Object.fromEntries(
    Object.entries(namespacedRecords || {})
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, record]) => [key.slice(prefix.length), record])
  );
}

function getInitial(company) {
  return Array.from(String(company || "").trim())[0]?.toLocaleUpperCase() || "?";
}

function formatRunDate(runState) {
  if (!runState || typeof runState.startedAt !== "string") {
    return "No run date yet";
  }
  const date = new Date(runState.startedAt);
  if (Number.isNaN(date.getTime())) {
    return "Run date unavailable";
  }
  const label = `Run started ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date)}`;
  return `${label} · ${Number.isInteger(runState.capturedCount) ? runState.capturedCount : 0} captured`;
}

function formatAbsoluteDate(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const year = parts.find((part) => part.type === "year")?.value || "";
  return `~${day} ${month} ${year}`.trim();
}

function getIndeedPostedTimestamp(record) {
  if (
    record.sponsored === true
    || record.postedApprox
    || /^30\+/i.test(String(record.postedText || "").trim())
  ) {
    return null;
  }
  const storedEstimate = Date.parse(String(record.postedDateEstimate || ""));
  if (Number.isFinite(storedEstimate)) {
    return storedEstimate;
  }

  const relativeText = String(record.postedText || "").trim();
  const capturedAt = Date.parse(String(record.capturedAt || ""));
  if (Number.isFinite(capturedAt)) {
    if (/^(?:just posted|today)$/i.test(relativeText)) {
      return capturedAt;
    }
    const daysAgo = relativeText.match(/^(\d+)\s+days?\s+ago$/i);
    if (daysAgo) {
      return capturedAt - Number(daysAgo[1]) * 24 * 60 * 60 * 1000;
    }
  }

  const pubDate = record.pubDate;
  let publishedAt = typeof pubDate === "number" || /^\d+$/.test(String(pubDate || ""))
    ? Number(pubDate)
    : Date.parse(String(pubDate || ""));
  if (Number.isFinite(publishedAt) && publishedAt > 0 && publishedAt < 1e11) {
    publishedAt *= 1000;
  }
  return Number.isFinite(publishedAt)
    && publishedAt > 0
    && Number.isFinite(new Date(publishedAt).getTime())
    ? publishedAt
    : null;
}

function getNaukriPostedAge(record) {
  const text = String(record.postedText || "").trim().toLowerCase();
  if (/^(?:just now|few hours ago|today)$/.test(text)) {
    return 0;
  }
  const match = text.match(/^(\d+)\+?\s+(hours?|days?|weeks?|months?)\s+ago$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = match[2].replace(/s$/, "");
  return amount * (unit === "hour" ? 1 / 24 : unit === "day" ? 1 : unit === "week" ? 7 : 30);
}

function comparePostedRecords(first, second, direction, siteId = SITE_ID) {
  if (siteId === "indeed") {
    const postedKind = (record) => {
      if (record.sponsored === true) {
        return { type: "unknown", timestamp: null };
      }
      if (record.postedApprox || /^30\+/i.test(String(record.postedText || "").trim())) {
        return { type: "approximate", timestamp: null };
      }
      const timestamp = getIndeedPostedTimestamp(record);
      return timestamp === null
        ? { type: "unknown", timestamp: null }
        : { type: "dated", timestamp };
    };
    const firstPosted = postedKind(first);
    const secondPosted = postedKind(second);
    if (firstPosted.type !== secondPosted.type) {
      const ranks = direction > 0
        ? { approximate: 0, dated: 1, unknown: 2 }
        : { dated: 0, approximate: 1, unknown: 2 };
      return ranks[firstPosted.type] - ranks[secondPosted.type];
    }
    return firstPosted.type === "dated"
      ? (firstPosted.timestamp - secondPosted.timestamp) * direction
      : 0;
  }

  if (siteId === "naukri") {
    const firstAge = getNaukriPostedAge(first);
    const secondAge = getNaukriPostedAge(second);
    if (firstAge !== null && secondAge !== null) {
      return (secondAge - firstAge) * direction;
    }
    if (firstAge !== null || secondAge !== null) {
      return firstAge !== null ? -1 : 1;
    }
  }

  const firstDate = Date.parse(first.postedDateEstimate || first.capturedAt || "");
  const secondDate = Date.parse(second.postedDateEstimate || second.capturedAt || "");
  const normalizedFirst = Number.isNaN(firstDate) ? -Infinity : firstDate;
  const normalizedSecond = Number.isNaN(secondDate) ? -Infinity : secondDate;
  return (normalizedFirst - normalizedSecond) * direction;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildStandaloneReport(records, openedJobsById, runState, savedSelectedTab, savedFilterSettings) {
  const reportTabs = SITE_ADAPTER.ui.tabs.map(({ id, label }) => ({ id, label }));
  const reportFilterSettings = normalizeFilterSettings(savedFilterSettings);
  const reportRecords = records.map((record) => ({
    jobId: String(record.jobId || ""),
    title: String(record.title || "Untitled role"),
    company: String(record.company || "Company not listed"),
    companyLogoUrl: validHttpUrl(record.companyLogoUrl || record.logo),
    location: String(
      record.location
      || (Array.isArray(record.locations) ? record.locations.join(", ") : "")
      || record.locationRaw
      || "Location not listed"
    ),
    experience: String(record.experience || ""),
    tabId: getRecordTab(record),
    companyApplyUrl: validHttpUrl(record.companyApplyUrl),
    postedType: record.postedType,
    postedText: String(record.postedText || "Date not listed"),
    postedDateEstimate: String(record.postedDateEstimate || ""),
    postedApprox: record.postedApprox === true,
    pubDate: typeof record.pubDate === "number" || typeof record.pubDate === "string"
      ? record.pubDate
      : null,
    applicantReviewStatus: record.applicantReviewStatus === "actively-reviewing"
      ? "actively-reviewing"
      : "not-indicated",
    visited: record.visited === true,
    capturedAt: String(record.capturedAt || ""),
    url: SITE_ID === "linkedin"
      ? getLinkedInJobUrl(record) || validHttpUrl(record.url)
      : validHttpUrl(SITE_ADAPTER.ui.applyUrl({
        ...record,
        applyType: getRecordTab(record)
      })) || validHttpUrl(record.url)
  }));
  const embeddedRecords = JSON.stringify(reportRecords)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const embeddedOpened = JSON.stringify(openedJobsById || {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const embeddedTabs = JSON.stringify(reportTabs).replace(/</g, "\\u003c");
  const embeddedFilters = JSON.stringify(reportFilterSettings).replace(/</g, "\\u003c");
  const runDate = formatRunDate(runState);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(SITE_ADAPTER.label)} Jobs — ${records.length} ${records.length === 1 ? "job" : "jobs"}</title>
  <style>
    :root{color-scheme:light dark;font:14px Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-synthesis:none;text-rendering:optimizeLegibility;--page:#f4f7fb;--surface:#fff;--surface-soft:#f7f9fc;--text:#172333;--muted:#5c6878;--border:#e2e8f0;--easy:#0a66c2;--easy-soft:#e8f2ff;--company:#087f78;--company-soft:#e5f7f4;--opened:#536171;--focus:#2e78d2}
    *{box-sizing:border-box}body{min-width:320px;min-height:100vh;margin:0;background:var(--page);color:var(--text)}
    button,input{color:inherit;font:inherit}button:focus-visible,a:focus-visible,input:focus-visible,tr:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
    .page-shell{width:min(1480px,calc(100% - 64px));margin:0 auto;padding:30px 0 36px}
    .page-header{display:flex;min-height:42px;align-items:baseline;gap:18px;margin-bottom:22px}
    h1{margin:0;font-size:1.55rem;letter-spacing:-.04em;white-space:nowrap}.subtitle,.total-count{margin:0;color:var(--muted);font-size:.88rem}
    .total-count{margin-left:auto;padding:6px 11px;border:1px solid var(--border);border-radius:999px;background:var(--surface);font-weight:650;white-space:nowrap}
    .toolbar{display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px}
    .tabs,.filters{display:flex;align-items:center;gap:8px}.filters{flex:1 1 600px;flex-wrap:wrap;justify-content:flex-start;min-width:0}.tabs{flex:0 0 auto;gap:4px;padding:4px;border:1px solid var(--border);border-radius:12px;background:var(--surface-soft)}
    .tab{min-height:40px;padding:8px 15px;border:1px solid transparent;border-radius:9px;background:var(--surface);color:var(--muted);cursor:pointer;font-size:.9rem;font-weight:650}
    .tab:hover{color:var(--text)}.tab[aria-selected="true"]{background:var(--easy);color:#fff;box-shadow:0 2px 5px rgb(10 42 78 / 16%)}
    body[data-active-tab="Company Site"] .tab[aria-selected="true"]{background:var(--company)}
    .search-control input{width:min(280px,28vw);min-width:190px;min-height:40px;padding:8px 13px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-size:.88rem}
    .search-control input:focus{border-color:var(--easy);outline:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--easy) 16%,transparent)}
    body[data-active-tab="Company Site"] .search-control input:focus{border-color:var(--company);box-shadow:0 0 0 3px color-mix(in srgb,var(--company) 16%,transparent)}
    .review-filter select{min-height:40px;padding:8px 30px 8px 11px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-size:.84rem}
    .filter-group{display:inline-flex;align-items:center;gap:8px;min-width:0;margin:0;padding:3px 9px 6px;border:1px solid var(--border);border-radius:9px;color:var(--muted);font-size:.78rem}.filter-group legend{padding:0 3px;font-weight:650}.filter-group label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}.filter-group input{width:14px;height:14px;margin:0;accent-color:var(--easy)}
    .hide-opened-control{display:inline-flex;align-items:center;gap:6px;color:var(--muted);cursor:pointer;font-size:.86rem;white-space:nowrap}
    .hide-opened-control input{width:15px;height:15px;margin:0;accent-color:var(--easy)}body[data-active-tab="Company Site"] .hide-opened-control input{accent-color:var(--company)}
    .table-wrap{max-height:min(760px,calc(100vh - 230px));min-height:360px;overflow:auto;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:0 8px 26px rgb(22 42 66 / 6%),0 1px 2px rgb(22 42 66 / 4%)}
    table{width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;text-align:left}
    thead th{position:sticky;z-index:1;top:0;height:48px;padding:0 16px;border-bottom:1px solid var(--border);background:var(--surface-soft);color:var(--muted);font-size:.75rem;font-weight:700;letter-spacing:.065em;text-transform:uppercase}
    tbody tr{height:64px;transition:background-color 140ms ease,opacity 140ms ease}tbody tr:hover{background:color-mix(in srgb,var(--easy-soft) 35%,var(--surface))}
    body[data-active-tab="Company Site"] tbody tr:hover{background:color-mix(in srgb,var(--company-soft) 42%,var(--surface))}
    tbody tr.is-opened{opacity:.62}tbody td{padding:10px 16px;border-bottom:1px solid var(--border);font-size:.88rem;vertical-align:middle}tbody tr:last-child td{border-bottom:0}
    .number-column{width:4.5%;color:var(--muted);text-align:right}.sort-button{display:inline-flex;align-items:center;gap:7px;padding:4px 0;border:0;background:transparent;color:inherit;cursor:pointer;font-size:inherit;font-weight:inherit;letter-spacing:inherit;text-transform:inherit}
    .sort-button:hover{color:var(--text)}.sort-indicator{color:var(--easy);font-size:.95rem;line-height:1}body[data-active-tab="Company Site"] .sort-indicator{color:var(--company)}
    .role-cell{width:25%;font-size:.91rem;font-weight:650;line-height:1.4;overflow-wrap:break-word}.company-cell{width:22%}
    .company-row{display:flex;min-width:0;align-items:center;gap:10px}.company-mark{display:grid;width:34px;height:34px;flex:0 0 34px;place-items:center;overflow:hidden;border-radius:9px;background:hsl(var(--avatar-hue,210) 48% 89%);color:hsl(var(--avatar-hue,210) 48% 27%);font-size:.8rem;font-weight:750}
    .company-mark img{width:100%;height:100%;object-fit:contain}.company-name{min-width:0;font-size:.87rem;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .location-cell{width:17%;color:var(--muted);line-height:1.4}.posted-cell{width:21%}.posted-content{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
    .posted-badge{display:inline-flex;min-height:22px;align-items:center;padding:3px 8px;border-radius:999px;background:var(--surface-soft);color:var(--muted);font-size:.7rem;font-weight:700}
    .posted-badge.is-reposted{background:#fff1df;color:#8a4b00}.posted-relative{color:var(--text);font-size:.82rem}.absolute-date{display:block;margin-top:2px;color:var(--muted);font-size:.75rem}
    .visited-chip{display:inline-flex;align-items:center;margin:4px 5px 0 0;padding:2px 7px;border-radius:999px;background:#edf1f5;color:#536171;font-size:.68rem;font-weight:650}
    .review-status-tag{display:inline-flex;align-items:center;margin:4px 5px 0 0;padding:3px 8px;border-radius:999px;background:var(--surface-soft);color:var(--muted);font-size:.68rem;font-weight:650;line-height:1.35}
    .review-status-tag.is-active{background:#e6f6ed;color:#17633a}
    .apply-column,.apply-cell{width:10.5%;text-align:right}.apply-cell-content{display:inline-flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px 8px}
    .apply-link{display:inline-flex;min-height:32px;align-items:center;justify-content:center;padding:6px 14px;border-radius:999px;background:var(--easy);color:#fff;font-size:.82rem;font-weight:700;text-decoration:none;white-space:nowrap}
    body[data-active-tab="Company Site"] .apply-link{background:var(--company)}.apply-link[aria-disabled="true"]{cursor:not-allowed;opacity:.55}
    .via-linkedin{color:var(--muted);font-size:.72rem;white-space:nowrap}.opened-tag{display:inline-flex;align-items:center;gap:4px;color:var(--opened);font-size:.72rem;white-space:nowrap}
    .opened-tag a{color:inherit;font-size:.7rem;text-decoration:underline;text-underline-offset:2px}.empty-state{margin:0;padding:42px 16px;color:var(--muted);text-align:center}
    .visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;clip-path:inset(50%)}
    @media(prefers-color-scheme:dark){:root{--page:#111a23;--surface:#192531;--surface-soft:#202e3b;--text:#edf3f8;--muted:#aab7c4;--border:#344553;--easy:#3285d6;--easy-soft:#203b56;--company:#13988e;--company-soft:#1d4945;--opened:#b0bdc9}.posted-badge.is-reposted{background:#4a351f;color:#ffd29b}.review-status-tag.is-active{background:#1d4933;color:#a9e6c0}}
    @media(max-width:720px){.page-shell{width:min(100% - 24px,560px);padding-top:18px}.page-header{flex-wrap:wrap;gap:4px 12px;margin-bottom:14px}h1{font-size:1.35rem}.total-count{margin-left:0}
    .toolbar{align-items:stretch;flex-direction:column;gap:10px}.tabs{display:grid;grid-template-columns:1fr 1fr}.filters{flex:0 1 auto;justify-content:flex-start}.search-control,.review-filter{flex:1 1 100%}.search-control input,.review-filter select{width:100%}.filter-group{flex:1 1 auto;justify-content:space-around}
    .table-wrap{max-height:none;min-height:0;overflow:visible;border:0;background:transparent;box-shadow:none}table,tbody{display:block;width:100%}
    thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap}tbody{display:grid;gap:8px}
    tbody tr{display:grid;height:auto;grid-template-columns:minmax(0,1fr) auto;padding:11px 13px;border:1px solid var(--border);border-radius:9px;background:var(--surface)}
    tbody td{min-width:0;padding:4px 0;border:0}.number-column,tbody td.number-column{display:none}.role-cell{grid-column:1/-1;grid-row:1;max-width:none;padding-bottom:5px;font-size:.93rem}
    .company-cell{grid-column:1;grid-row:2}.location-cell{grid-column:1;grid-row:3;display:flex;align-items:baseline;gap:10px}.posted-cell{grid-column:1;grid-row:4}
    .location-cell::before,.posted-cell::before{flex:0 0 56px;color:var(--muted);content:attr(data-label);font-size:.65rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
    .apply-cell{grid-column:2;grid-row:2/5;display:flex;align-items:center;justify-content:flex-end;width:auto}.apply-cell-content{align-items:flex-end;flex-direction:column}.company-name{max-width:56vw}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body>
  <main class="page-shell">
    <header class="page-header">
      <h1>${escapeHtml(SITE_ADAPTER.label)} Jobs</h1>
      <p class="subtitle">${escapeHtml(runDate)}</p>
      <p class="total-count">${records.length} ${records.length === 1 ? "job" : "jobs"}</p>
    </header>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Job application type">
        <button id="easy-tab" class="tab" type="button" role="tab" aria-selected="true" aria-controls="results-panel" tabindex="0">Easy Apply (0)</button>
        <button id="direct-tab" class="tab" type="button" role="tab" aria-selected="false" aria-controls="results-panel" tabindex="-1"${reportTabs.some((tab) => tab.id === "Direct Apply") ? "" : " hidden"}>Direct Apply (0)</button>
        <button id="company-tab" class="tab" type="button" role="tab" aria-selected="false" aria-controls="results-panel" tabindex="-1">Company Apply (0)</button>
      </div>
      <div class="filters">
        <label class="search-control"><span class="visually-hidden">Search jobs by role or company</span><input id="search" type="search" autocomplete="off" placeholder="Search role or company"></label>
        <label class="review-filter"><span class="visually-hidden">Filter by applicant review status</span><select id="applicant-review-filter"><option value="">All review statuses</option><option value="actively-reviewing">Actively reviewing</option><option value="not-indicated">No status shown</option></select></label>
        <fieldset class="filter-group"><legend>Location</legend>
          <label><input class="location-filter" data-location="hyderabad" type="checkbox"${reportFilterSettings.locations.includes("hyderabad") ? " checked" : ""}> Hyderabad</label>
          <label><input class="location-filter" data-location="bengaluru" type="checkbox"${reportFilterSettings.locations.includes("bengaluru") ? " checked" : ""}> Bengaluru</label>
          <label><input class="location-filter" data-location="other" type="checkbox"${reportFilterSettings.locations.includes("other") ? " checked" : ""}> Other</label>
        </fieldset>
        ${SITE_ID === "naukri" ? `        <fieldset class="filter-group"><legend>Experience (years)</legend>
          ${[
    { id: "under-3", label: "3Y and below", aria: "3 years and below experience" },
    { id: "4-5", label: "4-5Y", aria: "4 to 5 years experience" },
    { id: "6-plus", label: "6Y+", aria: "6 or more years experience" }
  ].map((band) => (
    `<label><input class="experience-filter" data-band="${band.id}" aria-label="${band.aria}" type="checkbox"${reportFilterSettings.experienceYears.includes(band.id) ? " checked" : ""}> ${band.label}</label>`
  )).join("")}
        </fieldset>` : ""}
        <label class="hide-opened-control"><input id="hide-opened" type="checkbox"${reportFilterSettings.hideOpened ? " checked" : ""}><span>Hide opened</span></label>
      </div>
    </div>
    <section id="results-panel" role="tabpanel" aria-labelledby="easy-tab" tabindex="0">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th scope="col" class="number-column">#</th>
            <th id="role-header" scope="col" aria-sort="none"><button id="role-sort" class="sort-button" type="button" data-sort="role">Role</button></th>
            <th id="company-header" scope="col" aria-sort="none"><button id="company-sort" class="sort-button" type="button" data-sort="company">Company</button></th>
            <th scope="col">Location</th>
            <th id="posted-header" scope="col" aria-sort="descending"><button id="posted-sort" class="sort-button" type="button" data-sort="posted">Posted <span class="sort-indicator">↓</span></button></th>
            <th scope="col" class="apply-column">Apply</th>
          </tr></thead>
          <tbody id="job-table-body"></tbody>
        </table>
      </div>
      <p id="empty-state" class="empty-state" hidden></p>
    </section>
  </main>
  <script>
    "use strict";
    const records = ${embeddedRecords};
    const initiallyOpened = ${embeddedOpened};
    const tabs = ${embeddedTabs};
    const easyTab = document.getElementById("easy-tab");
    const directTab = document.getElementById("direct-tab");
    const companyTab = document.getElementById("company-tab");
    const buttonForTab = (tab, index) => tab.id === "Direct Apply"
      ? directTab
      : tab.id === "Company Apply" || tab.id === "Company Site"
        ? companyTab
        : index === 0 ? easyTab : companyTab;
    const body = document.getElementById("job-table-body");
    const search = document.getElementById("search");
    const applicantReviewFilter = document.getElementById("applicant-review-filter");
    const hideOpened = document.getElementById("hide-opened");
    const locationFilters = Array.from(document.querySelectorAll(".location-filter"));
    const experienceFilters = Array.from(document.querySelectorAll(".experience-filter"));
    const empty = document.getElementById("empty-state");
    const panel = document.getElementById("results-panel");
    const sortHeaders = {
      role: document.getElementById("role-header"),
      company: document.getElementById("company-header"),
      posted: document.getElementById("posted-header")
    };
    const sortButtons = {
      role: document.getElementById("role-sort"),
      company: document.getElementById("company-sort"),
      posted: document.getElementById("posted-sort")
    };
    const storageKey = "${escapeHtml(SITE_ID)}-jobs-opened-${escapeHtml(runState && runState.runId || "report")}";
    const tabStorageKey = "${escapeHtml(SITE_ID)}-jobs-tab-${escapeHtml(runState && runState.runId || "report")}";
    const filterStorageKey = "${escapeHtml(SITE_ID)}-jobs-filters-${escapeHtml(runState && runState.runId || "report")}";
    const initialFilters = ${embeddedFilters};
    const filterSettings = {
      locations: [...initialFilters.locations],
      experienceYears: [...initialFilters.experienceYears],
      hideOpened: initialFilters.hideOpened
    };
    const normalizeExperienceBands = (values) => {
      if (!Array.isArray(values)) return [];
      const selected = new Set();
      for (const value of values) {
        if (["under-3", "4-5", "6-plus"].includes(value)) {
          selected.add(value);
        } else if (Number(value) >= 0 && Number(value) <= 3) {
          selected.add("under-3");
        } else if (Number(value) === 4) {
          selected.add("4-5");
        } else if (Number(value) >= 5) {
          selected.add("4-5");
          selected.add("6-plus");
        }
      }
      return ["under-3", "4-5", "6-plus"].filter((band) => selected.has(band));
    };
    let selectedTab = tabs[0].id;
    let sortState = { key: "posted", direction: "descending" };
    let opened = { ...initiallyOpened };
    try {
      const savedOpened = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (savedOpened && typeof savedOpened === "object" && !Array.isArray(savedOpened)) {
        opened = { ...opened, ...savedOpened };
      }
    } catch (_error) {}
    try {
      const savedFilters = JSON.parse(localStorage.getItem(filterStorageKey) || "null");
      if (savedFilters && typeof savedFilters === "object" && !Array.isArray(savedFilters)) {
        filterSettings.locations = Array.isArray(savedFilters.locations)
          ? savedFilters.locations.filter((value) => ["hyderabad", "bengaluru", "other"].includes(value))
          : filterSettings.locations;
        filterSettings.experienceYears = normalizeExperienceBands(savedFilters.experienceYears);
        filterSettings.hideOpened = savedFilters.hideOpened === true;
      }
    } catch (_error) {}
    const syncFilterControls = () => {
      hideOpened.checked = filterSettings.hideOpened;
      for (const checkbox of locationFilters) {
        checkbox.checked = filterSettings.locations.includes(checkbox.dataset.location);
      }
      for (const checkbox of experienceFilters) {
        checkbox.checked = filterSettings.experienceYears.includes(checkbox.dataset.band);
      }
    };
    const saveFilters = () => {
      filterSettings.locations = locationFilters
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.dataset.location);
      filterSettings.experienceYears = experienceFilters
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.dataset.band);
      filterSettings.hideOpened = hideOpened.checked;
      try { localStorage.setItem(filterStorageKey, JSON.stringify(filterSettings)); } catch (_error) {}
      render();
    };
    syncFilterControls();
    try {
      const localTab = localStorage.getItem(tabStorageKey);
      if (tabs.some((tab) => tab.id === localTab)) selectedTab = localTab;
    } catch (_error) {}
    const text = (tag, className, value) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = value;
      return node;
    };
    const absoluteDate = (value) => {
      if (typeof value !== "string" || !value) return "";
      const date = new Date(value.slice(0, 10) + "T12:00:00");
      if (Number.isNaN(date.getTime())) return "";
      return "~" + new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", year: "numeric" }).format(date);
    };
    const postedTimestamp = (record) => {
      if (record.postedApprox || /^30\\+/i.test(String(record.postedText || "").trim())) return null;
      const estimate = Date.parse(String(record.postedDateEstimate || ""));
      if (Number.isFinite(estimate)) return estimate;
      const relativeText = String(record.postedText || "").trim();
      const capturedAt = Date.parse(String(record.capturedAt || ""));
      if (Number.isFinite(capturedAt)) {
        if (/^(?:just posted|today)$/i.test(relativeText)) return capturedAt;
        const daysAgo = relativeText.match(/^(\\d+)\\s+days?\\s+ago$/i);
        if (daysAgo) return capturedAt - Number(daysAgo[1]) * 86400000;
      }
      let pubDate = typeof record.pubDate === "number" || /^\\d+$/.test(String(record.pubDate || ""))
        ? Number(record.pubDate)
        : Date.parse(String(record.pubDate || ""));
      if (Number.isFinite(pubDate) && pubDate > 0 && pubDate < 1e11) pubDate *= 1000;
      return Number.isFinite(pubDate) ? pubDate : null;
    };
    const comparePosted = (first, second, direction) => {
      if ("${escapeHtml(SITE_ID)}" !== "indeed") {
        if ("${escapeHtml(SITE_ID)}" === "naukri") {
          const age = (record) => {
            const text = String(record.postedText || "").trim().toLowerCase();
            if (/^(?:just now|few hours ago|today)$/.test(text)) return 0;
            const match = text.match(/^(\\d+)\\+?\\s+(hours?|days?|weeks?|months?)\\s+ago$/);
            if (!match) return null;
            const amount = Number(match[1]);
            const unit = match[2].replace(/s$/, "");
            return amount * (unit === "hour" ? 1 / 24 : unit === "day" ? 1 : unit === "week" ? 7 : 30);
          };
          const firstAge = age(first);
          const secondAge = age(second);
          if (firstAge !== null && secondAge !== null) {
            return (secondAge - firstAge) * direction;
          }
          if (firstAge !== null || secondAge !== null) {
            return firstAge !== null ? -1 : 1;
          }
        }
        const firstDate = Date.parse(first.postedDateEstimate || first.capturedAt || "");
        const secondDate = Date.parse(second.postedDateEstimate || second.capturedAt || "");
        return ((Number.isNaN(firstDate) ? -Infinity : firstDate)
          - (Number.isNaN(secondDate) ? -Infinity : secondDate)) * direction;
      }
      const kind = (record) => record.sponsored === true
        ? { type: "unknown", timestamp: null }
        : record.postedApprox || /^30\\+/i.test(String(record.postedText || "").trim())
          ? { type: "approximate", timestamp: null }
          : { type: postedTimestamp(record) === null ? "unknown" : "dated", timestamp: postedTimestamp(record) };
      const firstPosted = kind(first);
      const secondPosted = kind(second);
      if (firstPosted.type !== secondPosted.type) {
        const ranks = direction > 0
          ? { approximate: 0, dated: 1, unknown: 2 }
          : { dated: 0, approximate: 1, unknown: 2 };
        return ranks[firstPosted.type] - ranks[secondPosted.type];
      }
      return firstPosted.type === "dated"
        ? (firstPosted.timestamp - secondPosted.timestamp) * direction
        : 0;
    };
    const saveOpened = () => {
      try { localStorage.setItem(storageKey, JSON.stringify(opened)); } catch (_error) {}
    };
    const updateOpenedTag = (row, jobId, isOpened) => {
      row.classList.toggle("is-opened", isOpened);
      const actions = row.querySelector(".apply-cell-content");
      const existing = actions.querySelector(".opened-tag");
      if (existing) existing.remove();
      if (!isOpened) return;
      const tag = text("span", "opened-tag", "Opened ");
      const undo = text("a", "", "undo");
      undo.href = "#";
      undo.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        delete opened[jobId];
        saveOpened();
        updateOpenedTag(row, jobId, false);
        render();
      });
      tag.appendChild(undo);
      actions.appendChild(tag);
    };
    const matchesFilters = (record) => {
      const location = String(record.location || "");
      const hasHyderabad = /\bhyderabad\b/i.test(location);
      const hasBengaluru = /\b(?:bengaluru|bangalore)\b/i.test(location);
      const locationMatches = filterSettings.locations.length === 0
        || filterSettings.locations.some((value) => (
          value === "hyderabad" && hasHyderabad
          || value === "bengaluru" && hasBengaluru
          || value === "other" && !hasHyderabad && !hasBengaluru
        ));
      if (!locationMatches) return false;
      if ("${escapeHtml(SITE_ID)}" !== "naukri" || filterSettings.experienceYears.length === 0) {
        return true;
      }
      const experience = String(record.experience || "").trim();
      const range = experience.match(/(\\d+(?:\\.\\d+)?)\\s*(?:(?:-\\s*|to\\s*)(\\d+(?:\\.\\d+)?|\\+)|(\\+))/i);
      let minimum;
      let maximum;
      if (range) {
        minimum = Number(range[1]);
        maximum = range[2] === "+" || range[3] ? Infinity : Number(range[2]);
      } else {
        const single = experience.match(/^\\s*(\\d+(?:\\.\\d+)?)\\s*(?:yrs?|years?)\\b/i);
        if (!single) return false;
        minimum = Number(single[1]);
        maximum = minimum;
      }
      const bands = {
        "under-3": [0, 3],
        "4-5": [4, 5],
        "6-plus": [6, Infinity]
      };
      return filterSettings.experienceYears.some((band) => (
        minimum <= bands[band][1] && maximum >= bands[band][0]
      ));
    };
    const matchesSearchTerm = (value, term) => {
      if (!term) return true;
      if (/\\s/.test(term)) return value.includes(term);
      const isWordCharacter = (character) => /[\\p{L}\\p{N}_]/u.test(character);
      let index = value.indexOf(term);
      while (index !== -1) {
        const before = index > 0 ? value[index - 1] : "";
        const after = value[index + term.length] || "";
        if (
          (!isWordCharacter(term[0]) || !isWordCharacter(before))
          && (!isWordCharacter(term[term.length - 1]) || !isWordCharacter(after))
        ) return true;
        index = value.indexOf(term, index + 1);
      }
      return false;
    };
    const render = () => {
      const grouped = records.filter((record) => (
        record.tabId === selectedTab && matchesFilters(record)
      ));
      const term = search.value.trim().toLocaleLowerCase();
      const reviewStatus = applicantReviewFilter.value;
      const matched = grouped.filter((record) => (
        (!reviewStatus || (record.applicantReviewStatus === "actively-reviewing"
          ? "actively-reviewing"
          : "not-indicated") === reviewStatus)
        && matchesSearchTerm((record.title + " " + record.company).toLocaleLowerCase(), term)
      ));
      const visible = matched.filter((record) => (
        !filterSettings.hideOpened || opened[record.jobId] !== true
      ));
      const direction = sortState.direction === "ascending" ? 1 : -1;
      visible.sort((a, b) => {
        let result = 0;
        if (sortState.key === "role" || sortState.key === "company") {
          const field = sortState.key === "role" ? "title" : "company";
          result = String(a[field] || "").localeCompare(String(b[field] || ""), undefined, { sensitivity: "base" });
        } else {
          result = comparePosted(a, b, direction);
        }
        return sortState.key === "posted" ? result : result * direction;
      });
      for (const [index, tab] of tabs.entries()) {
        const button = buttonForTab(tab, index);
        button.textContent = tab.label + " (" + records.filter((record) => record.tabId === tab.id).length + ")";
        button.setAttribute("aria-selected", String(selectedTab === tab.id));
        button.tabIndex = selectedTab === tab.id ? 0 : -1;
      }
      panel.setAttribute("aria-labelledby", buttonForTab(
        tabs.find((tab) => tab.id === selectedTab),
        tabs.findIndex((tab) => tab.id === selectedTab)
      ).id);
      document.body.dataset.activeTab = selectedTab;
      body.replaceChildren();
      visible.forEach((record, index) => {
        const row = document.createElement("tr");
        row.tabIndex = 0;
        row.setAttribute("aria-label", record.title + " at " + record.company);
        const number = text("td", "number-column", String(index + 1));
        row.appendChild(number);
        const roleCell = text("td", "role-cell", "");
        roleCell.appendChild(text("span", "role-title", record.title));
        const isActivelyReviewing = record.applicantReviewStatus === "actively-reviewing";
        const reviewTag = text(
          "span",
          isActivelyReviewing ? "review-status-tag is-active" : "review-status-tag",
          isActivelyReviewing ? "Actively reviewing applicants" : "No status shown"
        );
        reviewTag.title = isActivelyReviewing
          ? "LinkedIn labels this job as actively reviewing applicants."
          : "LinkedIn did not show an applicant-review status for this job.";
        roleCell.appendChild(reviewTag);
        if (record.visited) roleCell.appendChild(text("span", "visited-chip", "Visited"));
        row.appendChild(roleCell);
        const companyCell = text("td", "company-cell", "");
        const companyRow = text("div", "company-row", "");
        const hue = Array.from(record.company || "?").reduce((value, character) => (value * 31 + character.codePointAt(0)) % 360, 0);
        const mark = text("span", "company-mark", Array.from(record.company.trim())[0]?.toLocaleUpperCase() || "?");
        mark.style.setProperty("--avatar-hue", String(hue));
        if (record.companyLogoUrl) {
          const image = document.createElement("img");
          image.alt = "";
          image.setAttribute("aria-hidden", "true");
          image.addEventListener("load", () => {
            mark.textContent = "";
            mark.appendChild(image);
          }, { once: true });
          image.addEventListener("error", () => image.remove(), { once: true });
          image.src = record.companyLogoUrl;
        }
        companyRow.appendChild(mark);
        companyRow.appendChild(text("span", "company-name", record.company));
        companyCell.appendChild(companyRow);
        row.appendChild(companyCell);
        const locationCell = text("td", "location-cell", record.location);
        locationCell.dataset.label = "Location";
        row.appendChild(locationCell);
        const postedCell = text("td", "posted-cell", "");
        postedCell.dataset.label = "Posted";
        const postedContent = text("div", "posted-content", "");
        postedContent.appendChild(text("span", record.postedType === "Reposted" ? "posted-badge is-reposted" : "posted-badge", record.postedType === "Posted" || record.postedType === "Reposted" ? record.postedType : "Unknown"));
        postedContent.appendChild(text("span", "posted-relative", record.postedText));
        postedCell.appendChild(postedContent);
        const timestamp = "${escapeHtml(SITE_ID)}" === "indeed"
          ? postedTimestamp(record)
          : Date.parse(record.postedDateEstimate || "");
        const date = "${escapeHtml(SITE_ID)}" === "indeed" && record.postedApprox
          ? ""
          : absoluteDate(Number.isFinite(timestamp)
            ? new Date(timestamp).toISOString()
            : record.postedDateEstimate);
        if (date) postedCell.appendChild(text("span", "absolute-date", date));
        row.appendChild(postedCell);
        const applyCell = text("td", "apply-cell", "");
        applyCell.dataset.label = "Apply";
        const actions = text("div", "apply-cell-content", "");
        const apply = text("a", "apply-link", "Apply");
        const applyUrl = record.url;
        if (applyUrl) {
          apply.href = applyUrl;
          apply.target = "_blank";
          apply.rel = "noopener noreferrer";
          apply.addEventListener("click", () => {
            opened[record.jobId] = true;
            saveOpened();
            updateOpenedTag(row, record.jobId, true);
          });
        } else {
          apply.setAttribute("aria-disabled", "true");
          apply.tabIndex = -1;
        }
        actions.appendChild(apply);
        if (selectedTab === tabs[1].id && record.companyApplyUrl) {
          actions.appendChild(text("span", "via-linkedin", "via LinkedIn"));
        }
        applyCell.appendChild(actions);
        row.appendChild(applyCell);
        updateOpenedTag(row, record.jobId, opened[record.jobId] === true);
        row.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const rows = Array.from(body.querySelectorAll("tr"));
            rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)))].focus();
          } else if (event.key === "Enter" && event.target === row) {
            event.preventDefault();
            apply.click();
          }
        });
        body.appendChild(row);
      });
      for (const key of Object.keys(sortHeaders)) {
        const active = sortState.key === key;
        sortHeaders[key].setAttribute("aria-sort", active ? sortState.direction : "none");
        const button = sortButtons[key];
        button.replaceChildren(text("span", "", key === "role" ? "Role" : key === "company" ? "Company" : "Posted"));
        if (active) button.appendChild(text("span", "sort-indicator", sortState.direction === "ascending" ? "↑" : "↓"));
      }
      empty.hidden = visible.length > 0;
      empty.textContent = term && matched.length === 0
        ? "No jobs match your search."
        : grouped.length === 0 && records.some((record) => record.tabId === selectedTab)
          ? "No jobs match the selected filters."
        : reviewStatus && matched.length === 0 && grouped.length > 0
          ? "No jobs match this applicant-review filter."
          : filterSettings.hideOpened && matched.length > 0
            ? "All matching jobs have been opened."
            : "No " + tabs.find((tab) => tab.id === selectedTab).label + " jobs captured yet.";
    };
    const selectTab = (tab) => {
      selectedTab = tab;
      try { localStorage.setItem(tabStorageKey, tab); } catch (_error) {}
      render();
    };
    for (const [index, item] of tabs.entries()) {
      const button = buttonForTab(item, index);
      button.addEventListener("click", () => selectTab(item.id));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        const next = tabs[nextIndex];
        buttonForTab(next, nextIndex).focus();
        selectTab(next.id);
      });
    }
    search.addEventListener("input", render);
    applicantReviewFilter.addEventListener("change", render);
    hideOpened.addEventListener("change", saveFilters);
    for (const checkbox of [...locationFilters, ...experienceFilters]) {
      checkbox.addEventListener("change", saveFilters);
    }
    for (const [key, button] of Object.entries(sortButtons)) {
      button.addEventListener("click", () => {
        sortState = sortState.key === key
          ? { key, direction: sortState.direction === "ascending" ? "descending" : "ascending" }
          : { key, direction: key === "posted" ? "descending" : "ascending" };
        render();
      });
    }
    const preferredTab = tabs.find((tab) => records.some((record) => record.tabId === tab.id))?.id
      || tabs[0].id;
    const savedTab = ${JSON.stringify(savedSelectedTab)};
    let persistedTab = savedTab;
    try {
      const localTab = localStorage.getItem(tabStorageKey);
      if (tabs.some((tab) => tab.id === localTab)) persistedTab = localTab;
    } catch (_error) {}
    selectTab(
      tabs.some((tab) => tab.id === persistedTab)
      && records.some((record) => record.tabId === persistedTab)
        ? persistedTab
        : preferredTab
    );
    render();
  </script>
</body>
</html>`;
}

function reportFilename() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${SITE_ID}-jobs-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.html`;
}

async function exportStandaloneReport() {
  const latestValues = await chrome.storage.local.get([
    STORAGE_KEYS.opened,
    STORAGE_KEYS.selectedTab,
    STORAGE_KEYS.filters
  ]);
  const records = Object.values(await readSiteJobs()).filter((record) => (
    record && typeof record === "object" && !Array.isArray(record)
  ));
  if (records.length === 0) {
    setFeedback("There are no captured jobs to export.");
    return;
  }
  const html = buildStandaloneReport(
    records,
    latestValues[STORAGE_KEYS.opened],
    storageSnapshot.collectorState,
    latestValues[STORAGE_KEYS.selectedTab],
    latestValues[STORAGE_KEYS.filters]
  );
  const objectUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  try {
    const downloadLink = document.createElement("a");
    downloadLink.href = objectUrl;
    downloadLink.download = reportFilename();
    downloadLink.hidden = true;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    setFeedback("Standalone HTML report downloaded.");
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function dateInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function setDefaultHistoryRange() {
  const today = new Date();
  elements.historyFrom.value = dateInputValue(new Date(today.getFullYear(), today.getMonth(), 1));
  elements.historyTo.value = dateInputValue(today);
}

function parseLocalDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3])
    ? date
    : null;
}

function getHistoryCaptureTimestamp(record) {
  const capturedAt = Date.parse(String(record.capturedAt || ""));
  if (Number.isFinite(capturedAt)) {
    return capturedAt;
  }
  const firstSeenAt = Date.parse(String(record.firstSeenAt || ""));
  return Number.isFinite(firstSeenAt) ? firstSeenAt : null;
}

async function renderHistory() {
  const from = parseLocalDate(elements.historyFrom.value);
  const to = parseLocalDate(elements.historyTo.value);
  if (!from || !to) {
    elements.historyError.textContent = "Choose valid From and To dates.";
    elements.historyError.hidden = false;
    return;
  }
  if (from > to) {
    elements.historyError.textContent = "The From date must be on or before the To date.";
    elements.historyError.hidden = false;
    return;
  }
  elements.historyError.hidden = true;
  elements.historyError.textContent = "";
  const endExclusive = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime();
  const sites = ["linkedin", "naukri", "indeed"];
  const storageKeys = sites.map((siteId) => STORAGE_API.keysForSite(siteId).openedJobs);
  const values = await chrome.storage.local.get(["records", ...storageKeys]);
  const records = values.records && typeof values.records === "object" ? values.records : {};
  for (const siteId of sites) {
    const prefix = `${siteId}:`;
    let received = 0;
    let opened = 0;
    for (const [key, record] of Object.entries(records)) {
      if (
        !key.startsWith(prefix)
        || !record
        || typeof record !== "object"
        || Array.isArray(record)
      ) {
        continue;
      }
      const capturedAt = getHistoryCaptureTimestamp(record);
      if (capturedAt === null || capturedAt < from.getTime() || capturedAt >= endExclusive) {
        continue;
      }
      received += 1;
      const jobId = String(record.jobId || key.slice(prefix.length));
      const openedJobs = values[STORAGE_API.keysForSite(siteId).openedJobs];
      const openedValue = openedJobs && openedJobs[jobId];
      if (
        openedValue === true
        || (typeof openedValue === "string" && Number.isFinite(Date.parse(openedValue)))
      ) {
        opened += 1;
      }
    }
    elements.historyCounts[siteId].received.textContent = String(received);
    elements.historyCounts[siteId].opened.textContent = String(opened);
  }
}

async function openHistoryDialog() {
  if (!elements.historyFrom.value || !elements.historyTo.value) {
    setDefaultHistoryRange();
  }
  if (!elements.historyDialog.open) {
    elements.historyDialog.showModal();
  }
  await renderHistory();
}

function normalizeSkipTitle(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function normalizeSkipTitles(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  return value.reduce((titles, item) => {
    if (typeof item !== "string") {
      return titles;
    }
    const title = item.trim();
    const normalized = normalizeSkipTitle(title);
    if (title && title.length <= 160 && !seen.has(normalized)) {
      seen.add(normalized);
      titles.push(title);
    }
    return titles;
  }, []);
}

function closeSettingsMenu() {
  elements.settingsMenu.hidden = true;
  elements.settingsButton.setAttribute("aria-expanded", "false");
}

function renderSkipTitleList() {
  const titles = storageSnapshot.skipTitles;
  elements.skipTitleList.replaceChildren();
  elements.skipTitleEmpty.hidden = titles.length > 0;
  for (const title of titles) {
    const row = document.createElement("li");
    row.className = "skip-title-row";
    row.appendChild(createTextElement("span", "skip-title-text", title));
    const actions = document.createElement("div");
    actions.className = "skip-title-actions";

    const editButton = createTextElement("button", "", "Edit");
    editButton.type = "button";
    editButton.addEventListener("click", () => {
      editingSkipTitle = title;
      elements.skipTitleInput.value = title;
      elements.skipTitleSubmit.textContent = "Update title";
      elements.skipTitleCancelEdit.hidden = false;
      elements.skipTitleError.hidden = true;
      elements.skipTitleInput.focus();
    });
    actions.appendChild(editButton);

    const deleteButton = createTextElement("button", "", "Delete");
    deleteButton.type = "button";
    deleteButton.addEventListener("click", () => {
      const nextTitles = storageSnapshot.skipTitles.filter((item) => (
        normalizeSkipTitle(item) !== normalizeSkipTitle(title)
      ));
      void saveSkipTitles(nextTitles).then(() => {
        if (editingSkipTitle && normalizeSkipTitle(editingSkipTitle) === normalizeSkipTitle(title)) {
          resetSkipTitleEditor();
        }
        elements.skipTitleError.hidden = true;
      }).catch((error) => {
        showSkipTitleError(`Could not delete the title: ${error.message}`);
      });
    });
    actions.appendChild(deleteButton);
    row.appendChild(actions);
    elements.skipTitleList.appendChild(row);
  }
}

function showSkipTitleError(message) {
  elements.skipTitleError.textContent = message;
  elements.skipTitleError.hidden = false;
}

function resetSkipTitleEditor() {
  editingSkipTitle = null;
  elements.skipTitleInput.value = "";
  elements.skipTitleSubmit.textContent = "Add title";
  elements.skipTitleCancelEdit.hidden = true;
}

async function saveSkipTitles(titles) {
  const normalizedTitles = normalizeSkipTitles(titles);
  await chrome.storage.local.set({ [getSkipTitlesStorageKey()]: normalizedTitles });
  storageSnapshot.skipTitles = normalizedTitles;
  renderSkipTitleList();
}

async function submitSkipTitle(event) {
  event.preventDefault();
  const title = elements.skipTitleInput.value.trim();
  if (!title) {
    showSkipTitleError("Enter a job title.");
    elements.skipTitleInput.focus();
    return;
  }
  if (title.length > 160) {
    showSkipTitleError("Job titles must be 160 characters or fewer.");
    return;
  }
  const normalized = normalizeSkipTitle(title);
  const existingIndex = storageSnapshot.skipTitles.findIndex((item) => (
    normalizeSkipTitle(item) === normalizeSkipTitle(editingSkipTitle || "")
  ));
  const duplicate = storageSnapshot.skipTitles.some((item, index) => (
    index !== existingIndex && normalizeSkipTitle(item) === normalized
  ));
  if (duplicate) {
    showSkipTitleError("That exact title is already on the skip list.");
    return;
  }

  const nextTitles = [...storageSnapshot.skipTitles];
  if (existingIndex >= 0) {
    nextTitles[existingIndex] = title;
  } else {
    nextTitles.push(title);
  }
  elements.skipTitleSubmit.disabled = true;
  try {
    await saveSkipTitles(nextTitles);
    resetSkipTitleEditor();
    elements.skipTitleError.hidden = true;
  } catch (error) {
    showSkipTitleError(`Could not save the title: ${error.message}`);
  } finally {
    elements.skipTitleSubmit.disabled = false;
  }
}

async function openSkipTitleDialog() {
  renderSkipTitleList();
  elements.skipTitleError.hidden = true;
  if (!elements.skipTitleDialog.open) {
    elements.skipTitleDialog.showModal();
  }
  elements.skipTitleInput.focus();
}

function createTextElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  return element;
}

function setFeedback(text) {
  elements.feedback.textContent = text;
}

function updateOpenedState(jobId, isOpened) {
  const operation = openedWriteQueue.then(async () => {
    const values = await chrome.storage.local.get(STORAGE_KEYS.opened);
    const saved = values[STORAGE_KEYS.opened];
    const openedJobs = saved
      && typeof saved === "object"
      && !Array.isArray(saved)
      ? { ...saved }
      : {};
    if (isOpened) {
      openedJobs[jobId] = true;
    } else {
      delete openedJobs[jobId];
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.opened]: openedJobs });
  });
  openedWriteQueue = operation.catch(() => {});
  return operation;
}

function createOpenedTag(jobId) {
  const tag = document.createElement("span");
  tag.className = "opened-tag";
  tag.appendChild(createTextElement("span", "", "Opened"));
  const undo = createTextElement("a", "", "undo");
  undo.href = "#";
  undo.setAttribute("aria-label", `Mark ${jobId} as not opened`);
  undo.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void updateOpenedState(jobId, false).catch((error) => {
      setFeedback(`Could not update opened status: ${error.message}`);
    });
  });
  tag.appendChild(undo);
  return tag;
}

function createCompanyMark(record) {
  const mark = createTextElement("span", "company-mark", getInitial(record.company));
  let hue = 0;
  for (const character of String(record.company || "")) {
    hue = ((hue * 31) + character.codePointAt(0)) % 360;
  }
  mark.style.setProperty("--avatar-hue", String(hue));
  const logoUrl = validHttpUrl(record.companyLogoUrl || record.logo);
  if (logoUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    image.addEventListener("load", () => {
      mark.textContent = "";
      mark.appendChild(image);
    }, { once: true });
    image.addEventListener("error", () => {
      image.remove();
    }, { once: true });
    image.src = logoUrl;
  }
  return mark;
}

function createJobRow(record, tab, index) {
  const row = document.createElement("tr");
  const jobId = String(record.jobId || "");
  const isOpened = isRecordOpened(record);
  row.className = isOpened ? "is-opened" : "";
  row.tabIndex = 0;
  row.setAttribute("aria-label", `${record.title || "Untitled role"} at ${record.company || "Company not listed"}`);
  let applyLinkElement = null;
  row.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const siblingRows = row.parentElement.children;
      const currentIndex = siblingRows.indexOf
        ? siblingRows.indexOf(row)
        : Array.prototype.indexOf.call(siblingRows, row);
      const nextIndex = Math.max(0, Math.min(
        siblingRows.length - 1,
        currentIndex + (event.key === "ArrowDown" ? 1 : -1)
      ));
      siblingRows[nextIndex]?.focus();
    } else if (event.key === "Enter" && event.target === row) {
      event.preventDefault();
      applyLinkElement?.click();
    }
  });

  const cells = {};
  cells.select = document.createElement("td");
  cells.select.className = "select-column";
  cells.select.setAttribute("data-label", "Select");
  const selection = document.createElement("input");
  selection.className = "job-selection";
  selection.type = "checkbox";
  selection.checked = selectedJobIds.has(jobId);
  selection.setAttribute(
    "aria-label",
    `Select ${record.title || "job"} at ${record.company || "company"} to hide`
  );
  selection.addEventListener("change", () => {
    if (selection.checked) {
      selectedJobIds.add(jobId);
    } else {
      selectedJobIds.delete(jobId);
    }
    updateHideControls();
  });
  cells.select.appendChild(selection);
  cells.number = createTextElement("td", "number-column", String(index));

  const roleCell = document.createElement("td");
  roleCell.className = "role-cell";
  roleCell.setAttribute("data-label", "Role");
  roleCell.appendChild(createTextElement("span", "role-title", record.title || "Untitled role"));
  if (SITE_ID === "linkedin") {
    const isActivelyReviewing = record.applicantReviewStatus === "actively-reviewing";
    const reviewTag = createTextElement(
      "span",
      isActivelyReviewing ? "review-status-tag is-active" : "review-status-tag",
      isActivelyReviewing ? "Actively reviewing applicants" : "No status shown"
    );
    reviewTag.setAttribute("title", isActivelyReviewing
      ? "LinkedIn labels this job as actively reviewing applicants."
      : "LinkedIn did not show an applicant-review status for this job.");
    roleCell.appendChild(reviewTag);
  } else {
    if (record.walkIn) {
      roleCell.appendChild(createTextElement("span", "walk-in-badge", "Walk-in"));
    }
    if (record.walkInDates) {
      roleCell.appendChild(createTextElement("span", "walk-in-dates", record.walkInDates));
    }
  }
  cells.role = roleCell;

  const companyCell = document.createElement("td");
  companyCell.className = "company-cell";
  companyCell.setAttribute("data-label", "Company");
  const companyRow = document.createElement("div");
  companyRow.className = "company-row";
  companyRow.appendChild(createCompanyMark(record));
  companyRow.appendChild(createTextElement("span", "company-name", record.company || "Company not listed"));
  companyCell.appendChild(companyRow);
  if (SITE_ID === "naukri" && record.postedBy) {
    companyCell.appendChild(createTextElement("span", "posted-by", `via ${record.postedBy}`));
  }
  cells.company = companyCell;

  const locationCell = document.createElement("td");
  locationCell.className = "location-cell";
  locationCell.setAttribute("data-label", "Location");
  locationCell.appendChild(createTextElement(
    "span",
    "location-text",
    record.location
      || (Array.isArray(record.locations) && record.locations.length
        ? record.locations.join(", ")
        : record.locationRaw)
      || "Location not listed"
  ));
  if (SITE_ID === "naukri" && record.workMode) {
    locationCell.appendChild(createTextElement("span", "work-mode-chip", record.workMode));
  }
  if (SITE_ID === "indeed" && record.workMode === "Remote") {
    locationCell.appendChild(createTextElement("span", "work-mode-chip", "Remote"));
  }
  cells.location = locationCell;
  cells.experience = createTextElement("td", "experience-cell", record.experience || "—");
  cells.experience.setAttribute("data-label", "Exp");
  cells.salary = createTextElement("td", "salary-cell", record.salary || "—");
  cells.salary.setAttribute("data-label", "Salary");
  cells.type = createTextElement("td", "type-cell", record.jobType || "—");
  cells.type.setAttribute("data-label", "Type");

  if (SITE_ID === "indeed") {
    if (record.sponsored) {
      roleCell.appendChild(createTextElement("span", "job-chip sponsored-chip", "Sponsored"));
    }
    if (record.urgentlyHiring) {
      roleCell.appendChild(createTextElement("span", "job-chip hiring-chip", "Urgently hiring"));
    }
    if (record.visited === true) {
      roleCell.appendChild(createTextElement("span", "job-chip visited-chip", "Visited"));
    }
  }

  const postedCell = document.createElement("td");
  postedCell.className = "posted-cell";
  postedCell.setAttribute("data-label", "Posted");
  const postedContent = document.createElement("div");
  postedContent.className = "posted-content";
  const postedType = record.postedType === "Posted" || record.postedType === "Reposted"
    ? record.postedType
    : "Unknown";
  if (SITE_ID === "linkedin") {
    postedContent.appendChild(createTextElement(
      "span",
      postedType === "Reposted" ? "posted-badge is-reposted" : "posted-badge",
      postedType
    ));
  }
  const postedLabel = SITE_ID === "indeed" && record.sponsored === true
    ? "No date (sponsored)"
    : SITE_ID === "indeed" && record.postedApprox
      ? "30+ days"
      : SITE_ID === "indeed" && getIndeedPostedTimestamp(record) === null
        ? "Date unavailable"
        : record.postedText || (SITE_ID === "indeed" ? "Posted date" : "Date not listed");
  const postedRelative = createTextElement("span", "posted-relative", postedLabel);
  if (SITE_ID === "indeed" && record.postedApprox) {
    postedRelative.setAttribute(
      "title",
      "Indeed reports this posting as 30+ days old; an exact date is unavailable."
    );
  }
  const postedTimestamp = SITE_ID === "indeed" ? getIndeedPostedTimestamp(record) : null;
  if (
    SITE_ID === "indeed"
    && record.sponsored !== true
    && !record.postedApprox
    && !record.postedText
    && postedTimestamp === null
  ) {
    postedRelative.dataset.state = "unavailable";
  }
  postedContent.appendChild(postedRelative);
  postedCell.appendChild(postedContent);
  const postedDateEstimate = SITE_ID === "indeed" && postedTimestamp !== null
    ? new Date(postedTimestamp).toISOString()
    : record.postedDateEstimate;
  const absoluteDate = SITE_ID === "indeed" && (record.postedApprox || record.sponsored)
    ? ""
    : formatAbsoluteDate(postedDateEstimate);
  if (absoluteDate) {
    const date = createTextElement("span", "absolute-date", absoluteDate);
    if ((SITE_ID === "naukri" || SITE_ID === "indeed") && record.postedApprox) {
      date.setAttribute("title", `Approximate date estimated from "${record.postedText || "unknown posting age"}".`);
    }
    postedCell.appendChild(date);
  }
  if (SITE_ID === "indeed" && !record.sponsored && postedTimestamp === null) {
    const firstSeen = Date.parse(String(record.firstSeenAt || record.capturedAt || ""));
    if (Number.isFinite(firstSeen)) {
      const firstSeenDate = new Intl.DateTimeFormat(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric"
      }).format(new Date(firstSeen));
      postedCell.appendChild(createTextElement("span", "first-seen", `First seen ${firstSeenDate}`));
    }
  }
  cells.posted = postedCell;

  const applyCell = document.createElement("td");
  applyCell.className = "apply-cell";
  applyCell.setAttribute("data-label", "Apply");
  const actions = document.createElement("div");
  actions.className = "apply-cell-content";
  const applyUrl = getApplyUrl(record, tab);
  const applyLink = createTextElement("a", "apply-link", "Apply");
  applyLinkElement = applyLink;
  if (applyUrl) {
    applyLink.href = applyUrl;
    applyLink.target = "_blank";
    applyLink.rel = "noopener noreferrer";
    applyLink.addEventListener("click", () => {
      void updateOpenedState(jobId, true).catch((error) => {
        setFeedback(`Could not save opened status: ${error.message}`);
      });
    });
  } else {
    applyLink.setAttribute("aria-disabled", "true");
    applyLink.setAttribute("tabindex", "-1");
  }
  actions.appendChild(applyLink);
  if (isOpened) {
    actions.appendChild(createOpenedTag(jobId));
  }
  if (SITE_ID === "linkedin" && tab === "Company Site" && !validHttpUrl(record.companyApplyUrl)) {
    actions.appendChild(createTextElement("span", "via-linkedin", "via LinkedIn"));
  }
  applyCell.appendChild(actions);
  cells.apply = applyCell;

  for (const column of SITE_ADAPTER.ui.columns) {
    if (column.id === "number") {
      row.appendChild(cells.select);
    }
    row.appendChild(cells[column.id]);
  }
  return row;
}

function sortRecords(records) {
  const sorted = records.slice();
  const direction = sortState.direction === "ascending" ? 1 : -1;
  sorted.sort((first, second) => {
    let comparison = 0;
    const textFields = {
      role: "title",
      company: "company",
      location: "location",
      salary: "salary",
      type: "jobType"
    };
    if (textFields[sortState.key]) {
      const field = textFields[sortState.key];
      comparison = String(first[field] || "").localeCompare(
        String(second[field] || ""), undefined, { sensitivity: "base" }
      ) * direction;
    } else {
      comparison = comparePostedRecords(first, second, direction);
    }
    return comparison;
  });
  return sorted;
}

function chooseInitialTab(records) {
  const visibleRecords = records.filter((record) => (
    matchesJobFilters(record, storageSnapshot.filterSettings)
  ));
  const storedTab = storageSnapshot.resultsSelectedTab;
  if (storedTab === ALL_TAB) {
    selectedTab = ALL_TAB;
    return;
  }
  if (APPLY_TABS.includes(storedTab)) {
    selectedTab = getRecordsForTab(visibleRecords, storedTab).length > 0
      || !APPLY_TABS.some((tab) => tab !== storedTab && getRecordsForTab(visibleRecords, tab).length > 0)
      ? storedTab
      : APPLY_TABS.find((tab) => getRecordsForTab(visibleRecords, tab).length > 0) || storedTab;
    return;
  }
  selectedTab = ALL_TAB;
}

function render() {
  try {
    const records = getRecords();
    const visibleByFilters = records.filter((record) => (
      matchesJobFilters(record, storageSnapshot.filterSettings)
    ));
    const recordsByTab = Object.fromEntries([[ALL_TAB, visibleByFilters], ...APPLY_TABS.map((tab) => {
      return [tab, getRecordsForTab(records, tab).filter((record) => (
        matchesJobFilters(record, storageSnapshot.filterSettings)
      ))];
    })]);
    const activeRecords = recordsByTab[selectedTab] || [];
    const searchTerm = elements.search.value.trim().toLocaleLowerCase();
    const applicantReviewStatus = elements.applicantReviewFilter.value;
    const matchingRecords = activeRecords.filter((record) => (
      (!applicantReviewStatus
        || (record.applicantReviewStatus === "actively-reviewing"
          ? "actively-reviewing"
          : "not-indicated") === applicantReviewStatus)
      && matchesSearchTerm(
        `${record.title || ""} ${record.company || ""} ${record.postedBy || ""} ${
        Array.isArray(record.skills) ? record.skills.join(" ") : ""
      } ${SITE_ID === "indeed" ? `${record.location || ""} ${record.locationRaw || ""}` : ""}`
          .toLocaleLowerCase(),
        searchTerm
      )
    ));
    const visibleRecords = sortRecords(matchingRecords.filter((record) => {
      const jobId = String(record.jobId || "");
      const wasOpened = isRecordOpened(record);
      const wasManuallyHidden = storageSnapshot.hiddenJobsById[jobId] === true;
      if (showingHiddenJobs) {
        return wasOpened || wasManuallyHidden;
      }
      return (
        (!storageSnapshot.filterSettings.hideOpened || !wasOpened)
        && (!storageSnapshot.filterSettings.hideHiddenJobs || !wasManuallyHidden)
      );
    }));
    visibleJobIds = visibleRecords.map((record) => String(record.jobId || ""));
    elements.showingCount.textContent = `Showing ${visibleRecords.length} of ${matchingRecords.length}`;

    elements.allTab.textContent = `${ALL_TAB} (${recordsByTab[ALL_TAB].length})`;
    elements.allTab.setAttribute("aria-selected", String(selectedTab === ALL_TAB));
    elements.allTab.tabIndex = selectedTab === ALL_TAB ? 0 : -1;
    for (const [index, tab] of APPLY_TABS.entries()) {
      const button = getTabButton(tab, index);
      button.textContent = `${TAB_LABELS[tab]} (${recordsByTab[tab].length})`;
      button.setAttribute("aria-selected", String(selectedTab === tab));
      button.tabIndex = selectedTab === tab ? 0 : -1;
    }
    const selectedButton = getTabButton(selectedTab);
    elements.panel.setAttribute("aria-labelledby", selectedButton.id);
    document.body.dataset.activeTab = selectedTab;
    const easyApplyCount = records.filter((record) => record.applyType === "Easy Apply").length;
    const activelyReviewingCount = records.filter(
      (record) => record.applicantReviewStatus === "actively-reviewing"
    ).length;
    const now = Date.now();
    const freshCount = records.filter((record) => {
      if (
        SITE_ID === "indeed"
        && /^(?:just posted|today)$/i.test(String(record.postedText || "").trim())
      ) {
        return true;
      }
      const postedAt = SITE_ID === "indeed"
        ? getIndeedPostedTimestamp(record)
        : Date.parse(String(record.postedDateEstimate || ""));
      return Number.isFinite(postedAt) && postedAt <= now && now - postedAt < 24 * 60 * 60 * 1000;
    }).length;
    elements.summaryTotal.textContent = String(records.length);
    elements.summarySite.textContent = SITE_ADAPTER.label;
    const hiddenCount = records.filter((record) => (
      storageSnapshot.hiddenJobsById[String(record.jobId || "")] === true
    )).length;
    elements.summaryTotalNote.textContent = `${records.length - hiddenCount} visible · ${hiddenCount} hidden`;
    elements.summaryEasy.textContent = String(easyApplyCount);
    elements.summaryEasyShare.textContent = `${records.length ? Math.round(easyApplyCount / records.length * 100) : 0}% of jobs`;
    elements.summaryReviewing.textContent = String(activelyReviewingCount);
    elements.summaryReviewingShare.textContent = `${records.length ? Math.round(activelyReviewingCount / records.length * 100) : 0}% verified`;
    elements.summaryFresh.textContent = String(freshCount);
    const runInfo = formatRunDate(storageSnapshot.collectorState);
    elements.subtitle.textContent = runInfo;
    elements.siteRunFooter.textContent = runInfo;
    elements.parseWarningFooter.hidden = true;
    elements.parseWarningFooter.textContent = "";
    elements.tableBody.replaceChildren();
    visibleRecords.forEach((record, index) => {
      elements.tableBody.appendChild(createJobRow(record, selectedTab, index + 1));
    });
    updateHideControls();
    for (const column of SITE_ADAPTER.ui.columns.filter((item) => item.sortable)) {
      const key = column.id;
      const isActive = sortState.key === key;
      const direction = isActive ? sortState.direction : "none";
      elements.sortHeaders[key].setAttribute("aria-sort", direction);
      const button = elements.sortButtons[key];
      button.replaceChildren(createTextElement("span", "", column.label));
      if (isActive) {
        button.appendChild(createTextElement(
          "span",
          "sort-indicator",
          sortState.direction === "ascending" ? "↑" : "↓"
        ));
      }
    }
    elements.empty.hidden = visibleRecords.length > 0;
    elements.empty.textContent = searchTerm && matchingRecords.length === 0
      ? "No jobs match your search."
    : activeRecords.length === 0 && getRecordsForTab(records, selectedTab).length > 0
      ? "No jobs match the selected filters."
    : applicantReviewStatus && matchingRecords.length === 0 && activeRecords.length > 0
        ? "No jobs match this applicant-review filter."
      : showingHiddenJobs && matchingRecords.length > 0
        ? "No opened or manually hidden jobs match the current filters."
      : storageSnapshot.filterSettings.hideOpened && matchingRecords.length > 0
        ? "All matching jobs have been opened."
        : storageSnapshot.filterSettings.hideHiddenJobs
          && matchingRecords.length > 0
          && matchingRecords.every((record) => (
            storageSnapshot.hiddenJobsById[String(record.jobId || "")] === true
          ))
          ? "All matching jobs are hidden."
        : selectedTab === ALL_TAB
          ? "No jobs captured yet."
          : `No ${TAB_LABELS[selectedTab]} jobs captured yet.`;
    if (!elements.feedback.textContent.startsWith("Could not")) {
      elements.feedback.textContent = "";
    }
  } catch (error) {
    elements.tableBody.replaceChildren();
    elements.empty.hidden = false;
    elements.empty.textContent = "Results could not be loaded.";
    setFeedback(error instanceof Error ? error.message : String(error));
  }
}

async function selectTab(tab) {
  if (tab !== ALL_TAB && !APPLY_TABS.includes(tab)) {
    return;
  }
  selectedTab = tab;
  render();
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.selectedTab]: tab });
  } catch (error) {
    setFeedback(`Could not save the selected tab: ${error.message}`);
  }
}

function persistFilterSettings() {
  const settings = normalizeFilterSettings(readFilterControls());
  storageSnapshot.filterSettings = settings;
  render();
  const operation = filterWriteQueue.then(async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.filters]: settings });
  });
  filterWriteQueue = operation.catch((error) => {
    setFeedback(`Could not save filters: ${error.message}`);
  });
  return filterWriteQueue;
}

function updateHideControls() {
  const selectedVisibleCount = visibleJobIds.reduce(
    (count, jobId) => count + (selectedJobIds.has(jobId) ? 1 : 0),
    0
  );
  if (elements.selectAllJobs) {
    elements.selectAllJobs.checked = visibleJobIds.length > 0
      && selectedVisibleCount === visibleJobIds.length;
    elements.selectAllJobs.indeterminate = selectedVisibleCount > 0
      && selectedVisibleCount < visibleJobIds.length;
    elements.selectAllJobs.disabled = visibleJobIds.length === 0;
  }
  elements.hideSelectedJobs.disabled = selectedJobIds.size === 0;
  const hasHiddenOrOpenedJobs = getRecords().some((record) => {
    return storageSnapshot.hiddenJobsById[String(record.jobId || "")] === true
      || isRecordOpened(record);
  });
  elements.viewHiddenJobs.disabled = !showingHiddenJobs && !hasHiddenOrOpenedJobs;
  elements.viewHiddenJobs.textContent = showingHiddenJobs ? "View All Jobs" : "View Hidden Jobs";
  elements.viewHiddenJobs.setAttribute("aria-pressed", String(showingHiddenJobs));
  const hasActiveFilters = Boolean(
    elements.search.value.trim()
    || elements.applicantReviewFilter.value
    || selectedTab !== ALL_TAB
    || storageSnapshot.filterSettings.locations.length
    || storageSnapshot.filterSettings.experienceYears.length
  );
  elements.clearHiddenJobs.disabled = !hasActiveFilters && selectedJobIds.size === 0;
}

async function hideSelectedJobs() {
  const selectedIds = Array.from(selectedJobIds);
  if (selectedIds.length === 0) {
    return;
  }
  selectedJobIds.clear();
  const operation = hiddenWriteQueue.then(async () => {
    const values = await chrome.storage.local.get(STORAGE_KEYS.hidden);
    const current = values[STORAGE_KEYS.hidden];
    const hiddenJobs = current && typeof current === "object" && !Array.isArray(current)
      ? { ...current }
      : {};
    for (const jobId of selectedIds) {
      hiddenJobs[jobId] = true;
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.hidden]: hiddenJobs });
  });
  hiddenWriteQueue = operation.catch((error) => {
    setFeedback(`Could not hide selected jobs: ${error.message}`);
  });
  await hiddenWriteQueue;
  render();
}

async function toggleHiddenJobsView() {
  if (showingHiddenJobs) {
    showingHiddenJobs = false;
    const tabToRestore = tabBeforeHiddenJobsView || ALL_TAB;
    tabBeforeHiddenJobsView = null;
    await selectTab(tabToRestore);
    return;
  }
  const hasHiddenOrOpenedJobs = getRecords().some((record) => {
    return storageSnapshot.hiddenJobsById[String(record.jobId || "")] === true
      || isRecordOpened(record);
  });
  if (!hasHiddenOrOpenedJobs) {
    return;
  }
  tabBeforeHiddenJobsView = selectedTab;
  showingHiddenJobs = true;
  await selectTab(ALL_TAB);
}

async function clearHiddenJobs() {
  selectedJobIds.clear();
  showingHiddenJobs = false;
  tabBeforeHiddenJobsView = null;
  elements.search.value = "";
  elements.applicantReviewFilter.value = "";
  for (const checkbox of [
    ...Object.values(elements.locationFilters),
    ...Object.values(elements.experienceFilters)
  ]) {
    checkbox.checked = false;
  }
  await persistFilterSettings();

  selectedTab = ALL_TAB;
  render();
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.selectedTab]: ALL_TAB });
  } catch (error) {
    setFeedback(`Could not clear the selected job tab: ${error.message}`);
  }
}

async function switchSite(siteId) {
  if (!globalThis.JobCollectorSiteRegistry.getAdapter(siteId)) {
    return;
  }
  try {
    selectedJobIds.clear();
    await chrome.storage.local.set({ [LAST_SITE_KEY]: siteId });
    const destination = new URL(globalThis.location.href);
    destination.search = "";
    destination.hash = "";
    if (typeof globalThis.location.assign === "function") {
      globalThis.location.assign(destination.href);
      return;
    }
    globalThis.location.search = destination.search;
    await initializeResultsPage();
  } catch (error) {
    setFeedback(`Could not switch sites: ${error.message}`);
  }
}

async function initializeResultsPage() {
  const preference = await chrome.storage.local.get([LAST_SITE_KEY, "records"]);
  const savedSite = preference[LAST_SITE_KEY];
  const siteId = REQUESTED_SITE_ID
    || (globalThis.JobCollectorSiteRegistry.getAdapter(savedSite) ? savedSite : "linkedin");
  configureSite(siteId);
  if (savedSite !== siteId) {
    await chrome.storage.local.set({ [LAST_SITE_KEY]: siteId });
  }
  if (globalThis.history && typeof globalThis.history.replaceState === "function") {
    const canonicalUrl = new URL(globalThis.location.href);
    canonicalUrl.search = "";
    canonicalUrl.hash = "";
    if (canonicalUrl.href !== globalThis.location.href) {
      globalThis.history.replaceState(null, "", canonicalUrl.href);
    }
  }
  renderSiteCounts(preference.records);
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.opened,
    STORAGE_KEYS.hidden,
    STORAGE_KEYS.runState,
    STORAGE_KEYS.selectedTab,
    STORAGE_KEYS.filters,
    getSkipTitlesStorageKey(siteId)
  ]);
  storageSnapshot = {
    jobsById: await readSiteJobs(),
    openedJobsById: values[STORAGE_KEYS.opened] || {},
    hiddenJobsById: values[STORAGE_KEYS.hidden] || {},
    filterSettings: normalizeFilterSettings(values[STORAGE_KEYS.filters]),
    collectorState: values[STORAGE_KEYS.runState] || null,
    resultsSelectedTab: values[STORAGE_KEYS.selectedTab] || null,
    skipTitles: normalizeSkipTitles(values[getSkipTitlesStorageKey(siteId)])
  };
  renderSkipTitleList();
  setFilterControls(storageSnapshot.filterSettings);
  chooseInitialTab(getRecords());
  if (storageSnapshot.resultsSelectedTab !== selectedTab) {
    await chrome.storage.local.set({ [STORAGE_KEYS.selectedTab]: selectedTab });
  }
  render();
  setDefaultHistoryRange();
}

function handleTabKeydown(event, tab) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  const navigationTabs = [ALL_TAB, ...APPLY_TABS];
  const currentIndex = navigationTabs.indexOf(tab);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? navigationTabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + navigationTabs.length) % navigationTabs.length;
  const nextTab = navigationTabs[nextIndex];
  const button = getTabButton(nextTab, nextIndex);
  button.focus();
  void selectTab(nextTab);
}

elements.allTab.addEventListener("click", () => selectTab(ALL_TAB));
elements.easyTab.addEventListener("click", () => selectTab(APPLY_TABS[0]));
elements.directTab.addEventListener("click", () => selectTab("Direct Apply"));
elements.companyTab.addEventListener("click", () => {
  const companyTab = APPLY_TABS.find((tab) => tab === "Company Apply" || tab === "Company Site");
  if (companyTab) void selectTab(companyTab);
});
for (const [index, tab] of [ALL_TAB, ...APPLY_TABS].entries()) {
  getTabButton(tab, index).addEventListener("keydown", (event) => handleTabKeydown(event, tab));
}
elements.linkedinSite.addEventListener("click", () => {
  void switchSite("linkedin");
});
elements.naukriSite.addEventListener("click", () => {
  void switchSite("naukri");
});
elements.indeedSite.addEventListener("click", () => {
  void switchSite("indeed");
});
elements.settingsButton.addEventListener("click", () => {
  const open = elements.settingsMenu.hidden;
  elements.settingsMenu.hidden = !open;
  elements.settingsButton.setAttribute("aria-expanded", String(open));
});
elements.historyButton.addEventListener("click", () => {
  closeSettingsMenu();
  void openHistoryDialog().catch((error) => {
    elements.historyError.textContent = `Could not load job history: ${error.message}`;
    elements.historyError.hidden = false;
  });
});
elements.historyClose.addEventListener("click", () => {
  elements.historyDialog.close();
});
elements.skipTitlesButton.addEventListener("click", () => {
  closeSettingsMenu();
  void openSkipTitleDialog().catch((error) => {
    showSkipTitleError(`Could not load skip titles: ${error.message}`);
  });
});
elements.skipTitleClose.addEventListener("click", () => {
  elements.skipTitleDialog.close();
});
elements.skipTitleForm.addEventListener("submit", (event) => {
  void submitSkipTitle(event);
});
elements.skipTitleCancelEdit.addEventListener("click", () => {
  resetSkipTitleEditor();
  elements.skipTitleError.hidden = true;
});
for (const dateInput of [elements.historyFrom, elements.historyTo]) {
  dateInput.addEventListener("change", () => {
    void renderHistory().catch((error) => {
      elements.historyError.textContent = `Could not load job history: ${error.message}`;
      elements.historyError.hidden = false;
    });
  });
}
elements.exportButton.addEventListener("click", () => {
  closeSettingsMenu();
  void exportStandaloneReport().catch((error) => {
    setFeedback(`Could not download the HTML report: ${error.message}`);
  });
});
elements.search.addEventListener("input", render);
elements.applicantReviewFilter.addEventListener("change", render);
elements.hideSelectedJobs.addEventListener("click", () => {
  void hideSelectedJobs();
});
elements.viewHiddenJobs.addEventListener("click", () => {
  void toggleHiddenJobsView();
});
elements.clearHiddenJobs.addEventListener("click", () => {
  void clearHiddenJobs();
});
for (const checkbox of [
  ...Object.values(elements.locationFilters),
  ...Object.values(elements.experienceFilters)
]) {
  checkbox.addEventListener("change", () => {
    void persistFilterSettings();
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes.records) {
    renderSiteCounts(changes.records.newValue);
  }
  if (changes[STORAGE_KEYS.jobs]) {
    storageSnapshot.jobsById = unpackSiteJobs(changes[STORAGE_KEYS.jobs].newValue);
    render();
    if (elements.historyDialog.open) {
      void renderHistory().catch((error) => {
        elements.historyError.textContent = `Could not load job history: ${error.message}`;
        elements.historyError.hidden = false;
      });
    }
    return;
  }
  for (const [key, change] of Object.entries(changes)) {
    if (key === STORAGE_KEYS.opened) {
      storageSnapshot.openedJobsById = change.newValue || {};
    } else if (key === STORAGE_KEYS.hidden) {
      storageSnapshot.hiddenJobsById = change.newValue || {};
      updateHideControls();
    } else if (key === STORAGE_KEYS.filters) {
      storageSnapshot.filterSettings = normalizeFilterSettings(change.newValue);
      setFilterControls(storageSnapshot.filterSettings);
    } else if (key === STORAGE_KEYS.runState) {
      storageSnapshot.collectorState = change.newValue || null;
    } else if (key === STORAGE_KEYS.selectedTab) {
      storageSnapshot.resultsSelectedTab = change.newValue || null;
    } else if (key === getSkipTitlesStorageKey()) {
      storageSnapshot.skipTitles = normalizeSkipTitles(change.newValue);
      renderSkipTitleList();
    }
  }
  if (
    changes[STORAGE_KEYS.selectedTab]
    && (
      changes[STORAGE_KEYS.selectedTab].newValue === ALL_TAB
      || APPLY_TABS.includes(changes[STORAGE_KEYS.selectedTab].newValue)
    )
  ) {
    selectedTab = changes[STORAGE_KEYS.selectedTab].newValue;
  }
  render();
  if (
    elements.historyDialog.open
    && (
      changes.records
      || HISTORY_OPENED_KEYS.some((key) => changes[key])
    )
  ) {
    void renderHistory().catch((error) => {
      elements.historyError.textContent = `Could not load job history: ${error.message}`;
      elements.historyError.hidden = false;
    });
  }
});

initializeResultsPage().catch((error) => {
  setFeedback(`Could not read saved results: ${error.message}`);
});
