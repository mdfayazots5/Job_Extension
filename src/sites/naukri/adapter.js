"use strict";

(function initializeNaukriAdapter(global) {
  const selectors = global.JobCollectorNaukriSelectors;
  const config = global.JobCollectorNaukriConfig;

  function parsePostedDate(postedText, capturedAt) {
    const captured = capturedAt instanceof Date ? new Date(capturedAt) : new Date(capturedAt);
    if (Number.isNaN(captured.getTime())) {
      throw new Error("Naukri parsing requires a valid capture timestamp.");
    }

    const value = String(postedText || "").trim();
    if (/^(few hours ago|just now|today)$/i.test(value)) {
      return { date: captured.toISOString(), approximate: false };
    }

    const match = value.match(/^(\d+)(\+?)\s+(hours?|days?|weeks?|months?)\s+ago$/i);
    if (!match) {
      return { date: null, approximate: false };
    }

    const amount = Number(match[1]);
    const unit = match[3].toLowerCase().replace(/s$/, "");
    const estimate = new Date(captured);
    if (unit === "month") {
      const originalDay = estimate.getUTCDate();
      estimate.setUTCDate(1);
      estimate.setUTCMonth(estimate.getUTCMonth() - amount);
      const lastDay = new Date(Date.UTC(
        estimate.getUTCFullYear(),
        estimate.getUTCMonth() + 1,
        0
      )).getUTCDate();
      estimate.setUTCDate(Math.min(originalDay, lastDay));
    } else {
      const unitMs = unit === "hour"
        ? 60 * 60 * 1000
        : unit === "day"
          ? 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
      estimate.setTime(estimate.getTime() - amount * unitMs);
    }

    return {
      date: estimate.toISOString(),
      approximate: match[2] === "+"
    };
  }

  function cleanJobUrl(href) {
    if (!href) {
      return null;
    }
    try {
      const url = new URL(href, "https://www.naukri.com");
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }
      url.search = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function cleanApplyRedirectUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    try {
      const url = new URL(value.trim(), "https://www.naukri.com");
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function cleanLogoSource(src) {
    const value = String(src || "").trim();
    if (!value || /^data:/i.test(value)) {
      return null;
    }
    let path = value.toLowerCase();
    try {
      path = new URL(value, "https://www.naukri.com").pathname.toLowerCase();
    } catch (_error) {
      path = value.toLowerCase();
    }
    return /(?:placeholder|no[-_]?logo|default[-_]?logo|dummy)/i.test(path)
      ? null
      : value;
  }

  function splitLocation(locationRaw) {
    const match = locationRaw.match(/^(Hybrid|Remote|Work from office)\s*-\s*(.*)$/i);
    const workMode = match
      ? match[1].toLowerCase() === "hybrid"
        ? "Hybrid"
        : match[1].toLowerCase() === "remote"
          ? "Remote"
          : "Work from office"
      : null;
    const locationList = (match ? match[2] : locationRaw)
      .split(",")
      .map((location) => location.trim())
      .filter(Boolean);
    return { workMode, locations: locationList };
  }

  function parseCard(card, capturedAt) {
    const { SELECTORS: s } = selectors;
    const titleElement = selectors.query(card, s.title);
    const postedByText = selectors.text(selectors.query(card, s.postedBy));
    const postedBy = postedByText.replace(/^Posted by\s*/i, "").trim() || null;
    const salaryText = selectors.text(selectors.query(card, s.salary));
    const locationRaw = selectors.getLocationRaw(card);
    const postedText = selectors.text(selectors.query(card, s.postedText));
    const posted = parsePostedDate(postedText, capturedAt);
    const walkIn = Boolean(selectors.query(card, s.walkIn));
    const location = splitLocation(locationRaw);
    const logo = selectors.query(card, s.logo);

    return {
      siteId: "naukri",
      jobId: String(card.getAttribute("data-job-id") || "").trim(),
      title: selectors.text(titleElement) || null,
      url: cleanJobUrl(titleElement && titleElement.getAttribute("href")),
      company: selectors.text(selectors.query(card, s.company)) || null,
      postedBy,
      logo: cleanLogoSource(logo && logo.getAttribute("src")),
      experience: selectors.text(selectors.query(card, s.experience)) || null,
      salary: /^not disclosed$/i.test(salaryText) ? null : salaryText || null,
      locationRaw: locationRaw || null,
      workMode: location.workMode,
      locations: location.locations,
      skills: selectors.queryAll(card, s.skills)
        .map((skill) => selectors.text(skill))
        .filter(Boolean),
      walkIn,
      walkInDates: walkIn
        ? selectors.text(selectors.query(card, s.walkInDates)) || null
        : null,
      postedText: postedText || null,
      postedDateEstimate: posted.date,
      postedApprox: posted.approximate,
      postedType: "Posted",
      applyType: "Naukri",
      companyApplyJob: typeof card.getAttribute("data-company-apply-job") === "string"
        ? card.getAttribute("data-company-apply-job") === "true"
        : null,
      questionnaireIdPresent: typeof card.getAttribute("data-questionnaire-id-present") === "string"
        ? card.getAttribute("data-questionnaire-id-present") === "true"
        : null,
      applyRedirectUrl: null
    };
  }

  function parsePage(ctx) {
    const doc = ctx && (ctx.doc || ctx.document);
    if (!doc || typeof doc.querySelectorAll !== "function") {
      throw new Error("Naukri parsing requires a document in ctx.doc or ctx.document.");
    }
    const capturedAt = ctx.capturedAt || new Date();
    const records = [];
    for (const card of selectors.getJobCards(doc)) {
      try {
        records.push(parseCard(card, capturedAt));
      } catch (error) {
        if (typeof ctx.onCardError === "function") {
          ctx.onCardError({
            jobId: card.getAttribute("data-job-id"),
            selector: selectors.SELECTORS.cards,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    return records;
  }

  async function collectPage(ctx) {
    if (typeof ctx.collectPageWork !== "function") {
      throw new Error("Naukri page collection is not connected to the core runtime.");
    }
    return ctx.collectPageWork(ctx.runId, ctx.pageNumber);
  }

  function parseApplicationDetails(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.jobDetails)) {
      throw new Error("Naukri search API response does not contain a jobDetails list.");
    }
    const applicationTypes = {};
    for (const job of payload.jobDetails) {
      if (!job || typeof job !== "object" || job.jobId === undefined || job.jobId === null) {
        continue;
      }
      const jobId = String(job.jobId).trim();
      if (!/^\d+$/.test(jobId)) {
        continue;
      }
      if (typeof job.companyApplyJob !== "boolean") {
        throw new Error(`Naukri API response is missing the companyApplyJob flag for job ${jobId}.`);
      }
      applicationTypes[jobId] = {
        companyApplyJob: job.companyApplyJob,
        questionnaireIdPresent: typeof job.questionnaireIdPresent === "boolean"
          ? job.questionnaireIdPresent
          : null,
        applyRedirectUrl: cleanApplyRedirectUrl(job.applyRedirectUrl)
      };
    }
    if (Object.keys(applicationTypes).length === 0) {
      throw new Error("Naukri search API response contains no classifiable job records.");
    }
    return applicationTypes;
  }

  function detectBlock(doc, url) {
    const pathname = String(url && url.pathname || "").toLowerCase();
    if (/\/(?:login|mnjuser\/login)(?:\/|$)/.test(pathname)) {
      return "Naukri redirected to a login page.";
    }
    const text = `${doc && doc.title || ""}\n${doc && doc.body && doc.body.innerText || ""}`;
    const blockPatterns = [
      /access denied/i,
      /reference\s*#/i,
      /captcha/i,
      /verify you are human/i,
      /unusual traffic/i
    ];
    const match = blockPatterns.find((pattern) => pattern.test(text));
    return match ? "Naukri access block detected in page content." : null;
  }

  function getCurrentPage(doc, url) {
    const selectedPage = selectors.getSelectedPage(doc);
    if (selectedPage !== null) {
      return selectedPage;
    }
    const pathMatch = String(url && url.pathname || "").match(/-(\d+)\/?$/);
    if (pathMatch) {
      return Number(pathMatch[1]);
    }
    const queryPage = Number(url && url.searchParams && url.searchParams.get("pageNo"));
    return Number.isInteger(queryPage) && queryPage > 0 ? queryPage : 1;
  }

  async function goNextPage(ctx) {
    const next = selectors.getNextPageLink(ctx.doc);
    if (!next) {
      return "none";
    }
    if (typeof ctx.prepareNavigation !== "function") {
      throw new Error("Naukri pagination requires persisted navigation state.");
    }
    await ctx.prepareNavigation(ctx.pageNumber + 1);
    if (typeof ctx.logFlow === "function") {
      await ctx.logFlow("pagination-click", {
        pageNumber: ctx.pageNumber,
        nextPage: ctx.pageNumber + 1,
        controlText: selectors.text(next),
        targetPath: new URL(next.getAttribute("href") || ctx.url.href, ctx.url).pathname
      });
    }
    next.click();
    if (typeof ctx.logFlow === "function") {
      await ctx.logFlow("pagination-clicked", {
        pageNumber: ctx.pageNumber,
        nextPage: ctx.pageNumber + 1
      });
    }
    return "navigated";
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Naukri returned an invalid job record.");
    }
    const jobId = String(raw.jobId || "").trim();
    if (!jobId) {
      throw new Error("Naukri returned a job record without an ID.");
    }
    const normalized = { ...raw, siteId: "naukri", jobId };
    normalized.applyRedirectUrl = cleanApplyRedirectUrl(raw.applyRedirectUrl);
    if (normalized.companyApplyJob === true) {
      normalized.applyType = "Company Apply";
    } else if (normalized.questionnaireIdPresent === false) {
      normalized.applyType = "Direct Apply";
    } else if (normalized.questionnaireIdPresent === true) {
      normalized.applyType = "Easy Apply";
    } else if (typeof normalized.companyApplyJob === "boolean") {
      normalized.applyType = "Easy Apply";
    }
    return normalized;
  }

  function shouldSkipRole(record, skipTitles = []) {
    const title = String(record && record.title || "").trim().toLocaleLowerCase();
    return title !== "" && Array.isArray(skipTitles) && skipTitles.some((skipTitle) => (
      typeof skipTitle === "string"
      && skipTitle.trim() !== ""
      && skipTitle.trim().toLocaleLowerCase() === title
    ));
  }

  global.JobCollectorNaukriAdapter = Object.freeze({
    id: "naukri",
    label: "Naukri",
    matchesUrl(url) {
      return url.protocol === "https:"
        && url.hostname === "www.naukri.com"
        && url.pathname.includes("-jobs");
    },
    detectBlock(doc, url) {
      return detectBlock(doc, url);
    },
    getCurrentPage(doc, url) {
      return getCurrentPage(doc, url);
    },
    collectPage,
    parsePage,
    hasNextPage(doc) {
      return Boolean(selectors.getNextPageLink(doc));
    },
    goNextPage(ctx) {
      return goNextPage(ctx);
    },
    normalize,
    shouldSkipRole,
    parseApplicationDetails,
    parsePostedDate,
    limits: Object.freeze({
      maxPages: config.maxPages,
      maxJobsPerRun: config.maxJobsPerRun,
      maxJobsPerDay: config.maxJobsPerDay
    }),
    ui: Object.freeze({
      tabs: Object.freeze([
        Object.freeze({ id: "Easy Apply", label: "Easy Apply" }),
        Object.freeze({ id: "Direct Apply", label: "Direct Apply" }),
        Object.freeze({ id: "Company Apply", label: "Company Apply" })
      ]),
      columns: Object.freeze([
        Object.freeze({ id: "number", label: "#" }),
        Object.freeze({ id: "role", label: "Role", sortable: true }),
        Object.freeze({ id: "company", label: "Company", sortable: true }),
        Object.freeze({ id: "location", label: "Location" }),
        Object.freeze({ id: "experience", label: "Exp" }),
        Object.freeze({ id: "salary", label: "Salary" }),
        Object.freeze({ id: "posted", label: "Posted", sortable: true }),
        Object.freeze({ id: "apply", label: "Apply" })
      ]),
      applyUrl(record) {
        if (
          record.companyApplyJob === true
          || record.applyType === "Company Apply"
        ) {
          return cleanApplyRedirectUrl(record.applyRedirectUrl) || record.url;
        }
        return record.url;
      },
      accent: "#275DF5",
      tabFor(record) {
        if (record.companyApplyJob === true || record.applyType === "Company Apply") {
          return "Company Apply";
        }
        if (typeof record.questionnaireIdPresent === "boolean") {
          return record.questionnaireIdPresent ? "Easy Apply" : "Direct Apply";
        }
        return record.applyType === "Direct Apply" ? "Direct Apply" : "Easy Apply";
      }
    })
  });
})(globalThis);
