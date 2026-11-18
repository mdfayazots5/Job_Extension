"use strict";

// First-run experience: sample data (seed / clear / auto-replace by real jobs) and the guided tour.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const SITE_SCRIPTS = [
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
  "src/sites/registry.js",
  "src/sites/linkedin/guide.js",
  "src/sites/naukri/guide.js",
  "src/sites/indeed/guide.js",
  "src/core/demo-data.js"
];

function createChrome(store, createdTabs = []) {
  return {
    runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    tabs: { async create(options) { createdTabs.push(options); return options; } },
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => key in store).map((key) => [key, store[key]]));
        },
        async set(updates) { Object.assign(store, JSON.parse(JSON.stringify(updates))); }
      }
    }
  };
}

async function testDemoData() {
  const store = {};
  const context = vm.createContext({
    chrome: createChrome(store),
    URL,
    console,
    window: { location: { href: "chrome-extension://test/onboarding/welcome.html" } },
    location: { origin: "chrome-extension://test" }
  });
  for (const file of SITE_SCRIPTS) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  const demo = context.JobCollectorDemoData;
  const guides = context.JobCollectorSiteGuides;
  assert.deepEqual(Object.keys(guides).sort(), ["indeed", "linkedin", "naukri"]);
  for (const guide of Object.values(guides)) {
    assert.ok(guide.summary && guide.steps.length >= 3 && guide.collects.length >= 3, guide.id);
    assert.ok(context.JobCollectorSiteRegistry.getAdapter(guide.id), `${guide.id} guide has an adapter`);
    assert.match(guide.searchUrl, /^https:\/\//);
  }

  const seeded = await demo.seed();
  assert.equal(seeded, 18);
  assert.equal(demo.countDemo(store.records), 18);
  assert.equal(demo.countDemo(store.records, "naukri"), 6);
  for (const [key, record] of Object.entries(store.records)) {
    assert.equal(record.demo, true);
    assert.ok(key.startsWith(`${record.siteId}:demo-`), key);
  }
  // Every sample lands in a real tab of its site's results page.
  const naukriTabs = Object.values(store.records)
    .filter((record) => record.siteId === "naukri")
    .map((record) => context.JobCollectorNaukriAdapter.ui.tabFor(record));
  assert.ok(naukriTabs.includes("Easy Apply") && naukriTabs.includes("Company Apply"));
  for (const siteId of ["linkedin", "indeed"]) {
    const types = new Set(Object.values(store.records)
      .filter((record) => record.siteId === siteId)
      .map((record) => record.applyType));
    assert.deepEqual([...types].sort(), ["Company Site", "Easy Apply"], siteId);
  }

  // A real save for a site removes that site's samples (and only that site's).
  const storage = context.JobCollectorStorage;
  const linkedinJobs = await storage.getJobs("linkedin");
  linkedinJobs["4000000001"] = { siteId: "linkedin", jobId: "4000000001", title: "Real job", applyType: "Easy Apply" };
  await storage.setJobs("linkedin", linkedinJobs, {}, { backup: false });
  assert.deepEqual(Object.keys(await storage.getJobs("linkedin")), ["4000000001"]);
  assert.equal(demo.countDemo(store.records, "naukri"), 6);

  // Seeding never mixes samples into a site that already has real jobs.
  assert.equal(await demo.seed(["linkedin"]), 0);

  // Clearing removes samples and keeps real jobs.
  assert.equal(await demo.clear(), 12);
  assert.deepEqual(Object.keys(store.records), ["linkedin:4000000001"]);
}

async function testTourPage(hash) {
  const html = fs.readFileSync("onboarding/welcome.html", "utf8")
    .replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { url: `chrome-extension://test/onboarding/welcome.html${hash}`, runScripts: "outside-only" });
  const store = {};
  const createdTabs = [];
  dom.window.chrome = createChrome(store, createdTabs);
  dom.window.close = () => { dom.window.closedByTour = true; };
  const errors = [];
  dom.window.addEventListener("error", (event) => errors.push(event.error));
  for (const file of [...SITE_SCRIPTS, "onboarding/welcome.js"]) {
    dom.window.eval(fs.readFileSync(file, "utf8"));
  }
  const doc = dom.window.document;
  const next = doc.getElementById("tour-next");
  const titles = [];
  for (let guard = 0; guard < 20 && !next.hidden && !dom.window.closedByTour; guard += 1) {
    titles.push(doc.querySelector(".tour-title").textContent);
    const loadSamples = Array.from(doc.querySelectorAll("button")).find((button) => /Load sample/.test(button.textContent));
    if (loadSamples) {
      loadSamples.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(doc.getElementById("tour-status").textContent, /Loaded \d+ sample jobs/);
      assert.ok(createdTabs.some((tab) => /results\.html\?site=/.test(tab.url)));
    }
    next.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(errors, []);
  return { titles, store, dom };
}

(async () => {
  await testDemoData();

  const main = await testTourPage("");
  assert.equal(main.titles.length, 6, `main tour steps: ${main.titles.join(" | ")}`);
  assert.equal(main.store["onboarding.completed"], true);
  assert.match(main.dom.window.document.querySelector(".tour-title").textContent, /all set/);
  assert.equal(main.dom.window.document.querySelectorAll(".site-tile").length, 0, "finish screen replaced the steps");

  const naukri = await testTourPage("#site=naukri");
  assert.match(naukri.titles[0], /Naukri module/);
  assert.equal(naukri.titles.length, 6, "overview + 4 steps + try-it");
  assert.equal(naukri.store["onboarding.site.naukri.seen"], true);
  assert.equal(naukri.dom.window.closedByTour, true);

  console.log("Onboarding tests passed: sample data lifecycle and guided tours (main + per-site).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
