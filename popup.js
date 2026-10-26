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

async function appendPopupFlowLog(siteId, event, details = {}) {
  try {
    const keys = globalThis.JobCollectorStorage.keysForSite(siteId);
    const values = await chrome.storage.local.get([keys.flowLogging, keys.diagnostics]);
    if (values[keys.flowLogging] !== true) {
      return;
    }
    const previous = Array.isArray(values[keys.diagnostics])
      ? values[keys.diagnostics]
      : [];
    const safeDetails = {};
    if (typeof details.state === "string" && /^[A-Z_]{1,20}$/.test(details.state)) {
      safeDetails.state = details.state;
    }
    if (typeof details.ok === "boolean") {
      safeDetails.ok = details.ok;
    }
    if (typeof details.error === "string") {
      safeDetails.error = details.error
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
        .replace(/\b(token|csrf|cookie|authorization)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .slice(0, 240);
    }
    if (Number.isFinite(details.elapsedMs)) {
      safeDetails.elapsedMs = details.elapsedMs;
    }
    await chrome.storage.local.set({
      [keys.diagnostics]: previous.concat({
        at: new Date().toISOString(),
        flow: true,
        component: "popup",
        event,
        siteId,
        ...safeDetails
      }).slice(-200)
    });
  } catch (error) {
    console.error("[Job Extensions] Could not save popup flow log", error);
  }
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
  const button = type === "START_RUN" ? elements.start : elements.stop;
  button.disabled = true;
  let actionError = "";
  const actionStartedAt = Date.now();
  try {
    if (!activeSiteId) {
      actionError = "Open a LinkedIn, Naukri, or Indeed search results page.";
    } else {
      if (type === "START_RUN") {
        void appendPopupFlowLog(activeSiteId, "start_clicked");
      }
      const response = await chrome.runtime.sendMessage({ type, siteId: activeSiteId });
      if (response && !response.ok && response.error) {
        actionError = response.error;
      } else if (!response || !response.ok) {
        actionError = "The collector did not acknowledge the request.";
      }
      if (type === "START_RUN") {
        await appendPopupFlowLog(activeSiteId, "start_response", {
          ok: Boolean(response && response.ok),
          ...(actionError ? { error: actionError } : {}),
          elapsedMs: Date.now() - actionStartedAt
        });
      }
    }
  } catch (error) {
    actionError = error instanceof Error
      ? error.message
      : "The service worker did not respond.";
  } finally {
    await refreshStorageSnapshot();
    if (type === "START_RUN" && activeSiteId) {
      try {
        const runState = storageKeys ? storageSnapshot[storageKeys.runState] : null;
        await appendPopupFlowLog(activeSiteId, "run_state_after_start", {
          state: runState && typeof runState.state === "string" ? runState.state : "UNKNOWN",
          ...(actionError ? { error: actionError } : {}),
          elapsedMs: Date.now() - actionStartedAt
        });
      } catch (error) {
        console.error("[Job Extensions] Could not save popup flow log", error);
      }
    }
    if (actionError) {
      button.title = actionError;
    }
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
