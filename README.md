# JobLink

JobLink is a local Chrome extension that collects visible job results from LinkedIn and Naukri into a site-aware results page. It does not click Apply or Save.

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

## Updating selectors

Save an HTML fixture in `tests/fixtures`, update only that site's `selectors.js` and adapter, then update its fixture tests. Run the full regression suite before loading the extension again. See [the add-a-site checklist](docs/ADD_A_SITE.md) for the full process.
