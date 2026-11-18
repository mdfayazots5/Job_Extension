# AGENTS.md: LinkedIn/Naukri Jobs Collector (Chrome MV3 extension, vanilla JS)

PROJECT STATE
- Sites: linkedin (done, working, MUST NOT REGRESS), naukri (done, Phases 1-4 complete), indeed (in.indeed.com, done).
- Distribution: shared as a plain "Load unpacked" folder from GitHub (no build, no native host required). The native backup host (native-host/) is OPTIONAL: src/core/native-backup.js degrades to local-only when Chrome reports the host missing; never make Start/sync depend on it.
- Onboarding: onboarding/welcome.html (tour opened on first install; #site=<id> = per-site guide), per-site text + sample jobs in src/sites/<id>/guide.js, shared sample-data logic in src/core/demo-data.js (records flagged demo:true, IDs demo-N, auto-removed by storage.setJobs when real jobs for that site are saved).
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