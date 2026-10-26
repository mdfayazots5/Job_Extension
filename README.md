# Job Extensions

Job Extensions is a local Chrome extension that collects visible job results from LinkedIn, Naukri, and Indeed into a site-aware results page. It does not click Apply or Save.

Naukri job details are read from visible result cards in the active page DOM. A Naukri-only, read-only observer captures the page's own search API response to get `companyApplyJob`, `questionnaireIdPresent`, and `applyRedirectUrl`; the extension does not replay the API request. **Easy Apply** includes both Naukri in-platform questionnaire flows (`questionnaireIdPresent: true` or `false`); **Company Apply** is used for `companyApplyJob: true` or a valid external apply redirect when that flag is missing. Conflicting or incomplete evidence is not guessed into either category and remains available under **All**. Missing API flags do not block capture, and a later capture with stronger evidence updates the saved record automatically. If Naukri returns HTTP 406 because it requires reCAPTCHA verification, complete the verification on the page, reload, and start a new run.

Indeed collection starts only on `https://in.indeed.com/jobs` with a `q` search term and a loaded `#mosaic-provider-jobcards` results container. It reads the visible result cards and page-provided job JSON, clicks only Indeed's own Next-page control, and never opens a job card.

Indeed records are enriched with the jobcards JSON's applied, saved, visited, expired, and apply-count status. Jobs reported as applied or expired are not saved; the popup and results footer show those per-run skip counts. Visited jobs remain in results with a **Visited** chip. Missing JSON status stays unknown rather than being treated as false. Indeed's Apply action continues to open only the canonical `/viewjob?jk=` URL.

### Saved visibility rules

The results page has independent, saved location filters for Hyderabad, Bengaluru/Bangalore, and Other on each site. Naukri also has saved, multi-select experience filters for 1–5 years; selecting a year matches Naukri experience ranges that include that year. Search text matches title, company, or location on all platforms. Use `skill:.Net` to search only job skills. Posted-date sorting uses one timestamp-based rule on each platform: newest first by default, oldest first when reversed, and unknown dates always last. For the default newest-first order, approximate dates follow exact dates; when reversed, approximate dates precede exact dates. Naukri job titles opened by the user on its search page, and jobs opened through the results-page Apply link, are marked **Opened** and automatically hidden from the main list. Opened and manually hidden jobs are available together under **View Hidden Jobs**; these statuses are saved per site and retained in the local job-history archive. Select jobs with the row checkboxes and choose **Hide JD** to hide them persistently for that site; **Clear** clears the current filters but does not erase opened or hidden status. Opened and hidden status do not remove stored records.

The results view uses one extension URL for all platforms. Its selected platform is remembered in local extension storage rather than encoded in the URL.

Use **Settings → Flow logs** on the Results page to choose Results Page, LinkedIn, Naukri, or Indeed and enable or disable diagnostics for that source. Results Page logs cover the extension's results-page startup, status sync, storage reads, and timings; the other choices cover their respective collector diagnostics. The selected source and its on/off setting are saved across page refreshes. Turn logging on before refreshing or starting a run. Choose **Settings → View Logs** to inspect the selected source's latest diagnostics, then **Copy logs** to share them. Diagnostics remain in local storage and are not copied to the reinstall archive.

Use the **Settings** gear on the results page to open **History**, **Export**, **Skip Title**, **View Logs**, and **Flow logs** settings. Skip titles are managed for the currently selected platform and saved under that site's namespace. They are restored from the local archive after an extension reinstall. A title is skipped only when the entire job title matches (case-insensitive, ignoring surrounding spaces); similar or longer titles are still captured. The former built-in title exclusions have been removed.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this project folder.
4. In PowerShell, run `.\native-host\install.ps1` from the project folder. This builds and registers the local native-messaging helper for the extension ID shown in the script; pass `-ExtensionId <id>` if Chrome displays a different ID.
5. Reload the extension in `chrome://extensions`.

The native host keeps one append-only archive, `job-history-backup.jsonl`, in the project folder. It contains job snapshots, durable settings, and per-job opened/hidden status changes. The archive is excluded from Git so local job data is not committed. Chrome profiles using the same extension ID, Windows user account, and installed native host share statuses through this file. Open results pages refresh shared statuses when focused and every five seconds while visible. This is local to one Windows account and does not sync between devices or Windows accounts. Temporary file-sharing locks are retried. A job is saved to extension storage before archive synchronization, so an archive write issue does not interrupt capture; it is reported in the service worker console and reconciled from local records on the next extension startup. Do not delete or move the archive if you want reinstall recovery. Keep a separate copy when moving the project or device.

## Supported sites and limits

| Site | Per run | Per day | Pages |
| --- | ---: | ---: | ---: |
| LinkedIn | 500 | 5,000 | 25 |
| Naukri | 500 | 5,000 | 25 |
| Indeed | 500 | 5,000 | 50 |

Each site has separate records, opened state, budgets, run state, diagnostics, cooldown, and kill-switch counter. A block starts a 24-hour cooldown for that site; another block within seven days uses a 48-hour cooldown. Only one collection run may be active at a time.

Naukri's 25-page run limit counts from the page where the run starts. For example, starting on page 25 allows collection through 25 pages, ending on page 49.

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

Job records for all three sites are retained across runs and deduplicated by site and job ID. The single append-only `job-history-backup.jsonl` archive preserves records, opened/hidden changes, Skip Titles, filters, selected tabs, and budget/cooldown/kill-switch safety state. Status changes are appended individually, so concurrent Chrome profiles do not replace one another's whole status maps. Temporary run progress and diagnostics remain local-only. The archive is excluded from Git and is never automatically deleted. On extension install or browser startup, archived records and settings are restored to local extension storage. Chrome local storage remains the working copy and is subject to Chrome's quota; the project-folder archive is the durable local copy. Keep a separate copy when moving the project or device because data in the project folder is not protected from folder deletion, disk failure, or device loss.

## Flow diagnostics

In Results-page **Settings → Flow logs**, choose **Results Page** to diagnose this extension page, or choose a job platform to diagnose its collector; then turn logging on. The selected source and setting remain saved after refreshes. Use **View Logs** to inspect that source's entries and **Copy logs** to copy them for sharing. Flow diagnostics are stored locally, bounded by age and count; Naukri entries record URL paths rather than search-query parameters, and Indeed flow details omit search URLs. Logs are not included in the native archive.

If Results Page logs show `Unsupported native backup request` during status synchronization, rebuild and register the local messaging host from the project folder with `.\native-host\install.ps1`, then restart Chrome. Results load from Chrome storage even if the shared status sync is unavailable.

The popup retains the terminal run's captured-job count, last page, and (for Indeed) applied/expired skip counts until another run starts.

## Updating selectors

Save an HTML fixture in `tests/fixtures`, update only that site's `selectors.js` and adapter, then update its fixture tests. Run the full regression suite before loading the extension again. See [the add-a-site checklist](docs/ADD_A_SITE.md) for the full process.
