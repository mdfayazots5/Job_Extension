"use strict";

(function initializeIndeedParser(global) {
  const selectors = global.JobCollectorIndeedSelectors;
  const JOB_ID_PATTERN = /^[0-9a-f]{16}$/;
  const PLACEHOLDER_JOB_IDS = new Set(["789abcdef0123456"]);
  const JOB_TYPES = new Set([
    "Full-time",
    "Part-time",
    "Contract",
    "Internship",
    "Permanent",
    "Temporary"
  ]);
  const JSON_ASSIGNMENT = /window\.mosaic\.providerData\s*\[\s*["']mosaic-provider-jobcards["']\s*\]\s*=/;

  function isUsableJobId(value) {
    return JOB_ID_PATTERN.test(value) && !PLACEHOLDER_JOB_IDS.has(value);
  }

  function findAssignedObject(source) {
    const assignmentMatch = JSON_ASSIGNMENT.exec(source);
    if (!assignmentMatch) {
      throw new Error("Indeed job-card JSON assignment was not found.");
    }

    let start = assignmentMatch.index + assignmentMatch[0].length;
    while (/\s/.test(source[start] || "")) {
      start += 1;
    }
    if (source[start] !== "{") {
      throw new Error("Indeed job-card JSON assignment is not an object.");
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }
    throw new Error("Indeed job-card JSON object is unterminated.");
  }

  function readJobMetadata(doc) {
    const scripts = doc && doc.scripts ? Array.from(doc.scripts) : [];
    const assignmentScripts = scripts.filter((candidate) => (
      JSON_ASSIGNMENT.test(candidate.textContent || "")
    ));
    if (assignmentScripts.length === 0) {
      return {
        resultsById: new Map(),
        warning: "jsonMissing: Indeed job-card JSON script was not found."
      };
    }

    let parseError = null;
    for (const script of assignmentScripts) {
      try {
        const assignedObject = findAssignedObject(script.textContent || "");
        const payload = JSON.parse(assignedObject);
        const results = payload
          && payload.metaData
          && payload.metaData.mosaicProviderJobCardsModel
          && payload.metaData.mosaicProviderJobCardsModel.results;
        if (!Array.isArray(results)) {
          throw new Error("Indeed job-card JSON results are missing.");
        }
        const resultsById = new Map();
        for (const result of results) {
          if (result && result.jobkey !== undefined && result.jobkey !== null) {
            resultsById.set(String(result.jobkey), result);
          }
        }
        return { resultsById, warning: null };
      } catch (error) {
        parseError = error;
      }
    }
    return {
      resultsById: new Map(),
      warning: `parseError: Indeed job-card JSON could not be parsed: ${parseError.message}`
    };
  }

  function extractJobType(card) {
    for (const item of selectors.queryAll(card, "li")) {
      const value = selectors.text(item);
      if (JOB_TYPES.has(value)) {
        return value;
      }
    }
    return null;
  }

  function parseCard(card, jsonMetadata) {
    const link = selectors.query(card, selectors.SELECTORS.title);
    const jobId = link && String(link.getAttribute("data-jk") || "").trim();
    const titleElement = selectors.query(card, selectors.SELECTORS.titleText);
    const title = titleElement && String(titleElement.getAttribute("title") || "").trim();
    const sponsored = Boolean(link && (link.getAttribute("href") || "").startsWith("/pagead/"));
    if (!jobId || !isUsableJobId(jobId) || !title) {
      return { record: null, reason: "invalidId", sponsored };
    }

    const jsonRecord = jsonMetadata.resultsById.get(jobId) || null;
    const relativeTime = jsonRecord && typeof jsonRecord.formattedRelativeTime === "string"
      && jsonRecord.formattedRelativeTime.trim()
      ? jsonRecord.formattedRelativeTime.trim()
      : null;
    const pubDate = jsonRecord && jsonRecord.pubDate !== undefined
      ? jsonRecord.pubDate
      : null;
    const remoteWorkText = jsonRecord
      && jsonRecord.remoteWorkModel
      && typeof jsonRecord.remoteWorkModel.text === "string"
      ? jsonRecord.remoteWorkModel.text
      : null;
    const readBoolean = (key) => jsonRecord && typeof jsonRecord[key] === "boolean"
      ? jsonRecord[key]
      : null;
    const readApplyCount = () => jsonRecord && typeof jsonRecord.applyCount === "number"
      && Number.isFinite(jsonRecord.applyCount)
      ? jsonRecord.applyCount
      : null;
    const hasSaved = jsonRecord
      && (typeof jsonRecord.saved === "boolean" || typeof jsonRecord.savedApplication === "boolean");
    const recordWarning = jsonMetadata.warning
      || (jsonRecord
        ? relativeTime || pubDate !== null
          ? null
          : `Indeed job-card JSON formattedRelativeTime is empty for ${jobId}.`
        : `notInResults: Indeed job-card JSON has no result for ${jobId}.`);

    return {
      reason: jsonMetadata.warning
        ? jsonMetadata.warning.startsWith("jsonMissing:")
          ? "jsonMissing"
          : "parseError"
        : jsonRecord
          ? "matched"
          : sponsored
            ? "sponsoredNoDate"
            : "notInResults",
      sponsored,
      record: {
        siteId: "indeed",
        jobId,
        title,
        company: selectors.text(selectors.query(card, selectors.SELECTORS.company)) || null,
        location: selectors.text(selectors.query(card, selectors.SELECTORS.location)) || null,
        salary: selectors.text(selectors.query(card, selectors.SELECTORS.salary)) || null,
        jobType: extractJobType(card),
        easyApplyBadge: /easily apply/i.test(selectors.text(card)),
        urgentlyHiring: /urgently hiring/i.test(selectors.text(card)),
        sponsored,
        indeedApplyEnabled: jsonRecord && typeof jsonRecord.indeedApplyEnabled === "boolean"
          ? jsonRecord.indeedApplyEnabled
          : null,
        applied: readBoolean("appliedOrGreater"),
        saved: hasSaved
          ? jsonRecord.saved === true || jsonRecord.savedApplication === true
          : null,
        visited: readBoolean("isJobVisited"),
        expired: readBoolean("expired"),
        applyCount: readApplyCount(),
        postedType: "Unknown",
        postedText: sponsored ? null : relativeTime,
        pubDate,
        remoteWorkText,
        parseWarning: recordWarning
      }
    };
  }

  function parsePageWithDiagnostics(ctx) {
    const doc = ctx && (ctx.doc || ctx.document);
    if (!doc || typeof doc.querySelectorAll !== "function") {
      throw new Error("Indeed parsing requires a document in ctx.doc or ctx.document.");
    }

    const jsonMetadata = readJobMetadata(doc);
    const recordsById = new Map();
    const diagnostics = {
      cards: 0,
      matched: 0,
      invalidId: 0,
      matchedEmpty: 0,
      sponsoredNoDate: 0,
      jsonMissing: 0,
      parseError: 0,
      notInResults: 0
    };
    for (const card of selectors.getJobCards(doc)) {
      diagnostics.cards += 1;
      const parsed = parseCard(card, jsonMetadata);
      if (!parsed.record) {
        diagnostics.invalidId += 1;
        continue;
      }
      if (parsed.reason === "matched") {
        diagnostics.matched += 1;
        if (!parsed.record.postedText) {
          diagnostics.matchedEmpty += 1;
        }
      } else if (parsed.reason === "sponsoredNoDate") {
        diagnostics.sponsoredNoDate += 1;
      } else if (parsed.reason === "jsonMissing") {
        diagnostics.jsonMissing += 1;
      } else if (parsed.reason === "parseError") {
        diagnostics.parseError += 1;
      } else if (parsed.reason === "notInResults") {
        diagnostics.notInResults += 1;
      }
      if (!recordsById.has(parsed.record.jobId)) {
        recordsById.set(parsed.record.jobId, parsed.record);
      }
    }
    return {
      records: Array.from(recordsById.values()),
      diagnostics,
      warning: jsonMetadata.warning
    };
  }

  function waitForDomContentLoaded(doc) {
    if (doc.readyState !== "loading") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      doc.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  async function parsePageWithRetry(ctx) {
    const firstPass = parsePageWithDiagnostics(ctx);
    const shouldRetry = Boolean(firstPass.warning)
      || firstPass.diagnostics.jsonMissing > 0
      || firstPass.diagnostics.parseError > 0
      || firstPass.diagnostics.notInResults > 0;
    if (!shouldRetry) {
      return firstPass;
    }
    const doc = ctx.doc || ctx.document;
    await waitForDomContentLoaded(doc);
    await new Promise((resolve) => global.setTimeout(resolve, 1000));
    return parsePageWithDiagnostics(ctx);
  }

  function parsePage(ctx) {
    return parsePageWithDiagnostics(ctx).records;
  }

  global.JobCollectorIndeedParser = Object.freeze({
    parsePage,
    parsePageWithDiagnostics,
    parsePageWithRetry,
    readJobMetadata,
    isUsableJobId
  });
})(globalThis);
