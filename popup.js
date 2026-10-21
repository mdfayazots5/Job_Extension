"use strict";

const elements = {
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  viewResults: document.getElementById("view-results")
};

let storageSnapshot = {};
let activeSiteId = null;
let activeAdapter = null;
let storageKeys = null;

function renderFromStorage() {
  const runState = storageKeys ? storageSnapshot[storageKeys.runState] || {} : {};
  const budget = storageKeys ? storageSnapshot[storageKeys.budget] || {} : {};
  const config = activeAdapter ? activeAdapter.limits : globalThis.JobCollectorConfig;
  const active = ["RUNNING", "PAGINATING", "PAUSED"].includes(runState.state);
  const nextAllowed = getBudgetBlockReason(budget, config);

  elements.start.disabled = !activeSiteId
    || active
    || Boolean(runState.resultsOpening)
    || Boolean(nextAllowed);
  elements.stop.disabled = !activeSiteId || !active;
  elements.start.title = nextAllowed;
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
      let host = "";
      try {
        host = new URL(tab && tab.url || "").hostname;
      } catch (_error) {
        host = "";
      }
      renderFromStorage();
      elements.start.title = host === "in.indeed.com"
        ? "Open an Indeed /jobs search page with a search term."
        : "Open a LinkedIn, Naukri, or Indeed search results page.";
      return;
    }
    storageSnapshot = await chrome.storage.local.get([
      storageKeys.runState,
      storageKeys.budget,
      storageKeys.cooldown
    ]);
    await chrome.storage.local.set({ "ui.lastSite": activeSiteId });
    renderFromStorage();
  } catch (error) {
    elements.start.title = `Could not read collector status: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function sendAction(type) {
  try {
    if (!activeSiteId) {
      elements.start.title = "Open a LinkedIn, Naukri, or Indeed search results page.";
      return;
    }
    const response = await chrome.runtime.sendMessage({ type, siteId: activeSiteId });
    if (response && !response.ok && response.error) {
      elements.start.title = response.error;
      await refreshStorageSnapshot();
    }
  } catch (error) {
    elements.start.title = error instanceof Error
      ? error.message
      : "The service worker did not respond.";
  }
}

elements.start.addEventListener("click", () => sendAction("START_RUN"));
elements.stop.addEventListener("click", () => sendAction("STOP_RUN"));
elements.viewResults.addEventListener("click", async () => {
  try {
    if (activeSiteId) {
      await chrome.storage.local.set({ "ui.lastSite": activeSiteId });
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
  } catch (error) {
    elements.viewResults.title = `Could not open results: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
});
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
