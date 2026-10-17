"use strict";

(() => {
  const source = "job-collector-naukri-api";
  const endpoint = "/jobapi/v3/search";

  function getPageNumber(value) {
    try {
      const url = new URL(value, window.location.href);
      if (
        url.protocol !== "https:"
        || url.hostname !== "www.naukri.com"
        || url.pathname !== endpoint
      ) {
        return null;
      }
      const pageNumber = Number(url.searchParams.get("pageNo") || 1);
      return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
    } catch (_error) {
      return null;
    }
  }

  function publish(value, status, payload) {
    const pageNumber = getPageNumber(value);
    if (!pageNumber) {
      return;
    }
    const jobDetails = payload && Array.isArray(payload.jobDetails)
      ? payload.jobDetails
        .filter((job) => job && typeof job === "object")
        .map((job) => ({
          jobId: job.jobId,
          companyApplyJob: job.companyApplyJob,
          questionnaireIdPresent: job.questionnaireIdPresent,
          applyRedirectUrl: typeof job.applyRedirectUrl === "string"
            ? job.applyRedirectUrl
            : null
        }))
      : null;
    window.postMessage({
      source,
      pageNumber,
      status,
      jobDetails
    }, window.location.origin);
  }

  if (typeof window.fetch === "function") {
    const pageFetch = window.fetch;
    window.fetch = function observeNaukriFetch(...args) {
      const request = args[0];
      const requestUrl = typeof request === "string" || request instanceof URL
        ? String(request)
        : request && request.url;
      const pageNumber = getPageNumber(requestUrl);
      const responsePromise = pageFetch.apply(this, args);
      if (!pageNumber) {
        return responsePromise;
      }
      return responsePromise.then((response) => {
        try {
          response.clone().json().then(
            (payload) => publish(requestUrl, response.status, payload),
            () => publish(requestUrl, response.status, null)
          );
        } catch (_error) {
          publish(requestUrl, response.status, null);
        }
        return response;
      });
    };
  }

  if (typeof window.XMLHttpRequest === "function") {
    const prototype = window.XMLHttpRequest.prototype;
    const pageOpen = prototype.open;
    prototype.open = function observeNaukriXhrOpen(method, url, ...args) {
      this.__jobCollectorNaukriSearchUrl = url;
      return pageOpen.call(this, method, url, ...args);
    };
    const pageSend = prototype.send;
    prototype.send = function observeNaukriXhrSend(...args) {
      const requestUrl = this.__jobCollectorNaukriSearchUrl;
      if (getPageNumber(requestUrl)) {
        this.addEventListener("load", () => {
          let payload = null;
          try {
            payload = typeof this.response === "object" && this.response
              ? this.response
              : JSON.parse(this.responseText);
          } catch (_error) {
            payload = null;
          }
          publish(requestUrl, this.status, payload);
        }, { once: true });
      }
      return pageSend.apply(this, args);
    };
  }
})();
