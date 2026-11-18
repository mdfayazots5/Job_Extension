"use strict";

// The extension is shared as a plain "Load unpacked" folder. Most users will never install the
// optional native backup host, so everything must keep working when Chrome reports it missing.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");

function eventHook() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { for (const listener of listeners) { listener(...args); } }
  };
}

async function testNativeBackupModuleOffline() {
  const store = { records: {} };
  let nativeCalls = 0;
  const chrome = {
    runtime: {
      async sendNativeMessage() {
        nativeCalls += 1;
        throw new Error("Specified native messaging host not found.");
      }
    },
    storage: {
      local: {
        async get() { return {}; },
        async set(updates) { Object.assign(store, updates); }
      }
    }
  };
  const context = vm.createContext({ chrome, Date, console });
  for (const file of ["src/core/storage.js", "src/core/native-backup.js"]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  const backup = context.JobCollectorNativeBackup;
  const result = await backup.restoreArchive();
  assert.equal(result.skipped, "host-unavailable");
  assert.equal(backup.getHostAvailability(), "unavailable");
  const callsAfterProbe = nativeCalls;
  await backup.upsertRecord("linkedin", { jobId: "1", url: "https://www.linkedin.com/jobs/view/1/" });
  await backup.upsertSetting("ui.lastSite", "naukri");
  await backup.updateJobStatus("naukri", "abc", "opened", true);
  assert.equal(await backup.getJobStatuses("indeed"), null);
  assert.equal(nativeCalls, callsAfterProbe, "A missing host is probed once, then skipped.");

  // A host that is installed but failing is a real error and must still surface.
  const failingContext = vm.createContext({
    chrome: {
      runtime: { async sendNativeMessage() { throw new Error("Native host has exited."); } },
      storage: chrome.storage
    },
    Date,
    console
  });
  for (const file of ["src/core/storage.js", "src/core/native-backup.js"]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), failingContext, { filename: file });
  }
  await assert.rejects(failingContext.JobCollectorNativeBackup.restoreArchive(), /Native host has exited/);
}

async function testBackgroundOffline() {
  const store = {};
  const storageChanged = eventHook();
  const createdTabs = [];
  const onInstalled = eventHook();
  const chrome = {
    runtime: {
      id: "collector-test",
      async sendNativeMessage() {
        throw new Error("Specified native messaging host not found.");
      },
      onMessage: eventHook(),
      onInstalled,
      onStartup: eventHook(),
      getURL(path) { return `chrome-extension://collector-test/${path}`; }
    },
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list
            .filter((key) => Object.prototype.hasOwnProperty.call(store, key))
            .map((key) => [key, store[key]]));
        },
        async set(updates) {
          const changes = {};
          for (const [key, value] of Object.entries(updates)) {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = value;
          }
          storageChanged.emit(changes, "local");
        },
        async remove(key) { delete store[key]; }
      },
      onChanged: storageChanged
    },
    tabs: {
      onRemoved: eventHook(),
      onUpdated: eventHook(),
      async query() { return []; },
      async sendMessage() { return { ok: true }; },
      async create(options) { createdTabs.push(options); return { id: 900, ...options }; },
      async update() { return {}; }
    },
    alarms: { onAlarm: eventHook(), async create() {}, async clear() { return true; } },
    scripting: { async executeScript() {} }
  };
  const context = vm.createContext({
    chrome,
    crypto: crypto.webcrypto,
    URL,
    importScripts(...paths) {
      for (const path of paths) {
        vm.runInContext(fs.readFileSync(path, "utf8"), context, { filename: path });
      }
    },
    console
  });
  vm.runInContext(fs.readFileSync("background.js", "utf8"), context, { filename: "background.js" });
  await vm.runInContext("initializeStorage()", context);
  assert.equal(store["nativeHost.status"], "not-installed");
  assert.ok(store["runs.linkedin"], "LinkedIn run state is initialized without the host.");

  store["opened.linkedin"] = { "7": true };
  store["hidden.linkedin"] = { "8": true };
  const response = await vm.runInContext(
    `synchronizeJobStatuses({ siteId: "linkedin", update: { jobId: "9", hidden: true } })`,
    context
  );
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(store["opened.linkedin"])), { "7": true });
  assert.deepEqual(JSON.parse(JSON.stringify(store["hidden.linkedin"])), { "8": true, "9": true });

  onInstalled.emit({ reason: "install" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    createdTabs.some((tab) => tab.url === "chrome-extension://collector-test/onboarding/welcome.html"),
    "A fresh install opens the welcome tour."
  );
  const tabsBeforeUpdate = createdTabs.length;
  onInstalled.emit({ reason: "update", previousVersion: "0.5.0" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(createdTabs.length, tabsBeforeUpdate, "Updates do not reopen the tour.");
}

(async () => {
  await testNativeBackupModuleOffline();
  await testBackgroundOffline();
  console.log("offline-host tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
