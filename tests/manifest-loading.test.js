"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
assert.deepEqual(manifest.permissions.sort(), ["alarms", "scripting", "storage", "tabs"]);
assert.deepEqual(manifest.host_permissions.sort(), ["https://www.linkedin.com/*", "https://www.naukri.com/*"]);
assert.equal(manifest.content_scripts.length, 2);

const linkedin = manifest.content_scripts.find((entry) => entry.matches.includes("https://www.linkedin.com/jobs/*"));
const naukri = manifest.content_scripts.find((entry) => entry.matches.includes("https://www.naukri.com/*"));
assert.ok(linkedin);
assert.ok(naukri);
assert.equal(linkedin.js.some((file) => file.includes("/naukri/")), false);
assert.equal(naukri.js.some((file) => file.includes("/linkedin/")), false);
assert.equal(linkedin.js.some((file) => file.includes("/indeed/")), false);
assert.equal(naukri.js.some((file) => file.includes("/indeed/")), false);
console.log("Manifest loading tests passed: minimal permissions and isolated site content scripts.");
