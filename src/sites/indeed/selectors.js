"use strict";

(function initializeIndeedSelectors(global) {
  const SELECTORS = Object.freeze({
    cards: "#mosaic-provider-jobcards div.job_seen_beacon",
    title: "a.jcs-JobTitle[data-jk]",
    titleText: "h3.jobTitle span[title]",
    company: '[data-testid="company-name"]',
    location: '[data-testid="text-location"]',
    salary: '[data-testid~="salary-snippet-container"]',
    currentPage: '[data-testid="pagination-page-current"]',
    nextPage: 'a[data-testid="pagination-page-next"]'
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
      ? element.textContent.replace(/\s+/g, " ").trim()
      : "";
  }

  function getJobCards(doc) {
    return queryAll(doc, SELECTORS.cards);
  }

  function getNextPageLink(doc) {
    const link = query(doc, SELECTORS.nextPage);
    return link
      && link.getAttribute("aria-disabled") !== "true"
      && !link.hasAttribute("disabled")
      && link.getAttribute("href")
      ? link
      : null;
  }

  function getCurrentPage(doc) {
    const current = query(doc, SELECTORS.currentPage);
    const match = current && text(current).match(/\d+/);
    const page = match ? Number(match[0]) : null;
    return Number.isInteger(page) && page > 0 ? page : null;
  }

  global.JobCollectorIndeedSelectors = Object.freeze({
    SELECTORS,
    query,
    queryAll,
    text,
    getJobCards,
    getNextPageLink,
    getCurrentPage
  });
})(globalThis);
