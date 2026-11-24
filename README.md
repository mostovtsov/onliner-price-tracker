# Onliner Price Tracker

Chrome extension (Manifest V3) that watches product prices on [catalog.onliner.by](https://catalog.onliner.by), stores a local price history, shows a small chart in the popup, and notifies you when a price drops.

## Install (Load unpacked)

1. Clone or download this repository.
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this project folder (the one that contains `manifest.json`).
5. Open any product page on `https://catalog.onliner.by/.../.../...` and use the **Следить за ценой** / **Watch price** button (bottom-right).
6. Open the extension popup to see watched products and charts. Allow notifications when Chrome asks.

UI strings are localized with `chrome.i18n` (`_locales/ru` default, `_locales/en` optional). Chrome picks the locale from the browser language and falls back to Russian.

## What it does (v1)

- **Watch / unwatch** (`Следить за ценой` / `Не следить`) on catalog product pages (user-initiated only).
- **Background checks** via `chrome.alarms` every **3 hours** (also a manual **Проверить сейчас** in the popup).
- Prices come from the public product API `https://catalog.api.onliner.by/products/{key}` (`prices.price_min`), with DOM/JSON-LD fallback on the page.
- **History** and watches live in `chrome.storage.local` (up to 200 points per product).
- **Canvas chart** in the popup (no chart library).
- **Chrome notification** when the latest min price is lower than the previous stored price.
- Requests are throttled (~1.5s between products) to avoid aggressive scraping.

## Permissions

- `storage` — watches + history
- `alarms` — periodic checks
- `notifications` — price-drop alerts
- Host access: `catalog.onliner.by`, `catalog.api.onliner.by`

## Privacy / etiquette

Only products you explicitly watch are checked. There is no bulk crawl of the catalog. Interval and per-request delay keep load modest; please keep the interval at 1–6 hours if you fork this project.

## Development

Vanilla JS, no build step. Edit files under `src/` and click **Reload** on `chrome://extensions/`.

## Publish to Chrome Web Store

Prepared listing copy, privacy policy, permission justifications, screenshots, and a release zip live under `store/` and `dist/`. Follow the step-by-step upload guide:

→ **[store/CHECKLIST.md](store/CHECKLIST.md)**

| Artifact | Path |
|----------|------|
| Release zip (upload this) | `dist/onliner-price-tracker.zip` |
| Rebuild zip | `./scripts/build-zip.sh` |
| EN / RU listing text | `store/listing-en.md`, `store/listing-ru.md` |
| Permission justifications | `store/PERMISSIONS_JUSTIFICATION.md` |
| Privacy policy (markdown) | `store/privacy-policy.md` |
| Privacy policy (hostable HTML) | `docs/privacy.html` |
| Screenshots (1280×800) | `store/screenshots/` |

### Privacy policy URL (GitHub Pages)

1. GitHub repo → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, folder: `/docs`
4. After Pages is live, use:

`https://mostovtsov.github.io/onliner-price-tracker/privacy.html`

(Site root `https://mostovtsov.github.io/onliner-price-tracker/` redirects to the same policy.)

You still need to: register a Chrome Web Store developer account, enable Pages if needed, upload the zip, paste listing fields, and submit for review.
