"use strict";

// Guided tour shown on first install (and from "Help & tour" in the popup/results page).
//   welcome.html            -> the main product tour
//   welcome.html#site=<id>  -> a step-by-step guide for one site module
// Sites are discovered from JobCollectorSiteGuides (src/sites/<id>/guide.js) plus the registry,
// so a newly added site appears here automatically once it ships a guide.js.

const ui = {
  kicker: document.getElementById("tour-kicker"),
  progressText: document.getElementById("tour-progress-text"),
  dots: document.getElementById("tour-dots"),
  card: document.getElementById("tour-card"),
  back: document.getElementById("tour-back"),
  next: document.getElementById("tour-next"),
  skip: document.getElementById("tour-skip"),
  status: document.getElementById("tour-status")
};

const guides = Object.values(globalThis.JobCollectorSiteGuides || {});
const registry = globalThis.JobCollectorSiteRegistry;

function adapterFor(siteId) {
  return registry && typeof registry.getAdapter === "function" ? registry.getAdapter(siteId) : null;
}

function accentFor(guide) {
  const adapter = adapterFor(guide.id);
  return (adapter && adapter.ui && adapter.ui.accent) || guide.accent || "#2164f3";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function list(items, className = "tour-list") {
  const ul = el("ul", className);
  for (const item of items) ul.appendChild(el("li", "", item));
  return ul;
}

function numberedSteps(items) {
  const ol = el("ol", "tour-steps");
  items.forEach((item) => {
    const li = el("li", "tour-step");
    li.appendChild(el("strong", "", item.title));
    li.appendChild(el("p", "", item.text));
    ol.appendChild(li);
  });
  return ol;
}

function setStatus(text, kind = "") {
  ui.status.textContent = text;
  ui.status.dataset.kind = kind;
}

async function markSiteGuideSeen(siteId) {
  try {
    await chrome.storage.local.set({ [`onboarding.site.${siteId}.seen`]: true });
  } catch (_error) {
    // Non-critical: the popup simply offers the guide again.
  }
}

async function loadSamples(siteIds) {
  if (!globalThis.JobCollectorDemoData) {
    throw new Error("Sample data module is not loaded.");
  }
  const count = await globalThis.JobCollectorDemoData.seed(siteIds);
  const firstSite = (siteIds && siteIds[0]) || (guides[0] && guides[0].id) || "linkedin";
  await chrome.storage.local.set({ "ui.lastSite": firstSite });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`results.html?site=${firstSite}`) });
  return count;
}

