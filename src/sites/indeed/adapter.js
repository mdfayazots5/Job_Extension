"use strict";

(function initializeIndeedAdapter(global) {
  const parser = global.JobCollectorIndeedParser;
  const selectors = global.JobCollectorIndeedSelectors;
  const config = global.JobCollectorIndeedConfig;

  function matchesUrl(url) {
    return Boolean(
      url
      && url.protocol === "https:"
      && url.hostname === "in.indeed.com"
      && url.pathname === "/jobs"
      && typeof url.searchParams.get("q") === "string"
      && url.searchParams.get("q").trim()
    );
  }

  function detectBlock(doc, url) {
    const pathname = String(url && url.pathname || "").toLowerCase();
    const hostname = String(url && url.hostname || "").toLowerCase();
    if (
      /\/(?:account\/)?login(?:\/|$)/.test(pathname)
      || /\/signin(?:\/|$)/.test(pathname)
      || /\/auth(?:\/|$)/.test(pathname)
      || (hostname.endsWith(".indeed.com") && hostname !== "in.indeed.com")
    ) {
      return "Indeed redirected to a login page.";
    }
    const pageText = `${doc && doc.title || ""}\n${doc && doc.body && (doc.body.innerText || doc.body.textContent) || ""}\n${url && `${url.href} ${url.pathname}` || ""}`;
    if (/just a moment|verify you are human|cf-challenge|additional verification required|access denied/i.test(pageText)) {
      return "Indeed access block detected in page content.";
    }
    return null;
  }

  function getCurrentPage(doc, url) {
    const selectedPage = selectors.getCurrentPage(doc);
    if (selectedPage !== null) {
      return selectedPage;
    }
    if (!url || !url.searchParams) {
      return 1;
    }
    const start = Number(url.searchParams.get("start") || 0);
    if (Number.isFinite(start) && start >= 0) {
      return Math.floor(start / 10) + 1;
    }
    const page = Number(url.searchParams.get("page"));
    return Number.isInteger(page) && page > 0 ? page : 1;
  }

  async function collectPage(ctx) {
    if (typeof ctx.collectPageWork !== "function") {
      throw new Error("Indeed page collection is not connected to the core runtime.");
    }
    return ctx.collectPageWork(ctx.runId, ctx.pageNumber);
  }

  function hasNextPage(doc) {
    return Boolean(selectors.getNextPageLink(doc));
  }

  async function goNextPage(ctx) {
    const next = selectors.getNextPageLink(ctx.doc);
    if (!next) {
      return "none";
    }
    const target = new URL(next.getAttribute("href"), ctx.url);
    if (!matchesUrl(target) || target.searchParams.get("q") !== ctx.url.searchParams.get("q")) {
      throw new Error("Indeed next-page control does not preserve the active /jobs search.");
    }
    if (typeof ctx.prepareNavigation !== "function") {
      throw new Error("Indeed pagination requires persisted navigation state.");
    }
    await ctx.prepareNavigation(ctx.pageNumber + 1);
    next.click();
    return "navigated";
  }

  function getOrigin() {
    const origin = global.location && global.location.origin;
    return origin === "https://in.indeed.com" ? origin : "https://in.indeed.com";
  }

  function getCanonicalJobUrl(jobId) {
    return `${getOrigin()}/viewjob?jk=${encodeURIComponent(jobId)}`;
  }

  function getPostedDateEstimate(raw, postedApprox) {
    if (postedApprox) {
      return null;
    }
    const captureTimestamp = typeof raw.capturedAt === "string"
      ? Date.parse(raw.capturedAt)
      : NaN;
    if (Number.isFinite(captureTimestamp)) {
      if (/^(?:just posted|today)$/i.test(String(raw.postedText || "").trim())) {
        return new Date(captureTimestamp).toISOString();
      }
      const daysAgo = String(raw.postedText || "").trim().match(/^(\d+)\s+days?\s+ago$/i);
      if (daysAgo) {
        return new Date(captureTimestamp - Number(daysAgo[1]) * 24 * 60 * 60 * 1000).toISOString();
      }
    }
    if (raw.pubDate === null || raw.pubDate === undefined) {
      return null;
    }
    let timestamp = typeof raw.pubDate === "number" || /^\d+$/.test(String(raw.pubDate))
      ? Number(raw.pubDate)
      : Date.parse(raw.pubDate);
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < 1e11) {
      timestamp *= 1000;
    }
    if (!Number.isFinite(timestamp)) {
      return null;
    }
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Indeed returned an invalid job record.");
    }
    const jobId = String(raw.jobId || "").trim();
    if (!parser.isUsableJobId(jobId)) {
      throw new Error("Indeed returned a job record with an invalid job ID.");
    }

    const postedText = typeof raw.postedText === "string" && raw.postedText.trim()
      ? raw.postedText.trim()
      : null;
    const postedApprox = Boolean(postedText && /^30\+/i.test(postedText));
    const remote = /remote/i.test(String(raw.location || ""))
      || /remote/i.test(String(raw.remoteWorkText || ""));
    const easyApply = raw.easyApplyBadge === true || raw.indeedApplyEnabled === true;
    const sponsored = raw.sponsored === true;
    const postedDateEstimate = getPostedDateEstimate(raw, postedApprox);
    const hasPostedDate = postedDateEstimate !== null;

    return {
      ...raw,
      siteId: "indeed",
      jobId,
      url: getCanonicalJobUrl(jobId),
      applyType: easyApply ? "Easy Apply" : "Company Site",
      postedType: sponsored ? "Unknown" : raw.postedType || "Unknown",
      postedText: sponsored
        ? null
        : postedText || (hasPostedDate ? null : "Date unavailable"),
      postedApprox: !sponsored && postedApprox,
      postedDateEstimate,
      firstSeenAt: sponsored
        ? null
        : raw.firstSeenAt || raw.capturedAt || null,
      workMode: remote ? "Remote" : null
    };
  }

  function getSkipReason(record) {
    if (!record || typeof record !== "object") {
      return null;
    }
    const applied = record.applied === true;
    const expired = record.expired === true;
    return applied || expired ? { applied, expired } : null;
  }

  global.JobCollectorIndeedAdapter = Object.freeze({
    id: "indeed",
    label: "Indeed",
    matchesUrl,
    detectBlock,
    getCurrentPage,
    collectPage,
    hasNextPage,
    goNextPage,
    normalize,
    getSkipReason,
    limits: Object.freeze({
      maxPages: config.maxPages,
      maxJobsPerRun: config.maxJobsPerRun,
      maxJobsPerDay: config.maxJobsPerDay,
      maxRunsPerDay: config.maxRunsPerDay
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
        Object.freeze({ id: "location", label: "Location", sortable: true }),
        Object.freeze({ id: "salary", label: "Salary", sortable: true }),
        Object.freeze({ id: "type", label: "Type", sortable: true }),
        Object.freeze({ id: "posted", label: "Posted", sortable: true }),
        Object.freeze({ id: "apply", label: "Apply" })
      ]),
      applyUrl(record) {
        if (!record || !parser.isUsableJobId(String(record.jobId || ""))) {
          return null;
        }
        const expectedUrl = getCanonicalJobUrl(String(record.jobId));
        return record.url === expectedUrl ? expectedUrl : null;
      },
      accent: "#2164f3"
    })
  });
})(globalThis);
