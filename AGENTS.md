# AGENTS.md: LinkedIn/Naukri Jobs Collector (Chrome MV3 extension, vanilla JS)

PROJECT STATE
- Sites: linkedin (done, working, MUST NOT REGRESS), naukri (done, Phases 1-4 complete), indeed (future, stub only).
- Architecture: src/core/ (state machine, storage, humanizer/delays, budgets, circuit breaker, logger, generic run loop), src/sites/<id>/ (adapter.js + selectors.js), src/sites/registry.js (URL -> adapter), content/, results/ (results.html/css/js), popup/, background/ (service worker).
- Popup: Start/Stop only + "View results" link. Acts on the active tab's site only.
- results.html: site-aware (LinkedIn | Naukri switcher, ?site=), table layout, tabs/columns come from adapter.ui.

HARD RULES
- Shared logic only in src/core/. No site-specific strings in core.
- Each site loads ONLY on its own domain via its own content_scripts `matches`. Host permissions only linkedin.com and naukri.com.
- All storage namespaced by site: records `${site}:${jobId}`, runs.<site>, budgets.<site>, cooldown.<site>, opened.<site>, killswitch.<site>, debug log per site.
- Read-only DOM. Never click Apply/Save. Only the site's own pagination clicks (and LinkedIn card clicks as already implemented). Never edit URLs or filters.
- Never use hashed class names (hv4xxx, styles_xxx__hash). Use ids, data-*, aria-label, href patterns, text, stable plain classes.
- Safety stays: jittered delays, per-run/day caps, circuit breaker + cooldown (24h, 48h if repeated in 7 days), visible-tab only, kill switch, no auto-retry.
- Only one run globally at a time.
- Do not break LinkedIn. Run existing tests before and after every change.