"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const listeners = new Map();
const location = {
  href: "https://www.naukri.com/sample-jobs",
  origin: "https://www.naukri.com"
};
let nextStatus = 200;
const window = {
  location,
  fetch: async () => ({
    status: nextStatus,
    clone() {
      return {
        async json() {
          if (nextStatus === 406) {
            return { message: "recaptcha required" };
          }
          return {
            jobDetails: [
              {
                jobId: "123",
                companyApplyJob: true,
                questionnaireIdPresent: false,
                applyRedirectUrl: "https://company.example/apply?id=123",
                title: "must not cross the bridge"
              },
              { jobId: "456", companyApplyJob: false, questionnaireIdPresent: true }
            ]
          };
        }
      };
    }
  }),
  postMessage(data, targetOrigin) {
    const listener = listeners.get("message");
    if (listener) {
      listener({
        data,
        origin: location.origin,
        source: window,
        targetOrigin
      });
    }
  },
  addEventListener(type, listener) {
    listeners.set(type, listener);
  }
};
const context = vm.createContext({
  URL,
  window,
  globalThis: null
});
context.globalThis = context;

for (const file of [
  "src/sites/naukri/api-bridge.js",
  "src/sites/naukri/api-observer.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

async function run() {
  const result = await window.fetch(
    "https://www.naukri.com/jobapi/v3/search?pageNo=2"
  );
  assert.equal(result.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.JobCollectorNaukriApiResponses[2])),
    {
      status: 200,
      jobDetails: [
        {
          jobId: "123",
          companyApplyJob: true,
          questionnaireIdPresent: false,
          applyRedirectUrl: "https://company.example/apply?id=123"
        },
        {
          jobId: "456",
          companyApplyJob: false,
          questionnaireIdPresent: true,
          applyRedirectUrl: null
        }
      ]
    }
  );

  nextStatus = 406;
  await window.fetch("https://www.naukri.com/jobapi/v3/search?pageNo=1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.JobCollectorNaukriApiResponses[1])),
    { status: 406, jobDetails: null }
  );
  console.log("Naukri API observer tests passed: captures same-page flags and status without forwarding other response data.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
