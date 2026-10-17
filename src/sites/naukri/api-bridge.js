"use strict";

(() => {
  const source = "job-collector-naukri-api";
  const responses = globalThis.JobCollectorNaukriApiResponses || Object.create(null);
  globalThis.JobCollectorNaukriApiResponses = responses;

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (
      event.source !== window
      || event.origin !== window.location.origin
      || !message
      || message.source !== source
      || !Number.isInteger(message.pageNumber)
      || message.pageNumber < 1
      || !Number.isInteger(message.status)
    ) {
      return;
    }
    responses[message.pageNumber] = {
      status: message.status,
      jobDetails: Array.isArray(message.jobDetails) ? message.jobDetails : null
    };
  });
})();
