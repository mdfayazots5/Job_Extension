"use strict";

const elements = {
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  state: document.getElementById("state"),
  currentPage: document.getElementById("current-page"),
  capturedCount: document.getElementById("captured-count"),
  maxPages: document.getElementById("max-pages"),
  maxJobs: document.getElementById("max-jobs"),
  jobsToday: document.getElementById("jobs-today"),
  maxJobsToday: document.getElementById("max-jobs-today"),
  budgetStatus: document.getElementById("budget-status"),
  notice: document.getElementById("notice")
};

let storageSnapshot = {};
let activeSiteId = null;
let activeAdapter = null;
let storageKeys = null;

function renderFromStorage() {
  const runState = storageKeys ? storageSnapshot[storageKeys.runState] || {} : {};
  const budget = storageKeys ? storageSnapshot[storageKeys.budget] || {} : {};
  const notice = storageKeys ? storageSnapshot[storageKeys.notice] || {} : {};
  const config = activeAdapter ? activeAdapter.limits : globalThis.JobCollectorConfig;
  const active = ["RUNNING", "PAGINATING", "PAUSED"].includes(runState.state);
  const nextAllowed = getBudgetBlockReason(budget, config);

  elements.state.textContent = runState.state || "IDLE";
  elements.currentPage.textContent = Number.isInteger(runState.currentPage)
    ? String(runState.currentPage)
    : "—";
  elements.capturedCount.textContent = String(runState.capturedCount || 0);
  elements.maxPages.textContent = String(config.maxPages);
  elements.maxJobs.textContent = String(config.maxJobsPerRun);
  elements.jobsToday.textContent = String(budget.jobsToday || 0);
  elements.maxJobsToday.textContent = String(config.maxJobsPerDay);
  elements.start.disabled = !activeSiteId || active || Boolean(runState.resultsOpening) || Boolean(nextAllowed);
  elements.stop.disabled = !activeSiteId || !active;
  elements.budgetStatus.textContent = nextAllowed || "";
  elements.notice.textContent = notice.text
    || (runState.capturedCount ? "" : "No jobs captured");
}

function getBudgetBlockReason(budget, config, now = Date.now()) {
  const today = new Date(now);
  const pad = (value) => String(value).padStart(2, "0");
  const dayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const jobsToday = budget.dayKey === dayKey ? budget.jobsToday || 0 : 0;
  if (jobsToday >= config.maxJobsPerDay) {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    return `Daily job cap reached. Start available after ${tomorrow.toLocaleString()}.`;
  }
  const cooldown = storageKeys ? storageSnapshot[storageKeys.cooldown] : null;
  if (cooldown && Number.isFinite(cooldown.until) && cooldown.until > now) {
    return `Collection is cooling down until ${new Date(cooldown.until).toLocaleString()}.`;
  }
  return "";
}

async function refreshStorageSnapshot() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const adapter = tab && typeof tab.url === "string"
      ? globalThis.JobCollectorSiteRegistry.getAdapterForUrl(tab.url)
      : null;
    activeAdapter = adapter;
    activeSiteId = adapter ? adapter.id : null;
    storageKeys = activeSiteId
      ? globalThis.JobCollectorStorage.keysForSite(activeSiteId)
      : null;
    if (!storageKeys) {
      storageSnapshot = {};
      elements.notice.textContent = "Open a LinkedIn or Naukri search results page.";
      renderFromStorage();
      return;
    }
    storageSnapshot = await chrome.storage.local.get([
      storageKeys.runState,
      storageKeys.notice,
      storageKeys.budget,
      storageKeys.cooldown
    ]);
    document.getElementById("view-results").href =
      `results.html?site=${encodeURIComponent(activeSiteId)}`;
    renderFromStorage();
  } catch (error) {
    elements.notice.textContent = `Could not read collector status: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function sendAction(type) {
  try {
    if (!activeSiteId) {
      elements.notice.textContent = "Open a LinkedIn or Naukri search results page.";
      return;
    }
    const response = await chrome.runtime.sendMessage({ type, siteId: activeSiteId });
    if (response && !response.ok && response.error) {
      elements.notice.textContent = response.error;
      await refreshStorageSnapshot();
    }
  } catch (error) {
    elements.notice.textContent = error instanceof Error
      ? error.message
      : "The service worker did not respond.";
  }
}

elements.start.addEventListener("click", () => sendAction("START_RUN"));
elements.stop.addEventListener("click", () => sendAction("STOP_RUN"));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !storageKeys) {
    return;
  }

  for (const [key, change] of Object.entries(changes)) {
    if (!Object.values(storageKeys).includes(key)) {
      continue;
    }
    if (change.newValue === undefined) {
      delete storageSnapshot[key];
    } else {
      storageSnapshot[key] = change.newValue;
    }
  }
  renderFromStorage();
});

void refreshStorageSnapshot();
