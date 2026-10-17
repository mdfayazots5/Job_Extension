"use strict";

(function initializeJobMetadata(global) {
  const RELATIVE_TIME = /(\d+)\+?\s*(minutes?|hours?|days?|weeks?|months?)\s+ago/i;
  const POSTED_WORDS = /\b(?:reposted|posted)\b/i;
  const RELATIVE_WORDS = /\b(?:just now|today|yesterday)\b/i;

  function isPostedSegment(segment) {
    return POSTED_WORDS.test(segment)
      || RELATIVE_TIME.test(segment)
      || RELATIVE_WORDS.test(segment);
  }

  function cleanLocation(value, company, title) {
    let location = String(value || "").trim();
    const prefixes = [company, title]
      .filter((prefix) => typeof prefix === "string" && prefix.trim())
      .map((prefix) => prefix.trim())
      .sort((first, second) => second.length - first.length);

    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const prefix of prefixes) {
        if (location.slice(0, prefix.length).toLocaleLowerCase() === prefix.toLocaleLowerCase()) {
          location = location.slice(prefix.length).replace(/^[\s,·|–—:-]+/, "").trim();
          stripped = true;
          break;
        }
      }
    }
    return Array.from(location).slice(0, 60).join("").trim();
  }

  function estimatePostedDate(postedText, capturedAt) {
    const estimate = new Date(capturedAt);
    if (Number.isNaN(estimate.getTime())) {
      return null;
    }

    const text = String(postedText || "").trim();
    if (/\byesterday\b/i.test(text)) {
      estimate.setDate(estimate.getDate() - 1);
      return estimate.toISOString().slice(0, 10);
    }
    if (/\b(?:just now|today)\b/i.test(text)) {
      return estimate.toISOString().slice(0, 10);
    }

    const match = text.match(RELATIVE_TIME);
    if (!match) {
      return null;
    }

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith("minute")) {
      estimate.setMinutes(estimate.getMinutes() - amount);
    } else if (unit.startsWith("hour")) {
      estimate.setHours(estimate.getHours() - amount);
    } else if (unit.startsWith("day")) {
      estimate.setDate(estimate.getDate() - amount);
    } else if (unit.startsWith("week")) {
      estimate.setDate(estimate.getDate() - (amount * 7));
    } else {
      const day = estimate.getDate();
      estimate.setDate(1);
      estimate.setMonth(estimate.getMonth() - amount);
      const lastDay = new Date(
        estimate.getFullYear(),
        estimate.getMonth() + 1,
        0
      ).getDate();
      estimate.setDate(Math.min(day, lastDay));
    }
    return estimate.toISOString().slice(0, 10);
  }

  function parseDetailMeta(text, capturedAt, context = {}) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes("·"));
    const selectedLine = lines.find((line) => (
      line.split("·").slice(1).some((segment) => isPostedSegment(segment))
    )) || lines[0] || "";
    const segments = selectedLine
      .split("·")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const postedSegments = segments.slice(1).filter(isPostedSegment);
    const postedRaw = (postedSegments.length ? postedSegments : segments.slice(1))
      .join(" · ");
    const reposted = /\breposted\b/i.test(postedRaw);
    const postedText = postedRaw
      .replace(/\b(?:reposted|posted)\b/gi, "")
      .replace(/\s*·\s*/g, " · ")
      .replace(/^[\s·:,-]+|[\s·:,-]+$/g, "")
      .trim();
    const postedType = reposted
      ? "Reposted"
      : (isPostedSegment(postedRaw) ? "Posted" : "Unknown");

    return {
      location: cleanLocation(segments[0] || "", context.company, context.title),
      postedType,
      postedText,
      postedDateEstimate: estimatePostedDate(postedText, capturedAt)
    };
  }

  const api = Object.freeze({
    parseDetailMeta,
    estimatePostedDate
  });
  global.JobCollectorMetadata = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
