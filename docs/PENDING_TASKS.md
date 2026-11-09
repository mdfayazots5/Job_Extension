# Pending tasks

## [PARTLY DONE] Results page UI polish: Indeed view (logged 2026-11-09)

**Done 2026-11-09:**
- Cards vs tabs: with a location/experience filter on, the Total card note adds "· N match filters" and the Easy Apply note shows "N match your filters (Easy Apply tab)".
- The "Actively reviewing" card is hidden on Naukri and Indeed; the remaining cards spread to 3 columns.
- The location options show counts, e.g. "Bengaluru (1,402)", using the same matching as the filter.
- The table scroller sizes itself to the window (`--table-fit-height`, recalculated on render and resize). No fixed 760px cap and no dead space.
- The settings menu closes on outside click and on Esc.
- "Hide JD" has a tooltip: "Tick jobs in the table to hide them" / "Hide N selected jobs".
- Apply buttons: company-site jobs get an outlined button with ↗ (`data-apply-type="company"`), plus a tooltip. Easy Apply stays filled.
- Search placeholder is now "…or skill:keyword", with the `skill:.Net` example in a tooltip.
- Indeed column widths: Role 23%, Company 18%, Salary 10%, Type 7%. Salary is filled for 19% of Indeed jobs and Type for 39%, so they're kept, just narrower.
- Fixed `tests/results-ui.test.js`. It was failing because the fixture dates were fixed (2026-10-29) and had aged out of "Fresh today", not because of the `results.js` changes. The dates are now relative to the current time.

**Follow-up from the LinkedIn screenshot (2026-11-09):**
- Fixed blank Apply buttons on the Company tab. The tab's fill rule outranked the new outlined style, so the buttons got blue text on a blue fill.
- "No status shown" tags are hidden; only "Actively reviewing" shows. The dropdown still filters on both.
- LinkedIn widths: Role 31%, Company 19%, Location 15%, Posted 20%.
- The table height now reserves the real space below it, so the page no longer gets a second scrollbar.

**Still open (blocked by labels the tests pin, or a product choice):**
- Rename "Hide JD" / merge "View Logs" and "Flow logs" (the tests assert these exact labels).
- The location options are still fixed to Hyderabad/Bengaluru/Other. That's kept on purpose: the data is ~62% those two cities.
- Clamp Role to 2 lines with the full title on hover.
- Visual check at 1280px and 1024px in the real browser.

**Screen:** `results.html?site=indeed`, Hyderabad + Bengaluru location filter on, settings menu open.
**Goal:** the page should tell the truth at a glance. Numbers agree with each other, empty data isn't shown as zero, and the space goes to what users scan (role, company, apply).

**Constraints (AGENTS.md):** shared UI logic stays site-agnostic and is driven by `adapter.ui`. Do not regress LinkedIn or Naukri. Run every test file before and after. Note: `tests/results-ui.test.js` was already failing at line 1941 when this task was logged, because of uncommitted `results.js` work. Fix or re-baseline that first.

### Checked in code (2026-11-09)
- Confirmed: the KPI cards count all records for the site, while the tabs count the filtered list (`results.js` around line 2620). The page already has a "Showing X of Y" label, but it isn't visible in the screenshot.
- Confirmed: the "Actively reviewing" card is in `results.html` for every site. It isn't driven by `adapter.ui`.
- Confirmed: the location filter is hard-coded to Hyderabad / Bengaluru / Other (`results.js:1089`).
- Confirmed: `.table-wrap` is its own scroll box (`max-height` + `overflow: auto`, `results.css:749`, Indeed override at line 1058).
- Confirmed: "Hide JD" is disabled until rows are selected (by design, but with no hint).
- Not yet checked: whether Salary/Type are empty across all Indeed records (or only these rows); the settings menu's close behavior; the Apply button labels per apply type.

### Issues found

**A. Numbers that contradict each other (highest priority)**
1. KPI cards ignore the active filters, but the tabs apply them. For example, "Easy Apply **876**" vs tab "Easy Apply (**476**)", and "Total captured 2440 · 2247 visible" vs tab "All (**1621**)". A user can't tell which number is right.
   - Fix: either make the KPIs follow the active filters, or label them clearly ("All captured", for example) and show the filtered count next to the tabs, like "Showing 1,621 of 2,247".
2. "Actively reviewing **0** · 0% verified" and "Fresh today **0**" on Indeed. Indeed never provides the reviewing signal, so 0 reads as a fact when the data is actually missing.
   - Fix: let the adapter declare which KPIs it supports, then hide the unsupported cards or show "Not available on Indeed" (muted, no number).
3. "Fresh today 0" while every visible row says "1 week ago". Check whether the "posted <24h" logic uses the estimated date (`~28 Oct 2026`) correctly. It may simply be correct for stale data. If so, show the newest-posting date in the card instead of a bare 0.

**B. Wasted space and cramped content**
4. SALARY is "—" on every row, and TYPE is "—" on most. Two wide columns carry no information while ROLE wraps to 4 lines (row 5) and COMPANY truncates ("Infinite Computer…") with room to spare.
   - Fix: automatically hide a column when it's empty for over 90% of the visible rows (with a "show empty columns" toggle). Give ROLE and COMPANY the freed width. Clamp ROLE to 2 lines and show the full text on hover.
5. The table is a fixed-height inner scroll box. The last row is cut off and there's dead space below it. This makes two scrollbars (page and table).
   - Fix: let the table use the page scroll, with a sticky header, or size the box to the viewport with `calc(100vh - offset)`.

**C. Controls and affordances**
6. The search placeholder "Search title, company, location, or skill:.Net" reads like a value that's already typed, and `skill:.Net` looks like a bug.
   - Fix: placeholder "Search jobs…", with a small hint below or a tooltip: "Tip: `skill:.NET` searches skills only".
7. "Hide JD" is greyed out with no explanation. The name is also unclear (JD = job description?) when it actually hides the selected jobs.
   - Fix: rename to "Hide selected (n)". Show it only once rows are selected, or add a tooltip "Select jobs to hide".
8. The settings menu (History / Export / Skip Title / View Logs / Flow logs) covers the search box, the table header and the table scrollbar. It has no grouping, and "View Logs" and "Flow logs" sound the same.
   - Fix: anchor it under the gear and close it on outside click and Esc. Group the items: *Data*: History, Export · *Filters*: Skip Title · *Diagnostics*: Logs (merge the two log entries, or rename them clearly).
9. Every row's button says "Apply". Easy Apply and Company Apply jobs look the same, even though the tabs separate them.
   - Fix: give each type a different button label or style ("Easy Apply" filled, "Apply on site ↗" outlined). Also show a "Viewed" state for opened jobs.
10. The location filter options (Hyderabad / Bengaluru / Other) appear hard-coded. Build them from the captured data and add counts, like "Bengaluru (1,402)".

**D. Smaller details**
11. The KPI cards are close to the site switcher and the gear and crowd them at narrower widths. Check the layout at 1280px and 1024px.
12. Row 5's title contains "Delhi" while its location is "Bengaluru". That's a data issue on the source side; no UI fix needed, just noting it.
13. The avatar letter tiles use a different tint for each company. Fine, but make sure the contrast meets WCAG AA.

### Done when
- Every number on screen is either consistent with the active filters or clearly labelled as all-time.
- No KPI shows 0 for a signal the site doesn't provide.
- No fully empty column takes width by default. ROLE wraps to at most 2 lines.
- One scroll area. The last row is fully visible.
- All tests pass. LinkedIn and Naukri views are checked manually and unchanged except for the intended improvements.