function sampleButton(label, siteIds) {
  const button = el("button", "tour-button primary inline", label);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const count = await loadSamples(siteIds);
      setStatus(count > 0
        ? `Loaded ${count} sample jobs. The results page opened in a new tab.`
        : "You already have real jobs collected, so no samples were added. Your results page opened in a new tab.", "ok");
    } catch (error) {
      setStatus(`Could not load sample jobs: ${error.message}`, "error");
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function openSiteButton(guide) {
  const link = el("a", "tour-button secondary inline", `Open ${guide.label} job search`);
  link.href = guide.searchUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

// ---------- Main tour ----------

function mainTourSteps() {
  return [
    {
      kicker: "Welcome",
      title: "Collect jobs from your searches into one clean list",
      render(card) {
        card.appendChild(el("p", "lead",
          "Job Extensions reads the job search you already have open on LinkedIn, Naukri or Indeed and saves every listing into a single, sortable list on your computer."));
        card.appendChild(list([
          "One list for every page of results, with no copy-pasting.",
          "Easy Apply and company-site jobs are split into separate tabs.",
          "Jobs you've opened are marked, so you don't apply twice.",
          "Everything stays in your browser. Nothing is uploaded anywhere."
        ]));
        card.appendChild(el("p", "note",
          "It never applies, saves, or messages anyone for you. It only reads the pages you open."));
      }
    },
    {
      kicker: "Supported sites",
      title: "Each site has its own module",
      render(card) {
        card.appendChild(el("p", "lead", "Open the guide for a site to see exactly what it collects and how to use it."));
        const grid = el("div", "site-grid");
        for (const guide of guides) {
          const tile = el("article", "site-tile");
          tile.style.setProperty("--accent", accentFor(guide));
          tile.appendChild(el("h3", "", guide.label));
          tile.appendChild(el("p", "", guide.summary));
          tile.appendChild(list(guide.collects.slice(0, 4), "tour-list compact"));
          const open = el("a", "tile-link", `How to use ${guide.label} →`);
          open.href = `#site=${guide.id}`;
          tile.appendChild(open);
          grid.appendChild(tile);
        }
        card.appendChild(grid);
      }
    },
    {
      kicker: "How it works",
      title: "Collecting jobs takes four steps",
      render(card) {
        card.appendChild(numberedSteps([
          { title: "Open a job search", text: "Go to LinkedIn, Naukri or Indeed, search for a role, and set your filters as usual." },
          { title: "Click the extension icon", text: "Click the Job Extensions icon in Chrome's toolbar (see the pin tip below)." },
          { title: "Press Start", text: "It goes through the results page by page. Keep that tab open and visible. Stop works any time and keeps what was collected." },
          { title: "Press View", text: "The results page opens with all collected jobs, ready to filter and apply." }
        ]));
        const pin = el("div", "tip");
        pin.appendChild(el("strong", "", "Tip: pin the icon. "));
        pin.appendChild(document.createTextNode(
          "Click the puzzle-piece icon at the top-right of Chrome, then the pin next to \"Job Extensions\", so the button is always visible."));
        card.appendChild(pin);
      }
    },
    {
      kicker: "Results page",
      title: "What you can do with your list",
      render(card) {
        card.appendChild(list([
          "Site switcher: flip between LinkedIn, Naukri and Indeed lists (each is kept separately).",
          "Tabs: Easy Apply, Company Apply, or All.",
          "Search box: filter by role or company, matched the way you'd type it.",
          "Filters: location and experience bands (where the site provides them).",
          "Opened / Hide: jobs you've clicked are marked, and you can hide jobs you're not interested in.",
          "⚙ Settings: History (jobs per day), Export (a standalone HTML report), Skip Title (always ignore roles like \"Intern\"), and logs for troubleshooting."
        ]));
      }
    },
    {
      kicker: "Built-in safety",
      title: "Why a run may stop on its own",
      render(card) {
        card.appendChild(el("p", "lead",
          "To behave like a normal person browsing, the collector paces itself and has hard limits:"));
        const rows = el("div", "limits");
        for (const guide of guides) {
          const adapter = adapterFor(guide.id);
          if (!adapter || !adapter.limits) continue;
          const row = el("div", "limit-row");
          row.style.setProperty("--accent", accentFor(guide));
          row.appendChild(el("strong", "", guide.label));
          row.appendChild(el("span", "",
            `up to ${adapter.limits.maxJobsPerRun} jobs per run · ${adapter.limits.maxJobsPerDay} per day · ${adapter.limits.maxPages} pages`));
          rows.appendChild(row);
        }
        card.appendChild(rows);
        card.appendChild(list([
          "Random, human-like pauses between pages.",
          "It only works while the tab is visible; switching away pauses it.",
          "If a site shows a captcha, sign-in wall or \"unusual activity\" page, it stops and that site cools down for 24 hours (48 hours if it happens again within a week).",
          "It never retries automatically. You decide when to run again."
        ]));
      }
    },
    {
      kicker: "Try it",
      title: "See it in action with sample jobs",
      render(card) {
        card.appendChild(el("p", "lead",
          "Not ready to run a real search? Load a few sample jobs for each site and explore the results page. A yellow banner marks them as samples, and they disappear by themselves as soon as you collect real jobs (or click \"Clear sample data\")."));
        const actions = el("div", "tour-actions");
        actions.appendChild(sampleButton("Load sample jobs", null));
        card.appendChild(actions);
        card.appendChild(el("p", "lead", "Or start for real:"));
        const sites = el("div", "tour-actions");
        for (const guide of guides) sites.appendChild(openSiteButton(guide));
        card.appendChild(sites);
        card.appendChild(el("p", "note",
          "You can reopen this tour any time from ⚙ Settings → Help & tour on the results page, or from the popup."));
      }
    }
  ];
}

// ---------- Per-site guide ----------

function siteTourSteps(guide) {
  const adapter = adapterFor(guide.id);
  const limits = adapter && adapter.limits;
  const steps = [
    {
      kicker: `${guide.label} module`,
      title: `What the ${guide.label} module does`,
      render(card) {
        card.appendChild(el("p", "lead", guide.summary));
        card.appendChild(el("h3", "section-title", "What it collects for each job"));
        card.appendChild(list(guide.collects));
        card.appendChild(el("h3", "section-title", "Where it works"));
        card.appendChild(el("p", "", `Start it on ${guide.pageHint}. On any other page the Start button stays disabled.`));
        if (limits) {
          card.appendChild(el("p", "note",
            `Limits: up to ${limits.maxJobsPerRun} jobs per run, ${limits.maxJobsPerDay} per day, ${limits.maxPages} pages per run.`));
        }
      }
    }
  ];
  guide.steps.forEach((step, index) => {
    steps.push({
      kicker: `${guide.label}: step ${index + 1} of ${guide.steps.length}`,
      title: step.title,
      render(card) {
        const big = el("div", "big-step");
        big.appendChild(el("span", "big-step-number", String(index + 1)));
        big.appendChild(el("p", "lead", step.text));
        card.appendChild(big);
      }
    });
  });
  steps.push({
    kicker: "You're ready",
    title: `Try ${guide.label} now`,
    render(card) {
      card.appendChild(el("p", "lead",
        `Open a ${guide.label} search, then click the extension icon and press Start. To see the results page first, load sample ${guide.label} jobs.`));
      const actions = el("div", "tour-actions");
      actions.appendChild(openSiteButton(guide));
      actions.appendChild(sampleButton(`Load sample ${guide.label} jobs`, [guide.id]));
      card.appendChild(actions);
      const back = el("a", "tile-link", "← Back to the full tour");
      back.href = "#";
      card.appendChild(back);
    }
  });
  return steps;
}

// ---------- Stepper engine ----------

let steps = [];
let index = 0;
let mode = { type: "main" };

function readMode() {
  const match = /site=([a-z0-9-]+)/i.exec(location.hash || "");
  const guide = match ? guides.find((candidate) => candidate.id === match[1]) : null;
  return guide ? { type: "site", guide } : { type: "main" };
}

function render() {
  const step = steps[index];
  ui.kicker.textContent = step.kicker;
  ui.progressText.textContent = `Step ${index + 1} of ${steps.length}`;
  ui.card.replaceChildren();
  ui.card.appendChild(el("h1", "tour-title", step.title));
  const body = el("div", "tour-body");
  step.render(body);
  ui.card.appendChild(body);

  ui.dots.replaceChildren();
  steps.forEach((_step, dotIndex) => {
    const dot = el("li", dotIndex === index ? "is-current" : (dotIndex < index ? "is-done" : ""));
    const button = el("button", "dot-button");
    button.type = "button";
    button.setAttribute("aria-label", `Go to step ${dotIndex + 1}`);
    if (dotIndex === index) button.setAttribute("aria-current", "step");
    button.addEventListener("click", () => go(dotIndex));
    dot.appendChild(button);
    ui.dots.appendChild(dot);
  });

  ui.back.disabled = index === 0;
  const last = index === steps.length - 1;
  ui.next.textContent = last ? "Finish" : "Next";
  ui.skip.textContent = mode.type === "site" ? "Close guide" : "Skip tour";
  ui.card.focus({ preventScroll: true });
}

function go(newIndex) {
  index = Math.max(0, Math.min(steps.length - 1, newIndex));
  setStatus("");
  render();
}

async function finish() {
  try {
    if (mode.type === "site") {
      await markSiteGuideSeen(mode.guide.id);
    } else {
      await chrome.storage.local.set({ "onboarding.completed": true });
    }
  } catch (_error) {
    // Ignore: finishing the tour must never fail visibly.
  }
  const siteGuides = mode.type === "site" ? [mode.guide] : guides;
  ui.card.replaceChildren();
  ui.card.appendChild(el("h1", "tour-title", "You're all set"));
  const body = el("div", "tour-body");
  body.appendChild(el("p", "lead",
    "Open a job search on any supported site, click the Job Extensions icon, and press Start. You can close this tab."));
  const actions = el("div", "tour-actions");
  for (const guide of siteGuides) actions.appendChild(openSiteButton(guide));
  body.appendChild(actions);
  ui.card.appendChild(body);
  ui.dots.replaceChildren();
  ui.progressText.textContent = "Tour complete";
  ui.kicker.textContent = "Done";
  ui.back.disabled = false;
  ui.next.hidden = true;
  ui.back.textContent = "Restart tour";
  ui.back.onclick = () => {
    ui.back.onclick = null;
    ui.back.textContent = "Back";
    ui.next.hidden = false;
    go(0);
  };
  if (mode.type === "site") {
    // Opened from the popup just for this guide: close it (Chrome may ignore this; the card stays).
    window.close();
  }
}

function start() {
  mode = readMode();
  steps = mode.type === "site" ? siteTourSteps(mode.guide) : mainTourSteps();
  index = 0;
  ui.next.hidden = false;
  ui.back.textContent = "Back";
  ui.back.onclick = null;
  if (mode.type === "site") {
    document.title = `${mode.guide.label} guide · Job Extensions`;
    void markSiteGuideSeen(mode.guide.id);
  }
  render();
}

ui.back.addEventListener("click", () => {
  if (!ui.next.hidden) go(index - 1);
});
ui.next.addEventListener("click", () => {
  if (index === steps.length - 1) {
    void finish();
  } else {
    go(index + 1);
  }
});
ui.skip.addEventListener("click", () => {
  void finish();
});
document.addEventListener("keydown", (event) => {
  if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  if (ui.next.hidden) return;
  if (event.key === "ArrowRight") ui.next.click();
  if (event.key === "ArrowLeft" && index > 0) go(index - 1);
});
window.addEventListener("hashchange", start);

ui.card.tabIndex = -1;
start();
