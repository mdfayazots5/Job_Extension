"use strict";

const RESULT_PARAMS = new URLSearchParams(globalThis.location.search);
const REQUESTED_SITE_ID = RESULT_PARAMS.get("site") || RESULT_PARAMS.get("siteId");
let SITE_ID = REQUESTED_SITE_ID || "linkedin";
const STORAGE_API = globalThis.JobCollectorStorage;
let SITE_ADAPTER = globalThis.JobCollectorSiteRegistry.getAdapter(SITE_ID);
if (!SITE_ADAPTER) {
  throw new Error(`No results adapter is registered for site "${SITE_ID}".`);
}
let STORAGE_KEYS = getStorageKeys(SITE_ID);
let APPLY_TABS = SITE_ADAPTER.ui.tabs.map((tab) => tab.id);
let TAB_LABELS = Object.fromEntries(SITE_ADAPTER.ui.tabs.map((tab) => [tab.id, tab.label]));
const STANDALONE_REPORT_VERSION = 3;
const elements = {
  siteSwitcher: document.getElementById("site-switcher"),
  linkedinSite: document.getElementById("linkedin-site"),
  naukriSite: document.getElementById("naukri-site"),
  linkedinSiteCount: document.getElementById("linkedin-site-count"),
  naukriSiteCount: document.getElementById("naukri-site-count"),
  easyTab: document.getElementById("easy-tab"),
  companyTab: document.getElementById("company-tab"),
  panel: document.getElementById("results-panel"),
  columnHeadings: document.getElementById("column-headings"),
  tableBody: document.getElementById("job-table-body"),
  empty: document.getElementById("empty-state"),
  search: document.getElementById("search"),
  searchLabel: document.getElementById("search-label"),
  applicantReviewFilter: document.getElementById("applicant-review-filter"),
  hideOpened: document.getElementById("hide-opened"),
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
  total: document.getElementById("total-count"),
  skipped: document.getElementById("skipped-count"),
  feedback: document.getElementById("feedback")
};
const siteTitle = document.getElementById("site-title");
const LAST_SITE_KEY = "ui.lastSite";

let storageSnapshot = {
  jobsById: {},
  openedJobsById: {},
  collectorState: null,
  resultsSelectedTab: null
};
let selectedTab = APPLY_TABS[0];
let siteCounts = { linkedin: 0, naukri: 0 };
let openedWriteQueue = Promise.resolve();
let sortState = { key: "posted", direction: "descending" };
let reportDownloadPromise = null;

