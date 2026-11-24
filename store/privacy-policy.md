# Privacy Policy — Onliner Price Tracker

**Last updated:** 24 November 2026 (Europe/Minsk)  
**Developer:** Alexander Mostovtsov  
**Extension:** Onliner Price Tracker (Chrome, Manifest V3)  
**Repository:** https://github.com/mostovtsov/onliner-price-tracker

This policy describes what the Onliner Price Tracker Chrome extension (“the Extension”) does with data when you install and use it.

## Summary

- Watched products and price history are stored **only on your device** in `chrome.storage.local`.
- Network requests go **only** to Onliner’s catalog hosts to fetch prices for products **you** chose to watch.
- The Extension does **not** collect accounts, analytics, advertising IDs, or sell/share personal data with third parties.
- Price-drop alerts use **Chrome notifications** on your computer.

## Data stored on your device

When you click **Watch price** on a product page, the Extension saves in `chrome.storage.local` (under the key `watches`):

- Product key / identifiers needed to check that product again
- Title, product URL, optional image URL
- Currency and price history points (timestamp + amount; capped, currently up to 200 points per product)
- Last checked time and last known price
- Optional last error message from a failed check

This data never leaves your browser storage except as needed for the network requests described below. Uninstalling the Extension or clearing extension storage removes it according to Chrome’s normal behavior.

## Network requests

The Extension contacts:

| Host | Purpose |
|------|---------|
| `https://catalog.onliner.by/*` | Content script on product pages; optional page/DOM fallback for title/price |
| `https://catalog.api.onliner.by/*` | Background and on-page fetches of public product JSON (`/products/{key}`), including minimum price |

Requests use ordinary HTTPS fetches without sending cookies for the API call (`credentials: "omit"` on the product API fetch). Only products you explicitly watch (or the page you currently have open when resolving that product) are queried. There is no bulk crawl of the catalog. Checks run on a timer (about every 3 hours) and can be triggered manually from the popup; requests are spaced (~1.5 seconds between products).

No other third-party hosts, analytics endpoints, or tracking pixels are used by the Extension.

## Notifications

If a new minimum price is lower than the previously stored price for a watched product, the Extension may show a **Chrome notification** on your device (title/message describing the drop). Notification permission is handled by Chrome; you can disable notifications in Chrome settings.

## What we do not do

- No user accounts or sign-in
- No collection of your name, email, payment details, or browsing history beyond the product pages/API needed for watches you create
- No selling, renting, or sharing of personal data with advertisers or data brokers
- No remote logging of your watch list to servers controlled by the Extension developer

## Permissions (why they exist)

- **storage** — save watches and history locally  
- **alarms** — schedule periodic price checks  
- **notifications** — alert you when a price drops  
- **Host access** to `catalog.onliner.by` and `catalog.api.onliner.by` — read product pages and fetch public price data  

## Children

The Extension is not directed at children under 13 and does not knowingly collect children’s personal information.

## Changes

If this policy changes in a material way, the updated text will be published at the same privacy URL (GitHub Pages) and the “Last updated” date will change. Continued use after an update means you accept the revised policy for future use.

## Contact

Questions about this policy: open an issue at  
https://github.com/mostovtsov/onliner-price-tracker/issues  
or contact the repository owner via GitHub.
