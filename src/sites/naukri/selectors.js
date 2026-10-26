"use strict";

(function initializeNaukriSelectors(global) {
  const SELECTORS = Object.freeze({
    cards: [
      ".srp-jobtuple-wrapper[data-job-id]",
      ".jobTuple[data-job-id]",
      ".jobTupleWrapper[data-job-id]",
      ".jobtuple-wrapper[data-job-id]",
      ".job-card[data-job-id]",
      "[data-job-id].jobTuple",
      "[data-job-id].job-card",
      "[data-job-id].jobTupleWrapper"
    ],
    title: [
      "a.title",
      "a[href*='/job-listings']",
      ".jobTuple-title a",
      ".jobTitle a",
      ".job-title a",
      "h2 a",
      "a[href*='job-listings']"
    ],
    company: [
      ".comp-name",
      ".companyName",
      ".company-name",
      ".org-name",
      ".jobTupleCompanyName",
      ".company-name a"
    ],
    postedBy: [
      ".client-company-name",
      ".postedBy",
      ".clientName",
      ".posted-by"
    ],
    logo: [
      "img.logoImage",
      "img.companyLogo",
      ".logo img",
      "img[src]"
    ],
    experience: [
      ".exp-wrap span",
      ".experience",
      ".jobExperience",
      ".exp .value",
      ".experience span"
    ],
    salary: [
      ".sal-wrap span",
      ".salary",
      ".salaryRange",
      ".salary span",
      ".salaryRange span"
    ],
    location: [
      ".loc-wrap span",
      ".location",
      ".jobLoc",
      ".job-location",
      ".location span"
    ],
    skills: [
      ".tags-gt li",
      ".keySkills li",
      ".skills li",
      ".skill-item",
      ".job-skill"
    ],
    walkIn: [
      ".ttc__walk-in",
      ".walkIn",
      ".walk-in"
    ],
    walkInDates: [
      ".walkDateWdth",
      ".walkInDates",
      ".walk-in-dates"
    ],
    postedText: [
      ".job-post-day",
      ".postedDate",
      ".posted-date",
      ".job-posted"
    ],
    pagination: "#lastCompMark",
    paginationLinks: "#lastCompMark a, #lastCompMark button, [aria-label], [title], [rel='next']",
    selectedPage: "#lastCompMark a.selected, [aria-current='page']",
    excludedContainers: [
      ".naukri-wdgt-section",
      ".naukri-widget",
      "[class*='urgent-hiring']",
      "[class*='similar-jobs']",
      "[class*='feedback']",
      "[class*='belly']"
    ].join(", ")
  });

  function normalizeSelectorList(selector) {
    const items = Array.isArray(selector) ? selector : [selector];
    return items
      .filter(Boolean)
      .flatMap((item) => String(item).split(","))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function query(root, selector) {
    if (!root || typeof root.querySelector !== "function") {
      return null;
    }
    for (const item of normalizeSelectorList(selector)) {
      const match = root.querySelector(item);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function queryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return [];
    }
    const matches = [];
    for (const item of normalizeSelectorList(selector)) {
      matches.push(...Array.from(root.querySelectorAll(item)));
    }
    return Array.from(new Set(matches));
  }

  function text(element) {
    return element && typeof element.textContent === "string"
      ? element.textContent.trim()
      : "";
  }

  function getAttributeText(root, selector, attribute) {
    const elements = queryAll(root, selector);
    const element = elements.find((candidate) => {
      const value = candidate.getAttribute(attribute);
      return typeof value === "string" && value.trim();
    });
    if (element) {
      const value = element.getAttribute(attribute);
      return typeof value === "string" ? value.trim() : "";
    }
    const fallback = query(root, selector);
    if (fallback) {
      const value = fallback.getAttribute(attribute);
      return typeof value === "string" ? value.trim() : "";
    }
    return "";
  }

  function getLocationRaw(card) {
    return getAttributeText(card, SELECTORS.location, "title");
  }

  function isExcludedCard(card) {
    return typeof card.closest === "function"
      && Boolean(card.closest(SELECTORS.excludedContainers));
  }

  function getJobCards(doc) {
    return queryAll(doc, SELECTORS.cards).filter((card) => !isExcludedCard(card));
  }

  function getJobCardForElement(doc, element) {
    return getJobCards(doc).find((card) => (
      card === element
      || (typeof card.contains === "function" && card.contains(element))
    )) || null;
  }

  function getNextPageLink(doc) {
    return queryAll(doc, SELECTORS.paginationLinks).find((control) => {
      const description = [
        text(control),
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("rel")
      ].filter(Boolean).join(" ").trim().toLowerCase();
      const disabled = control.hasAttribute("disabled")
        || control.getAttribute("aria-disabled") === "true"
        || Boolean(control.closest("[aria-disabled='true'], .disabled"));
      return !disabled && (
        description === "next"
        || /^(next|go to)\s+(page\s+)?\d+/.test(description)
        || description.includes("next page")
        || description.includes("rel next")
      );
    }) || null;
  }

  function getSelectedPage(doc) {
    const selected = query(doc, SELECTORS.selectedPage);
    if (!selected) {
      return null;
    }
    const value = Number(text(selected));
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  global.JobCollectorNaukriSelectors = Object.freeze({
    SELECTORS,
    query,
    queryAll,
    text,
    getAttributeText,
    getLocationRaw,
    getJobCards,
    getJobCardForElement,
    getNextPageLink,
    getSelectedPage
  });
})(globalThis);