function getStorageKeys(siteId) {
  return Object.freeze({
    ...STORAGE_API.keysForSite(siteId),
    jobs: "records",
    opened: STORAGE_API.keysForSite(siteId).openedJobs
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
  selectedTab = APPLY_TABS[0];
  document.title = `${adapter.label} Jobs`;
  if (siteTitle) {
    siteTitle.textContent = `${adapter.label} Jobs`;
  }
  elements.applicantReviewFilter.closest("label").hidden = siteId !== "linkedin";
  elements.skipped.hidden = siteId !== "linkedin";
  elements.subtitle.hidden = siteId === "naukri";
  elements.siteRunFooter.hidden = siteId !== "naukri";
  elements.search.placeholder = siteId === "naukri"
    ? "Search role, company, agency, or skills"
    : "Search role or company";
  elements.searchLabel.textContent = siteId === "naukri"
    ? "Search jobs by role, company, hiring agency, or skills"
    : "Search jobs by role or company";
  elements.easyTab.hidden = false;
  elements.companyTab.hidden = false;
  elements.linkedinSite.setAttribute("aria-pressed", String(siteId === "linkedin"));
  elements.naukriSite.setAttribute("aria-pressed", String(siteId === "naukri"));
  document.body.dataset.site = siteId;
  if (siteId === "naukri") {
    document.body.style.setProperty("--site-accent", adapter.ui.accent);
  }
  renderHeaders();
  renderTabLabels();
}

function renderTabLabels() {
  elements.easyTab.textContent = `${TAB_LABELS[APPLY_TABS[0]]} (0)`;
  elements.companyTab.textContent = `${TAB_LABELS[APPLY_TABS[1]]} (0)`;
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
    elements.columnHeadings.appendChild(heading);
  }
}

function renderSiteCounts(namespacedRecords) {
  const records = namespacedRecords && typeof namespacedRecords === "object"
    ? namespacedRecords
    : {};
  siteCounts = {
    linkedin: Object.keys(records).filter((key) => key.startsWith("linkedin:")).length,
    naukri: Object.keys(records).filter((key) => key.startsWith("naukri:")).length
  };
  elements.linkedinSiteCount.textContent = String(siteCounts.linkedin);
  elements.naukriSiteCount.textContent = String(siteCounts.naukri);
  elements.linkedinSite.classList.toggle("is-empty", siteCounts.linkedin === 0);
  elements.naukriSite.classList.toggle("is-empty", siteCounts.naukri === 0);
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
  return records.filter((record) => getRecordTab(record) === tab);
}

function getRecordTab(record) {
  return typeof SITE_ADAPTER.ui.tabFor === "function"
    ? SITE_ADAPTER.ui.tabFor(record)
    : record.applyType;
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildStandaloneReport(records, openedJobsById, runState, savedSelectedTab) {
  const reportTabs = SITE_ADAPTER.ui.tabs.map(({ id, label }) => ({ id, label }));
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
    tabId: getRecordTab(record),
    companyApplyUrl: validHttpUrl(record.companyApplyUrl),
    postedType: record.postedType,
    postedText: String(record.postedText || "Date not listed"),
    postedDateEstimate: String(record.postedDateEstimate || ""),
    applicantReviewStatus: record.applicantReviewStatus === "actively-reviewing"
      ? "actively-reviewing"
      : "not-indicated",
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
  const runDate = formatRunDate(runState);
  const skippedCount = SITE_ID === "linkedin"
    ? records.filter((record) => record.applyType === "Unknown").length
    : 0;
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
    .toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
    .tabs,.filters{display:flex;align-items:center;gap:8px}.tabs{gap:4px;padding:4px;border:1px solid var(--border);border-radius:12px;background:var(--surface-soft)}
    .tab{min-height:40px;padding:8px 15px;border:1px solid transparent;border-radius:9px;background:var(--surface);color:var(--muted);cursor:pointer;font-size:.9rem;font-weight:650}
    .tab:hover{color:var(--text)}.tab[aria-selected="true"]{background:var(--easy);color:#fff;box-shadow:0 2px 5px rgb(10 42 78 / 16%)}
    body[data-active-tab="Company Site"] .tab[aria-selected="true"]{background:var(--company)}
    .search-control input{width:min(310px,34vw);min-height:40px;padding:8px 13px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-size:.88rem}
    .search-control input:focus{border-color:var(--easy);outline:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--easy) 16%,transparent)}
    body[data-active-tab="Company Site"] .search-control input:focus{border-color:var(--company);box-shadow:0 0 0 3px color-mix(in srgb,var(--company) 16%,transparent)}
    .review-filter select{min-height:40px;padding:8px 30px 8px 11px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-size:.84rem}
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
    .review-status-tag{display:inline-flex;align-items:center;margin:4px 5px 0 0;padding:3px 8px;border-radius:999px;background:var(--surface-soft);color:var(--muted);font-size:.68rem;font-weight:650;line-height:1.35}
    .review-status-tag.is-active{background:#e6f6ed;color:#17633a}
    .apply-column,.apply-cell{width:10.5%;text-align:right}.apply-cell-content{display:inline-flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px 8px}
    .apply-link{display:inline-flex;min-height:32px;align-items:center;justify-content:center;padding:6px 14px;border-radius:999px;background:var(--easy);color:#fff;font-size:.82rem;font-weight:700;text-decoration:none;white-space:nowrap}
    body[data-active-tab="Company Site"] .apply-link{background:var(--company)}.apply-link[aria-disabled="true"]{cursor:not-allowed;opacity:.55}
    .via-linkedin{color:var(--muted);font-size:.72rem;white-space:nowrap}.opened-tag{display:inline-flex;align-items:center;gap:4px;color:var(--opened);font-size:.72rem;white-space:nowrap}
    .opened-tag a{color:inherit;font-size:.7rem;text-decoration:underline;text-underline-offset:2px}.empty-state{margin:0;padding:42px 16px;color:var(--muted);text-align:center}
    .skipped-count{margin:12px 2px 0;color:var(--muted);font-size:.82rem}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;clip-path:inset(50%)}
    @media(prefers-color-scheme:dark){:root{--page:#111a23;--surface:#192531;--surface-soft:#202e3b;--text:#edf3f8;--muted:#aab7c4;--border:#344553;--easy:#3285d6;--easy-soft:#203b56;--company:#13988e;--company-soft:#1d4945;--opened:#b0bdc9}.posted-badge.is-reposted{background:#4a351f;color:#ffd29b}.review-status-tag.is-active{background:#1d4933;color:#a9e6c0}}
    @media(max-width:720px){.page-shell{width:min(100% - 24px,560px);padding-top:18px}.page-header{flex-wrap:wrap;gap:4px 12px;margin-bottom:14px}h1{font-size:1.35rem}.total-count{margin-left:0}
    .toolbar{align-items:stretch;flex-direction:column;gap:10px}.tabs{display:grid;grid-template-columns:1fr 1fr}.filters{justify-content:space-between}.search-control{flex:1}.search-control input{width:100%}.review-filter{flex:1}.review-filter select{width:100%}
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
      <h1>LinkedIn Jobs</h1>
      <p class="subtitle">${escapeHtml(runDate)}</p>
      <p class="total-count">${records.length} ${records.length === 1 ? "job" : "jobs"}</p>
    </header>
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Job application type">
        <button id="easy-tab" class="tab" type="button" role="tab" aria-selected="true" aria-controls="results-panel" tabindex="0">Easy Apply (0)</button>
        <button id="company-tab" class="tab" type="button" role="tab" aria-selected="false" aria-controls="results-panel" tabindex="-1">Company Apply (0)</button>
      </div>
      <div class="filters">
        <label class="search-control"><span class="visually-hidden">Search jobs by role or company</span><input id="search" type="search" autocomplete="off" placeholder="Search role or company"></label>
        <label class="review-filter"><span class="visually-hidden">Filter by applicant review status</span><select id="applicant-review-filter"><option value="">All review statuses</option><option value="actively-reviewing">Actively reviewing</option><option value="not-indicated">No status shown</option></select></label>
        <label class="hide-opened-control"><input id="hide-opened" type="checkbox"><span>Hide opened</span></label>
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
    <p class="skipped-count">${skippedCount} skipped (no apply option)</p>
  </main>
  <script>
    "use strict";
    const records = ${embeddedRecords};
    const initiallyOpened = ${embeddedOpened};
    const tabs = ${embeddedTabs};
    const easyTab = document.getElementById("easy-tab");
    const companyTab = document.getElementById("company-tab");
    const body = document.getElementById("job-table-body");
    const search = document.getElementById("search");
    const applicantReviewFilter = document.getElementById("applicant-review-filter");
    const hideOpened = document.getElementById("hide-opened");
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
    const render = () => {
      const grouped = records.filter((record) => record.tabId === selectedTab);
      const term = search.value.trim().toLocaleLowerCase();
      const reviewStatus = applicantReviewFilter.value;
      const matched = grouped.filter((record) => (
        (!reviewStatus || (record.applicantReviewStatus === "actively-reviewing"
          ? "actively-reviewing"
          : "not-indicated") === reviewStatus)
        && (record.title + " " + record.company).toLocaleLowerCase().includes(term)
      ));
      const visible = matched.filter((record) => !hideOpened.checked || opened[record.jobId] !== true);
      const direction = sortState.direction === "ascending" ? 1 : -1;
      visible.sort((a, b) => {
        let result = 0;
        if (sortState.key === "role" || sortState.key === "company") {
          const field = sortState.key === "role" ? "title" : "company";
          result = String(a[field] || "").localeCompare(String(b[field] || ""), undefined, { sensitivity: "base" });
        } else {
          const dateA = Date.parse(a.postedDateEstimate || a.capturedAt || "");
          const dateB = Date.parse(b.postedDateEstimate || b.capturedAt || "");
          result = (Number.isNaN(dateA) ? -Infinity : dateA) - (Number.isNaN(dateB) ? -Infinity : dateB);
        }
        return result * direction;
      });
      easyTab.textContent = tabs[0].label + " (" + records.filter((record) => record.tabId === tabs[0].id).length + ")";
      companyTab.textContent = tabs[1].label + " (" + records.filter((record) => record.tabId === tabs[1].id).length + ")";
      easyTab.setAttribute("aria-selected", String(selectedTab === tabs[0].id));
      companyTab.setAttribute("aria-selected", String(selectedTab === tabs[1].id));
      easyTab.tabIndex = selectedTab === tabs[0].id ? 0 : -1;
      companyTab.tabIndex = selectedTab === tabs[1].id ? 0 : -1;
      panel.setAttribute("aria-labelledby", selectedTab === tabs[0].id ? "easy-tab" : "company-tab");
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
        const date = absoluteDate(record.postedDateEstimate);
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
        : reviewStatus && matched.length === 0 && grouped.length > 0
          ? "No jobs match this applicant-review filter."
          : hideOpened.checked && matched.length > 0
            ? "All matching jobs have been opened."
            : selectedTab === tabs[0].id
              ? "No " + tabs[0].label + " jobs captured yet."
              : "No " + tabs[1].label + " jobs captured yet.";
    };
    const selectTab = (tab) => {
      selectedTab = tab;
      try { localStorage.setItem(tabStorageKey, tab); } catch (_error) {}
      render();
    };
    easyTab.addEventListener("click", () => selectTab(tabs[0].id));
    companyTab.addEventListener("click", () => selectTab(tabs[1].id));
    for (const [tab, button] of [[tabs[0].id, easyTab], [tabs[1].id, companyTab]]) {
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home"
          ? tabs[0].id
          : event.key === "End"
            ? tabs[1].id
            : tab === tabs[0].id ? tabs[1].id : tabs[0].id;
        (next === tabs[0].id ? easyTab : companyTab).focus();
        selectTab(next);
      });
    }
    search.addEventListener("input", render);
    applicantReviewFilter.addEventListener("change", render);
    hideOpened.addEventListener("change", render);
    for (const [key, button] of Object.entries(sortButtons)) {
      button.addEventListener("click", () => {
        sortState = sortState.key === key
          ? { key, direction: sortState.direction === "ascending" ? "descending" : "ascending" }
          : { key, direction: key === "posted" ? "descending" : "ascending" };
        render();
      });
    }
    const preferredTab = records.some((record) => record.tabId === tabs[0].id)
      ? tabs[0].id
      : tabs[1].id;
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
  return `linkedin-jobs-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.html`;
}

async function maybeDownloadStandaloneReport() {
  const state = storageSnapshot.collectorState;
  const requestedRunId = new URLSearchParams(globalThis.location.search).get("runId");
  if (
    !state
    || (state.state !== "DONE" && state.state !== "STOPPED")
    || !requestedRunId
    || state.runId !== requestedRunId
    || (
      state.htmlReportDownloaded
      && state.htmlReportVersion === STANDALONE_REPORT_VERSION
    )
    || getRecords().length === 0
    || reportDownloadPromise
  ) {
    return;
  }

  reportDownloadPromise = (async () => {
    const latestValues = await chrome.storage.local.get([
      STORAGE_KEYS.runState,
      STORAGE_KEYS.opened,
      STORAGE_KEYS.selectedTab
    ]);
    const latestState = latestValues[STORAGE_KEYS.runState];
    if (
      !latestState
      || latestState.runId !== requestedRunId
      || (latestState.state !== "DONE" && latestState.state !== "STOPPED")
      || (
        latestState.htmlReportDownloaded
        && latestState.htmlReportVersion === STANDALONE_REPORT_VERSION
      )
    ) {
      return;
    }
    const latestJobs = await readSiteJobs();
    const records = Object.values(latestJobs).filter((record) => record && typeof record === "object");
    if (records.length === 0) {
      return;
    }
    const html = buildStandaloneReport(
      records,
      latestValues[STORAGE_KEYS.opened],
      latestState,
      latestValues[STORAGE_KEYS.selectedTab]
    );
    const objectUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.runState]: {
          ...latestState,
          htmlReportDownloaded: true,
          htmlReportVersion: STANDALONE_REPORT_VERSION
        }
      });
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
      setFeedback(`Could not download the HTML report: ${error.message}`);
    }
  })().finally(() => {
    reportDownloadPromise = null;
  });
  await reportDownloadPromise;
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
  const isOpened = storageSnapshot.openedJobsById
    && storageSnapshot.openedJobsById[jobId] === true;
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
  cells.location = locationCell;
  cells.experience = createTextElement("td", "experience-cell", record.experience || "—");
  cells.experience.setAttribute("data-label", "Exp");
  cells.salary = createTextElement("td", "salary-cell", record.salary || "—");
  cells.salary.setAttribute("data-label", "Salary");

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
  postedContent.appendChild(createTextElement(
    "span",
    "posted-relative",
    record.postedText || "Date not listed"
  ));
  postedCell.appendChild(postedContent);
  const absoluteDate = formatAbsoluteDate(record.postedDateEstimate);
  if (absoluteDate) {
    const date = createTextElement("span", "absolute-date", absoluteDate);
    if (SITE_ID === "naukri" && record.postedApprox) {
      date.setAttribute("title", `Approximate date estimated from "${record.postedText || "unknown posting age"}".`);
    }
    postedCell.appendChild(date);
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
    row.appendChild(cells[column.id]);
  }
  return row;
}

