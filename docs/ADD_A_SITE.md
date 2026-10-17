# Add a site

Each supported site lives in one folder under `src/sites/<site-id>/` and has one manifest `content_scripts` block. Site-specific parsing, selectors, limits, and UI settings stay in that folder. Do not change `src/core/` when adding a site.

1. Save representative search-results HTML in `tests/fixtures/`, including empty, blocked, and final-page examples where possible.
2. Create `src/sites/<site-id>/selectors.js` using stable attributes, semantic labels, and URL patterns. Do not use hashed CSS classes.
3. Implement `adapter.js` with the SiteAdapter contract: identity, URL matching, block detection, page collection, pagination, normalization, limits, and `ui` settings.
4. Write parsing tests against the saved fixture before registering the adapter.
5. Add the adapter to `src/sites/registry.js` only when its tests pass.
6. Add one `content_scripts` block and the required host permission in `manifest.json`. Keep the block limited to that site's matches and scripts.
7. Set `ui.tabs`, `ui.columns`, `ui.applyUrl`, and `ui.accent` in the adapter so the results page can render the site.
8. Set conservative per-site limits and cooldown timing in the site's config.
9. Run the LinkedIn and Naukri regression tests, then test the new site with its fixture and a manual run.
10. Update the results page switcher when the new site becomes active.

Never alter the shared run loop, storage schema, or other sites to accommodate selectors. Records, run state, budgets, cooldowns, opened state, kill-switch counters, and diagnostics use the site namespace. The only shared record container uses keys in the form `<site-id>:<job-id>`.
