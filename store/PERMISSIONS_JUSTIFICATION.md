# Chrome Web Store — permission justifications

Paste each single sentence into the corresponding Web Store form field.

## Permissions

| Permission | Single-sentence justification |
|------------|-------------------------------|
| **storage** | Stores the user’s watched product list and local price history in `chrome.storage.local` so watches persist between browser sessions. |
| **alarms** | Schedules periodic background price checks (about every 3 hours) without keeping a persistent background page. |
| **notifications** | Shows a Chrome notification when a watched product’s minimum price drops below the previously stored value. |

## Host permissions

| Host permission | Single-sentence justification |
|-----------------|-------------------------------|
| **https://catalog.onliner.by/**\* | Injects the Watch price control on catalog product pages and may read page content as a fallback when resolving the current product’s title and price. |
| **https://catalog.api.onliner.by/**\* | Fetches public product JSON (including minimum price) for user-watched items during background and manual price checks. |

## Optional notes for the reviewer (not a form field)

- Only products the user explicitly watches are polled; there is no catalog-wide crawl.
- API fetches omit credentials; data stays on-device except for those Onliner requests.