function sortRecords(records) {
  const sorted = records.slice();
  const direction = sortState.direction === "ascending" ? 1 : -1;
  sorted.sort((first, second) => {
    let comparison = 0;
    if (sortState.key === "role") {
      comparison = String(first.title || "").localeCompare(
        String(second.title || ""), undefined, { sensitivity: "base" }
      );
    } else if (sortState.key === "company") {
      comparison = String(first.company || "").localeCompare(
        String(second.company || ""), undefined, { sensitivity: "base" }
      );
    } else {
      const firstDate = Date.parse(first.postedDateEstimate || first.capturedAt || "");
      const secondDate = Date.parse(second.postedDateEstimate || second.capturedAt || "");
      const normalizedFirst = Number.isNaN(firstDate) ? -Infinity : firstDate;
      const normalizedSecond = Number.isNaN(secondDate) ? -Infinity : secondDate;
      comparison = normalizedFirst - normalizedSecond;
    }
    return comparison * direction;
  });
  return sorted;
}

function chooseInitialTab(records) {
  const storedTab = storageSnapshot.resultsSelectedTab;
  if (APPLY_TABS.includes(storedTab)) {
    const otherTab = APPLY_TABS.find((tab) => tab !== storedTab);
    selectedTab = getRecordsForTab(records, storedTab).length > 0
      || getRecordsForTab(records, otherTab).length === 0
      ? storedTab
      : otherTab;
    return;
  }
  selectedTab = APPLY_TABS.find((tab) => getRecordsForTab(records, tab).length > 0)
    || APPLY_TABS[0];
}

