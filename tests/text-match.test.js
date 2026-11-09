"use strict";

// The shared search/skip rule must work for ANY term the way a user types it,
// with no term-specific special cases.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(fs.readFileSync("src/core/text-match.js", "utf8"), context, {
  filename: "src/core/text-match.js"
});
const T = context.JobCollectorTextMatch;

const whole = (text, query) => T.matchesText(text, query);
const partial = (text, query) => T.matchesText(text, query, { partialWords: true });

// Case and accents.
assert.ok(whole("Senior ENGINEER", "senior engineer"));
assert.ok(whole("Café Manager", "cafe"));

// Spacing, hyphens and punctuation are ignored, for any word.
for (const [text, query] of [
  ["Front-End Engineer", "frontend"],
  ["Frontend Engineer", "front end"],
  ["Full Stack Developer", "full-stack"],
  ["Node.js Developer", "nodejs"],
  ["NodeJS Developer", "node.js"],
  ["Sr. Engineer", "sr engineer"],
  ["R&D <Systems>", "R&D <Systems>"],
  ["Senior & Staff Engineer", "Senior & Staff"]
]) {
  assert.ok(whole(text, query), `"${query}" should find "${text}"`);
}

// Symbols match their spoken names, for any symbol-word (not a list of known terms).
for (const [text, query] of [
  [".NET Developer", "dotnet"],
  ["Dot Net Developer", ".net"],
  ["dotnet engineer", "dot net"],
  ["ASP.NET MVC", ".net"],
  ["C# Developer", "csharp"],
  ["C Sharp Developer", "c#"],
  ["C++ Engineer", "c plus plus"],
  ["F# Analyst", "f sharp"]
]) {
  assert.ok(whole(text, query), `"${query}" should find "${text}"`);
}
assert.equal(whole("Objective-C Developer", "c#"), false, "c# must not match plain C");

// Complete words are precise; partial words match word starts.
assert.equal(whole("JavaScript Developer", "java"), false);
assert.ok(whole("Java Developer", "JAVA"));
assert.equal(whole("Network Engineer", "net"), false);
assert.ok(partial("Docker Engineer", "do"));
assert.ok(partial("Angular Developer", "angu"));
assert.ok(partial("Dot Net Developer", "dot ne"));
assert.equal(partial("JavaScript Developer", "script"), false, "partial matches start at a word");

// Lists of fields.
assert.ok(T.matchesAny(["C++ <x>", "Systems & Design"], "systems design"));

// Skip Title equality ignores formatting but keeps different words distinct.
assert.equal(T.titleKey("Sr. .NET Developer"), T.titleKey("SR  dot-net developer"));
assert.equal(T.titleKey("Front-End Engineer"), T.titleKey("frontend engineer"));
assert.notEqual(T.titleKey("C# Developer"), T.titleKey("C Developer"));

// The site adapters use the same rule for Skip Title.
const adapterContext = vm.createContext({ URL, Date });
for (const file of [
  "src/core/text-match.js",
  "src/sites/naukri/config.js",
  "src/sites/naukri/selectors.js",
  "src/sites/naukri/adapter.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), adapterContext, { filename: file });
}
const naukri = adapterContext.JobCollectorNaukriAdapter;
assert.equal(naukri.shouldSkipRole({ title: "Sr. Front-End Engineer" }, ["sr frontend engineer"]), true);
assert.equal(naukri.shouldSkipRole({ title: "Senior Engineer" }, ["Senior Engineer II"]), false);
// The user's real skip list, as a "contains" match.
const userSkips = ["Apriso MES Developer", "Presales Consultant", "365 Developer", "Java AWS Developer", "Test Engineer", "Test Architect"];
for (const title of [
  "Senior Test Engineer - Automation",
  "Lead TEST ENGINEER (Selenium)",
  "Dynamics 365 Developer",
  "Microsoft 365 Developer II",
  "Sr. Java/AWS Developer",
  "Presales Consultant - Cloud",
  "Apriso MES Developer"
]) {
  assert.equal(naukri.shouldSkipRole({ title }, userSkips), true, `"${title}" should be skipped`);
}
for (const title of ["Test Automation Lead", "JavaScript Developer", "Java Developer", "Testing Engineer", "Solution Architect"]) {
  assert.equal(naukri.shouldSkipRole({ title }, userSkips), false, `"${title}" should be kept`);
}
assert.equal(T.findContainedPhrase("Senior Test Engineer", userSkips), "Test Engineer");
assert.equal(naukri.shouldSkipRole({ title: "Anything" }, ["", "  ", "&&"]), false, "blank phrases never skip");

console.log("Text match tests passed: case, punctuation, spoken symbols, whole/partial words, skip titles.");
