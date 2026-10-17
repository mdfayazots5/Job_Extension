"use strict";

(function initializeJobCollectorSiteRegistry(global) {
  const adapters = Object.freeze([
    global.JobCollectorLinkedInAdapter,
    global.JobCollectorNaukriAdapter,
    global.JobCollectorIndeedAdapter
  ].filter(Boolean));

  function getAdapterForUrl(value) {
    let url;
    try {
      url = value instanceof URL ? value : new URL(value);
    } catch (_error) {
      return null;
    }
    return adapters.find((adapter) => adapter.matchesUrl(url)) || null;
  }

  function getAdapter(siteId) {
    return adapters.find((adapter) => adapter.id === siteId) || null;
  }

  global.JobCollectorSiteRegistry = Object.freeze({
    getAdapter,
    getAdapterForUrl,
    adapters
  });
})(globalThis);
