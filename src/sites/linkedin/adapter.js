"use strict";

(function initializeLinkedInAdapter(global) {
  const selectors = global.JobCollectorSelectors;
  const metadata = global.JobCollectorMetadata;
  const config = global.JobCollectorConfig;

  function matchesUrl(url) {
    return url.protocol === "https:"
      && url.hostname === "www.linkedin.com"
      && /^\/jobs\/search-results(?:\/|$)/.test(url.pathname);
  }

  function detectBlock(doc, url, errors = []) {
    return selectors.detectBlockingPage(doc, url, errors);
  }

  function normalizeUrl(value) {
    const url = new URL(value);
    if (!matchesUrl(url)) {
      throw new Error("The saved search URL is not a LinkedIn jobs search-results URL.");
    }
    url.searchParams.delete("currentJobId");
    url.searchParams.delete("eBP");
    url.searchParams.delete("refId");
    url.hash = "";
    return url.href;
  }

  function getCurrentPage(doc, _url, errors = []) {
    return selectors.getCurrentPageNumber(doc, errors);
  }

  function getNextPageControl(doc, page, errors = []) {
    return selectors.getNextPageControl(doc, page, errors);
  }

  function hasNextPage(doc, page, errors = []) {
    return Boolean(getNextPageControl(doc, page, errors));
  }

  async function collectPage(ctx) {
    if (typeof ctx.collectPageWork !== "function") {
      throw new Error("LinkedIn page collection is not connected to the core runtime.");
    }
    return ctx.collectPageWork(ctx.runId, ctx.pageNumber);
  }

  async function goNextPage(ctx) {
    if (typeof ctx.goNextLinkedInPage !== "function") {
      throw new Error("LinkedIn pagination is not connected to the core runtime.");
    }
    const result = await ctx.goNextLinkedInPage(
      ctx.runId,
      ctx.pageNumber,
      ctx.container
    );
    if (!result) {
      return "none";
    }
    ctx.setNextPage(result.pageNumber, result.container);
    return "inplace";
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.jobId !== "string") {
      throw new Error("LinkedIn returned an invalid job record.");
    }
    return {
      ...raw,
      siteId: "linkedin",
      jobId: raw.jobId,
      url: `https://www.linkedin.com/jobs/view/${raw.jobId}/`
    };
  }

  global.JobCollectorLinkedInAdapter = Object.freeze({
    id: "linkedin",
    label: "LinkedIn",
    matchesUrl,
    detectBlock,
    normalizeUrl,
    getCurrentPage,
    getNextPageControl,
    collectPage,
    hasNextPage,
    goNextPage,
    normalize,
    limits: Object.freeze({
      maxPages: config.maxPages,
      maxJobsPerRun: config.maxJobsPerRun,
      maxJobsPerDay: config.maxJobsPerDay
    }),
    ui: Object.freeze({
      tabs: Object.freeze([
        Object.freeze({ id: "Easy Apply", label: "Easy Apply" }),
        Object.freeze({ id: "Company Site", label: "Company Apply" })
      ]),
      columns: Object.freeze([
        Object.freeze({ id: "number", label: "#" }),
        Object.freeze({ id: "role", label: "Role", sortable: true }),
        Object.freeze({ id: "company", label: "Company", sortable: true }),
        Object.freeze({ id: "location", label: "Location" }),
        Object.freeze({ id: "posted", label: "Posted", sortable: true }),
        Object.freeze({ id: "apply", label: "Apply" })
      ]),
      applyUrl(record) {
        if (record.applyType === "Company Site" && record.companyApplyUrl) {
          try {
            const external = new URL(record.companyApplyUrl);
            if (external.protocol === "https:" || external.protocol === "http:") {
              return external.href;
            }
          } catch (_error) {
            return `https://www.linkedin.com/jobs/view/${record.jobId}/`;
          }
        }
        return `https://www.linkedin.com/jobs/view/${record.jobId}/`;
      },
      accent: "#0a66c2"
    }),
    normalizeMetadata: metadata.parseDetailMeta
  });
})(globalThis);
