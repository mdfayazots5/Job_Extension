"use strict";

(function initializeJobCollectorRunLoop(global) {
  /**
   * @typedef {"inplace"|"navigated"|"none"} PageNavigation
   *
   * @typedef {Object} AdapterContext
   * @property {Document} doc
   * @property {URL} url
   * @property {string} runId
   * @property {number} pageNumber
   * @property {Object} [run]
   * @property {Object} [config]
   *
   * @typedef {Object} SiteAdapter
   * @property {string} id
   * @property {string} label
   * @property {(url: URL) => boolean} matchesUrl
   * @property {(doc: Document, url: URL) => (string|null)} detectBlock
   * @property {(doc: Document, url: URL) => (number|null)} getCurrentPage
   * @property {(ctx: AdapterContext) => Promise<Object>} collectPage
   * @property {(doc: Document) => boolean} hasNextPage
   * @property {(ctx: AdapterContext) => Promise<PageNavigation>} goNextPage
   * @property {(raw: Object) => Object} normalize
   * @property {Object} limits
   * @property {Object} ui
   * @property {Array<Object>} ui.tabs
   * @property {Array<Object>} ui.columns
   * @property {(record: Object) => (string|null)} ui.applyUrl
   * @property {string} ui.accent
   */

  /**
   * @param {SiteAdapter} adapter
   * @param {Object} context Runtime callbacks used by the generic page loop.
   */
  async function run(adapter, context) {
    let pageNumber = context.pageNumber;
    let resumePagination = context.resumePagination;
    const getRunCapturedCount = async (stats) => {
      return typeof context.readRunCapturedCount === "function"
        ? context.readRunCapturedCount()
        : stats.capturedCount;
    };
    const startPageNumber = Number.isInteger(context.startPageNumber)
      && context.startPageNumber > 0
      ? context.startPageNumber
      : 1;
    const pagesProcessed = (currentPage) => Math.max(1, currentPage - startPageNumber + 1);
    const reachedPageLimit = (currentPage) => (
      pagesProcessed(currentPage) >= adapter.limits.maxPages
    );
    while (pagesProcessed(pageNumber) <= adapter.limits.maxPages) {
      context.setPage(pageNumber);
      await context.ensureVisible();
      context.checkBlock();
      let stats = await context.readStats();
      if (await getRunCapturedCount(stats) >= adapter.limits.maxJobsPerRun) {
        await context.finish(
          pageNumber,
          stats,
          `Stopped at the configured maximum of ${adapter.limits.maxJobsPerRun} jobs.`
        );
        return { pageNumber, navigation: "none" };
      }
      if (reachedPageLimit(pageNumber) && resumePagination) {
        await context.finish(
          pageNumber,
          stats,
          `Stopped at the configured maximum of ${adapter.limits.maxPages} results pages.`
        );
        return { pageNumber, navigation: "none" };
      }
      const livePage = adapter.getCurrentPage(context.doc, context.url);
      if (Number.isInteger(livePage) && livePage > pageNumber) {
        pageNumber = livePage;
        context.setPage(pageNumber);
        resumePagination = false;
      }

      if (resumePagination) {
        const navigation = await adapter.goNextPage({
          ...context,
          pageNumber,
          container: context.getContainer(),
          setNextPage: context.setNextPage
        });
        if (navigation === "none") {
          await context.finish(pageNumber, await context.readStats(), "No next page is available while resuming.");
          return { pageNumber, navigation };
        }
        pageNumber = context.nextPageNumber || pageNumber + 1;
        context.setPage(pageNumber);
        resumePagination = false;
        continue;
      }

      stats = await context.readStats();
      await context.writeProgress(pageNumber, stats, "RUNNING");
      const pageResult = await adapter.collectPage({
        ...context,
        runId: context.runId,
        pageNumber,
        collectPageWork: context.collectPageWork
      });
      pageNumber = adapter.getCurrentPage(context.doc, context.url) || pageNumber;
      context.setPage(pageNumber);
      stats = await context.readStats();
      if (await getRunCapturedCount(stats) >= adapter.limits.maxJobsPerRun) {
        await context.finish(
          pageNumber,
          stats,
          `Stopped at the configured maximum of ${adapter.limits.maxJobsPerRun} jobs.`
        );
        return { pageNumber, navigation: "none" };
      }
      if (!adapter.hasNextPage(context.doc, pageNumber)) {
        await context.finish(
          pageNumber,
          stats,
          `Finished results page ${pageNumber}; no next page is available.`
        );
        return { pageNumber, navigation: "none" };
      }
      if (reachedPageLimit(pageNumber)) {
        await context.finish(
          pageNumber,
          stats,
          `Stopped at the configured maximum of ${adapter.limits.maxPages} results pages.`
        );
        return { pageNumber, navigation: "none" };
      }
      if (typeof context.beforeNextPage === "function") {
        await context.beforeNextPage(pageNumber);
      }
      await context.writeProgress(pageNumber, pageResult, "PAGINATING");
      const navigation = await adapter.goNextPage({
        ...context,
        pageNumber,
        container: context.getContainer(),
        setNextPage: context.setNextPage
      });
      if (navigation === "none") {
        await context.finish(pageNumber, await context.readStats(), "No next page is available.");
        return { pageNumber, navigation };
      }
      if (navigation === "navigated") {
        return { pageNumber: pageNumber + 1, navigation };
      }
      pageNumber = context.nextPageNumber || pageNumber + 1;
      context.setPage(pageNumber);
      context.onPage(pageNumber);
    }
    const stats = await context.readStats();
    await context.finish(
      pageNumber,
      stats,
      `Stopped at the configured maximum of ${adapter.limits.maxPages} results pages.`
    );
    return { pageNumber, navigation: "none" };
  }

  global.JobCollectorRunLoop = Object.freeze({ run });
})(globalThis);
