# Job Extensions

Job Extensions is a local Chrome extension that collects visible job results from LinkedIn and Naukri into a site-aware results page. It does not click Apply or Save.

Naukri job details are read from visible result cards in the active page DOM. A Naukri-only, read-only observer captures the page's own search API response to get `companyApplyJob`, `questionnaireIdPresent`, and `applyRedirectUrl`; the extension does not replay the API request. Company applications (`companyApplyJob: true`) appear under **Company Apply**; other jobs with `questionnaireIdPresent: true` appear under **Easy Apply**, and those with it set to `false` appear under **Direct Apply**. Company Apply links use the API redirect URL when available. If Naukri returns HTTP 406 because it requires reCAPTCHA verification, complete the verification on the page, reload, and start a new run.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this project folder.

## Supported sites and limits

| Site | Per run | Per day | Pages |
| --- | ---: | ---: | ---: |
| LinkedIn | 500 | 2,000 | 25 |
| Naukri | 500 | 2,000 | 25 |

Each site has separate records, opened state, budgets, run state, diagnostics, cooldown, and kill-switch counter. A block starts a 24-hour cooldown for that site; another block within seven days uses a 48-hour cooldown. Only one collection run may be active at a time.

## Naukri flow diagnostics

Naukri flow diagnostics are stored locally and record URL paths rather than search-query parameters. The popup intentionally exposes only Start, Stop, and View results; it does not show flow-log controls or log entries. The popup retains the terminal run's captured-job count and last page until another run starts.

## Updating selectors

Save an HTML fixture in `tests/fixtures`, update only that site's `selectors.js` and adapter, then update its fixture tests. Run the full regression suite before loading the extension again. See [the add-a-site checklist](docs/ADD_A_SITE.md) for the full process.
