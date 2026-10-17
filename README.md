# Job Extensions

Job Extensions is a local Chrome extension that collects visible job results from LinkedIn, Naukri, and Indeed into a site-aware results page. It does not click Apply or Save.

Naukri job details are read from visible result cards in the active page DOM. A Naukri-only, read-only observer captures the page's own search API response to get `companyApplyJob`, `questionnaireIdPresent`, and `applyRedirectUrl`; the extension does not replay the API request. Company applications (`companyApplyJob: true`) appear under **Company Apply**; other jobs with `questionnaireIdPresent: true` appear under **Easy Apply**, and those with it set to `false` appear under **Direct Apply**. Company Apply links use the API redirect URL when available. If Naukri returns HTTP 406 because it requires reCAPTCHA verification, complete the verification on the page, reload, and start a new run.

Indeed collection starts only on `https://in.indeed.com/jobs` with a `q` search term and a loaded `#mosaic-provider-jobcards` results container. It reads the visible result cards and page-provided job JSON, clicks only Indeed's own Next-page control, and never opens a job card.

Indeed records are enriched with the jobcards JSON's applied, saved, visited, expired, and apply-count status. Jobs reported as applied or expired are not saved; the popup and results footer show those per-run skip counts. Visited jobs remain in results with a **Visited** chip and an optional **Hide visited** filter. Missing JSON status stays unknown rather than being treated as false. Indeed's Apply action continues to open only the canonical `/viewjob?jk=` URL.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this project folder.

## Supported sites and limits

| Site | Per run | Per day | Pages |
| --- | ---: | ---: | ---: |
| LinkedIn | 500 | 2,000 | 25 |
| Naukri | 500 | 2,000 | 25 |
| Indeed | 500 | 2,000 | 50 |

Each site has separate records, opened state, budgets, run state, diagnostics, cooldown, and kill-switch counter. A block starts a 24-hour cooldown for that site; another block within seven days uses a 48-hour cooldown. Only one collection run may be active at a time.

Indeed is additionally limited to three runs per day, with no additional gap between starts.

## Extension access and page scripts

The extension uses only `storage`, `scripting`, `tabs`, and `alarms`; host access is limited to the three supported domains. Content scripts are scoped to their own site's match patterns:

| Page match | Scripts loaded |
| --- | --- |
| `https://www.linkedin.com/jobs/*` | `config.js`; core storage and run loop; LinkedIn selectors, metadata, adapter, registry, and collector |
| `https://www.naukri.com/*` at `document_start` (MAIN world) | Naukri API observer |
| `https://www.naukri.com/*` at `document_start` (isolated world) | Naukri API bridge |
| `https://www.naukri.com/*` at `document_idle` | Core storage and run loop; Naukri config, selectors, adapter, and collector |
| `https://in.indeed.com/*` | Core storage and run loop; Indeed config, selectors, parser, adapter, registry, and collector |

The results page and service worker load site adapters, but they do not inject a site's content scripts into another site's page. No cookies, authentication tokens, or CSRF values are read or stored. LinkedIn and Indeed job links are canonicalized; Naukri listing links discard query strings while the site-provided Company Apply redirect is retained for its intended Apply action. Indeed run state stores only the `q` term, and Naukri diagnostics record URL paths rather than query strings.

Stored job records older than 30 days are pruned on the next write for that site; matching opened-state entries are pruned with their records. Site diagnostics are limited to 200 entries and 30 days.

## Naukri flow diagnostics

Naukri flow diagnostics are stored locally and record URL paths rather than search-query parameters. The popup intentionally exposes only Start, Stop, and View results; it does not show flow-log controls or log entries. The popup retains the terminal run's captured-job count, last page, and (for Indeed) applied/expired skip counts until another run starts.

## Updating selectors

Save an HTML fixture in `tests/fixtures`, update only that site's `selectors.js` and adapter, then update its fixture tests. Run the full regression suite before loading the extension again. See [the add-a-site checklist](docs/ADD_A_SITE.md) for the full process.
