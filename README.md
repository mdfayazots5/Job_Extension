# Job Extensions

Job Extensions is a local Chrome extension that collects visible job results from LinkedIn, Naukri, and Indeed into a site-aware results page. It does not click Apply or Save.

Naukri job details are read from visible result cards in the active page DOM. A Naukri-only, read-only observer captures the page's own search API response to get `companyApplyJob`, `questionnaireIdPresent`, and `applyRedirectUrl`; the extension does not replay the API request. Company applications (`companyApplyJob: true`) appear under **Company Apply**; other jobs with `questionnaireIdPresent: true` appear under **Easy Apply**, and those with it set to `false` appear under **Direct Apply**. Company Apply links use the API redirect URL when available. If Naukri returns HTTP 406 because it requires reCAPTCHA verification, complete the verification on the page, reload, and start a new run.

Indeed collection starts only on `https://in.indeed.com/jobs` with a `q` search term and a loaded `#mosaic-provider-jobcards` results container. It reads the visible result cards and page-provided job JSON, clicks only Indeed's own Next-page control, and never opens a job card.

Indeed records are enriched with the jobcards JSON's applied, saved, visited, expired, and apply-count status. Jobs reported as applied or expired are not saved; the popup and results footer show those per-run skip counts. Visited jobs remain in results with a **Visited** chip. Missing JSON status stays unknown rather than being treated as false. Indeed's Apply action continues to open only the canonical `/viewjob?jk=` URL.

The results page has independent, saved location filters for Hyderabad, Bengaluru/Bangalore, and Other on each site. Naukri also has saved, multi-select experience filters for 1–5 years; selecting a year matches Naukri experience ranges that include that year. **Hide opened** is the only opened/visited/sponsored visibility checkbox and is saved separately for each site. Select jobs with the row checkboxes and choose **Hide selected** to hide them persistently for that site; **Clear hidden** restores them. **Hide hidden jobs** is enabled by default and remains enabled across refreshes. Filters and hidden status do not remove stored records.

The results view uses one extension URL for all platforms. Its selected platform is remembered in local extension storage rather than encoded in the URL.

Use **Settings → Flow logs** on the Results page to enable or disable detailed diagnostics independently for LinkedIn, Naukri, and Indeed. The setting follows the selected platform; turn it on before a run to capture flow events. Choose **Settings → View Logs** to inspect that platform's latest diagnostics, then **Copy logs** to share them. Diagnostics remain in that site's local log and are not copied to the reinstall archive.

Use the **Settings** gear on the results page to open **History**, **Export**, **Skip Title**, **View Logs**, and the per-platform **Flow logs** toggle. Skip titles are managed for the currently selected platform and saved under that site's namespace. They are restored from the local archive after an extension reinstall. A title is skipped only when the entire job title matches (case-insensitive, ignoring surrounding spaces); similar or longer titles are still captured. The former built-in title exclusions have been removed.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this project folder.
4. In PowerShell, run `.\native-host\install.ps1` from the project folder. This builds and registers the local native-messaging helper for the extension ID shown in the script; pass `-ExtensionId <id>` if Chrome displays a different ID.
5. Reload the extension in `chrome://extensions`.

The native host appends job snapshots and durable settings to `job-history-backup.jsonl` in this folder and the file is excluded from Git. Temporary file-sharing locks are retried. A job is saved to extension storage before archive synchronization, so an archive write issue does not interrupt capture; it is reported in the service worker console and reconciled from local records on the next extension startup. Do not delete or move the archive if you want reinstall recovery. Keep a separate copy when moving the project or device.

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

Job records for all three sites are retained across runs and deduplicated by site and job ID. The append-only `job-history-backup.jsonl` archive also preserves Skip Titles, opened/hidden status, filters, selected tabs, and budget/cooldown/kill-switch safety state. Temporary run progress and diagnostics remain local-only. The archive is excluded from Git and is never automatically deleted. On extension install or browser startup, archived records and settings are restored to local extension storage. Chrome local storage remains the working copy and is subject to Chrome's quota; keep the native archive and back it up separately if the extension folder or device is moved.

## Flow diagnostics

Turn on **Flow logs** in Results-page Settings before starting a run on any supported site. Use **View Logs** there to inspect entries and **Copy logs** to copy them for sharing. Flow diagnostics are stored locally, bounded by age and count; Naukri entries record URL paths rather than search-query parameters, and Indeed flow details omit search URLs. Logs are not included in the native archive.

The popup retains the terminal run's captured-job count, last page, and (for Indeed) applied/expired skip counts until another run starts.

## Updating selectors

Save an HTML fixture in `tests/fixtures`, update only that site's `selectors.js` and adapter, then update its fixture tests. Run the full regression suite before loading the extension again. See [the add-a-site checklist](docs/ADD_A_SITE.md) for the full process.
