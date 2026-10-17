# Add a site

Each supported site lives in one folder under `src/sites/<site-id>/` and has its own manifest content-script match. If a site needs multiple execution worlds or run phases, use separate blocks with the same site-only match. Site-specific parsing, selectors, limits, and UI settings stay in that folder.

1. Save representative search-results HTML in `tests/fixtures/`, including empty, blocked, and final-page examples where possible.
2. Create `src/sites/<site-id>/selectors.js` using stable attributes, semantic labels, and URL patterns. Do not use hashed CSS classes.
3. Implement `adapter.js` with the SiteAdapter contract: identity, URL matching, block detection, page collection, pagination, normalization, limits, and `ui` settings.
4. Write parsing tests against the saved fixture before registering the adapter.
5. Add the adapter to `src/sites/registry.js` only when its tests pass.
6. Add the minimum required host permission and content-script block(s) in `manifest.json`. Keep every block limited to that site's matches and scripts; never combine site adapters in a page content-script bundle.
7. Set `ui.tabs`, `ui.columns`, `ui.applyUrl`, and `ui.accent` in the adapter so the results page can render the site.
8. Set conservative per-site limits and cooldown timing in the site's config.
9. Run LinkedIn, Naukri, and all other supported-site regression tests, then test the new site with its fixture and a manual run.
10. Update the results page switcher when the new site becomes active.

Never alter the shared run loop, storage schema, or other sites to accommodate selectors. Records, run state, budgets, cooldowns, opened state, kill-switch counters, and diagnostics use the site namespace. The only shared record container uses keys in the form `<site-id>:<job-id>`.

## Current page/script map

| Page | Manifest match | Content scripts |
| --- | --- | --- |
| LinkedIn jobs | `https://www.linkedin.com/jobs/*` | Shared storage/run-loop plus LinkedIn config, selectors, metadata, adapter, registry, and collector |
| Naukri API observer | `https://www.naukri.com/*` | `src/sites/naukri/api-observer.js` at `document_start` in `MAIN` world |
| Naukri API bridge | `https://www.naukri.com/*` | `src/sites/naukri/api-bridge.js` at `document_start` in the isolated world |
| Naukri jobs | `https://www.naukri.com/*` | Shared storage/run-loop plus Naukri config, selectors, adapter, and collector at `document_idle` |
| Indeed | `https://in.indeed.com/*` | Shared storage/run-loop plus Indeed config, selectors, parser, adapter, registry, and collector |

The extension host permissions are limited to `https://www.linkedin.com/*`, `https://www.naukri.com/*`, and `https://in.indeed.com/*`. The only declared extension permissions are `storage`, `scripting`, `tabs`, and `alarms`. Do not add broad host patterns, inspect cookies or authentication material, or log full query URLs. Keep records retention bounded to 30 days and diagnostics bounded by age and count.