function render() {
  try {
    const records = getRecords();
    const firstRecords = getRecordsForTab(records, APPLY_TABS[0]);
    const secondRecords = getRecordsForTab(records, APPLY_TABS[1]);
    const skippedCount = SITE_ID === "linkedin"
      ? records.filter((record) => record.applyType === "Unknown").length
      : 0;
    const activeRecords = selectedTab === APPLY_TABS[0] ? firstRecords : secondRecords;
    const searchTerm = elements.search.value.trim().toLocaleLowerCase();
    const applicantReviewStatus = elements.applicantReviewFilter.value;
    const matchingRecords = activeRecords.filter((record) => (
      (!applicantReviewStatus
        || (record.applicantReviewStatus === "actively-reviewing"
          ? "actively-reviewing"
          : "not-indicated") === applicantReviewStatus)
      && `${record.title || ""} ${record.company || ""} ${record.postedBy || ""} ${
        Array.isArray(record.skills) ? record.skills.join(" ") : ""
      }`
        .toLocaleLowerCase()
        .includes(searchTerm)
    ));
    const visibleRecords = sortRecords(matchingRecords.filter((record) => (
      !elements.hideOpened.checked
      || !storageSnapshot.openedJobsById
      || storageSnapshot.openedJobsById[String(record.jobId || "")] !== true
    )));

    elements.easyTab.textContent = `${TAB_LABELS[APPLY_TABS[0]]} (${firstRecords.length})`;
    elements.companyTab.textContent = `${TAB_LABELS[APPLY_TABS[1]]} (${secondRecords.length})`;
    elements.easyTab.setAttribute("aria-selected", String(selectedTab === APPLY_TABS[0]));
    elements.companyTab.setAttribute("aria-selected", String(selectedTab === APPLY_TABS[1]));
    elements.easyTab.tabIndex = selectedTab === APPLY_TABS[0] ? 0 : -1;
    elements.companyTab.tabIndex = selectedTab === APPLY_TABS[1] ? 0 : -1;
    elements.panel.setAttribute(
      "aria-labelledby",
      selectedTab === APPLY_TABS[0] ? "easy-tab" : "company-tab"
    );
    document.body.dataset.activeTab = selectedTab;
    elements.total.textContent = `${records.length} ${records.length === 1 ? "job" : "jobs"}`;
    const runInfo = formatRunDate(storageSnapshot.collectorState);
    elements.subtitle.textContent = runInfo;
    elements.siteRunFooter.textContent = runInfo;
    elements.skipped.hidden = SITE_ID !== "linkedin";
    elements.skipped.textContent = `${skippedCount} skipped (no apply option)`;
    elements.tableBody.replaceChildren();
    visibleRecords.forEach((record, index) => {
      elements.tableBody.appendChild(createJobRow(record, selectedTab, index + 1));
    });
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
      : applicantReviewStatus && matchingRecords.length === 0 && activeRecords.length > 0
        ? "No jobs match this applicant-review filter."
      : elements.hideOpened.checked && matchingRecords.length > 0
        ? "All matching jobs have been opened."
        : selectedTab === APPLY_TABS[0]
          ? `No ${TAB_LABELS[APPLY_TABS[0]]} jobs captured yet.`
          : `No ${TAB_LABELS[APPLY_TABS[1]]} jobs captured yet.`;
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
  if (!APPLY_TABS.includes(tab)) {
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

async function switchSite(siteId) {
  if (!globalThis.JobCollectorSiteRegistry.getAdapter(siteId)) {
    return;
  }
  try {
    await chrome.storage.local.set({ [LAST_SITE_KEY]: siteId });
    const destination = new URL(globalThis.location.href);
    destination.searchParams.set("site", siteId);
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
  renderSiteCounts(preference.records);
  const values = await chrome.storage.local.get([
    STORAGE_KEYS.opened,
    STORAGE_KEYS.runState,
    STORAGE_KEYS.selectedTab
  ]);
  storageSnapshot = {
    jobsById: await readSiteJobs(),
    openedJobsById: values[STORAGE_KEYS.opened] || {},
    collectorState: values[STORAGE_KEYS.runState] || null,
    resultsSelectedTab: values[STORAGE_KEYS.selectedTab] || null
  };
  chooseInitialTab(getRecords());
  if (storageSnapshot.resultsSelectedTab !== selectedTab) {
    await chrome.storage.local.set({ [STORAGE_KEYS.selectedTab]: selectedTab });
  }
  render();
  await maybeDownloadStandaloneReport();
}

function handleTabKeydown(event, tab) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  const nextTab = event.key === "Home"
    ? APPLY_TABS[0]
    : event.key === "End"
      ? APPLY_TABS[1]
      : tab === APPLY_TABS[0] ? APPLY_TABS[1] : APPLY_TABS[0];
  const button = nextTab === APPLY_TABS[0] ? elements.easyTab : elements.companyTab;
  button.focus();
  void selectTab(nextTab);
}

elements.easyTab.addEventListener("click", () => selectTab(APPLY_TABS[0]));
elements.companyTab.addEventListener("click", () => selectTab(APPLY_TABS[1]));
elements.easyTab.addEventListener("keydown", (event) => handleTabKeydown(event, APPLY_TABS[0]));
elements.companyTab.addEventListener("keydown", (event) => handleTabKeydown(event, APPLY_TABS[1]));
elements.linkedinSite.addEventListener("click", () => {
  void switchSite("linkedin");
});
elements.naukriSite.addEventListener("click", () => {
  void switchSite("naukri");
});
elements.search.addEventListener("input", render);
elements.applicantReviewFilter.addEventListener("change", render);
elements.hideOpened.addEventListener("change", render);

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
    void maybeDownloadStandaloneReport().catch((error) => {
      setFeedback(`Could not prepare the HTML report: ${error.message}`);
    });
    return;
  }
  for (const [key, change] of Object.entries(changes)) {
    if (key === STORAGE_KEYS.opened) {
      storageSnapshot.openedJobsById = change.newValue || {};
    } else if (key === STORAGE_KEYS.runState) {
      storageSnapshot.collectorState = change.newValue || null;
    } else if (key === STORAGE_KEYS.selectedTab) {
      storageSnapshot.resultsSelectedTab = change.newValue || null;
    }
  }
  if (
    changes[STORAGE_KEYS.selectedTab]
    && APPLY_TABS.includes(changes[STORAGE_KEYS.selectedTab].newValue)
  ) {
    selectedTab = changes[STORAGE_KEYS.selectedTab].newValue;
  }
  render();
  void maybeDownloadStandaloneReport().catch((error) => {
    setFeedback(`Could not prepare the HTML report: ${error.message}`);
  });
});

initializeResultsPage().catch((error) => {
  setFeedback(`Could not read saved results: ${error.message}`);
});
