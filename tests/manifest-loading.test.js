"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
assert.equal(manifest.name, "Job Extensions");
assert.equal(manifest.action.default_title, "Job Extensions");
assert.deepEqual(manifest.permissions.sort(), ["alarms", "scripting", "storage", "tabs"]);
assert.deepEqual(manifest.host_permissions.sort(), ["https://in.indeed.com/*", "https://www.linkedin.com/*", "https://www.naukri.com/*"]);
assert.equal(manifest.content_scripts.length, 5);

const linkedin = manifest.content_scripts.find((entry) => entry.matches.includes("https://www.linkedin.com/jobs/*"));
const naukriScripts = manifest.content_scripts.filter((entry) => entry.matches.includes("https://www.naukri.com/*"));
const indeed = manifest.content_scripts.find((entry) => entry.matches.includes("https://in.indeed.com/*"));
assert.ok(linkedin);
assert.ok(indeed);
assert.equal(naukriScripts.length, 3);
assert.equal(linkedin.js.some((file) => file.includes("/naukri/")), false);
assert.equal(naukriScripts.every((entry) => entry.js.some((file) => file.includes("/linkedin/"))), false);
assert.equal(linkedin.js.some((file) => file.includes("/indeed/")), false);
assert.equal(naukriScripts.every((entry) => entry.js.some((file) => file.includes("/indeed/"))), false);
assert.equal(indeed.js.some((file) => file.includes("/linkedin/")), false);
assert.equal(indeed.js.some((file) => file.includes("/naukri/")), false);
assert.equal(naukriScripts.find((entry) => entry.js.includes("src/sites/naukri/api-observer.js")).world, "MAIN");
assert.equal(naukriScripts.find((entry) => entry.js.includes("src/sites/naukri/api-observer.js")).run_at, "document_start");
assert.equal(naukriScripts.find((entry) => entry.js.includes("src/sites/naukri/api-bridge.js")).run_at, "document_start");
console.log("Manifest loading tests passed: minimal permissions and isolated LinkedIn, Naukri, and Indeed scripts.");
