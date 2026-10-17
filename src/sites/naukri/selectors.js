"use strict";

(function initializeNaukriSelectors(global) {
  const SELECTORS = Object.freeze({
    cards: ".srp-jobtuple-wrapper[data-job-id]",
    title: "a.title",
    company: ".comp-name",
    postedBy: ".client-company-name",
    logo: "img.logoImage",
    experience: ".exp-wrap span",
    salary: ".sal-wrap span",
    location: ".loc-wrap span",
    skills: ".tags-gt li",
    walkIn: ".ttc__walk-in",
    walkInDates: ".walkDateWdth",
    postedText: ".job-post-day",
    pagination: "#lastCompMark",
    paginationLinks: "#lastCompMark a, #lastCompMark button, [aria-label], [title], [rel='next']",
    selectedPage: "#lastCompMark a.selected, [aria-current='page']",
    excludedContainers: [
      ".naukri-wdgt-section",
      "[class*='urgent-hiring']",
      "[class*='similar-jobs']",
      "[class*='feedback']",
      "[class*='belly']"
    ].join(", ")
  });

  function query(root, selector) {
    return root && typeof root.querySelector === "function"
      ? root.querySelector(selector)
      : null;
  }

  function queryAll(root, selector) {
    return root && typeof root.querySelectorAll === "function"
      ? Array.from(root.querySelectorAll(selector))
      : [];
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
    return element ? element.getAttribute(attribute).trim() : "";
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
    getNextPageLink,
    getSelectedPage
  });
})(globalThis);
