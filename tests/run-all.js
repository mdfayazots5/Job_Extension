"use strict";

// Runs every tests/*.test.js in its own Node process (they set process.exitCode independently).
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const files = fs.readdirSync(__dirname).filter((name) => name.endsWith(".test.js")).sort();
const failed = [];
for (const name of files) {
  const result = spawnSync(process.execPath, [path.join("tests", name)], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8"
  });
  const ok = result.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) {
    failed.push(name);
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
  }
}
console.log(`\n${files.length - failed.length}/${files.length} test files passed.`);
process.exitCode = failed.length ? 1 : 0;
