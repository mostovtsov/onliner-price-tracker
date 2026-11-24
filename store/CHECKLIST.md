# Chrome Web Store upload checklist

Do this **after** you have a [Chrome Web Store developer account](https://chrome.google.com/webstore/devconsole) ($5 one-time registration fee).

## 0. Before you open the console

1. Confirm the release zip exists:
   - Path: `dist/onliner-price-tracker.zip` (from repo root)
   - Rebuild anytime: `./scripts/build-zip.sh`
2. Publish the privacy policy page (GitHub Pages):
   - Repo Settings → Pages → Source: **Deploy from a branch**
   - Branch: `main`, folder: `/docs`
   - Privacy URL to paste in the store:
     - `https://mostovtsov.github.io/onliner-price-tracker/privacy.html`
3. Have ready:
   - Listing text from `store/listing-ru.md` (primary) and optionally `store/listing-en.md`
   - Permission sentences from `store/PERMISSIONS_JUSTIFICATION.md`
   - Screenshots from `store/screenshots/` — prefer `*-ru.png` (1280×800)
   - Store icon: `icons/icon128.png` (128×128)

## 1. Create the item

1. Open https://chrome.google.com/webstore/devconsole
2. **New item** → upload `dist/onliner-price-tracker.zip`
3. Wait for the package to validate (manifest, icons, permissions).

## 2. Store listing

| Field | Source |
|-------|--------|
| Language | Russian (primary; add English if desired) |
| Product name / short name | `Onliner Price Tracker` / `Трекер цен Onliner` (`store/listing-ru.md`) |
| Summary | Summary block in `store/listing-ru.md` (≤132 chars) |
| Description | Detailed description in `store/listing-ru.md` |
| Category | Shopping (or Productivity) |
| Language | Russian / English as applicable |

Optional: add English and paste from `store/listing-en.md`.

## 3. Graphic assets

| Asset | File |
|-------|------|
| Store icon (128×128) | `icons/icon128.png` |
| Screenshot 1 (required) | `store/screenshots/01-popup-chart-ru.png` |
| Screenshot 2 (recommended) | `store/screenshots/02-watch-button-ru.png` |

Screenshots must be **1280×800** or **640×400**. Placeholders are promotional mockups; replace with live captures later if you want (see `store/SCREENSHOTS.md`).

## 4. Privacy

| Field | Value |
|-------|--------|
| Single purpose | Track user-selected Onliner catalog product prices locally and notify on drops |
| Privacy policy URL | `https://mostovtsov.github.io/onliner-price-tracker/privacy.html` |
| Data usage / certifications | No sale of data; no transfer for advertising; storage is local only |

Paste permission justifications from `store/PERMISSIONS_JUSTIFICATION.md` when the form asks for each permission / host.

## 5. Distribution

- Visibility: **Public** (or Unlisted for a private test)
- Regions: as you prefer (include Belarus / worldwide)

## 6. Submit for review

1. Save draft
2. **Submit for review**
3. Wait for Google’s review email (can take several days)

## Zip contents (what Chrome receives)

Only extension runtime files — **not** `store/`, `docs/`, `scripts/`, `.git`, or this checklist:

- `manifest.json` (`default_locale`: `ru`)
- `src/` (all extension JS/CSS/HTML)
- `icons/` (`icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`)
- `_locales/` (`ru/messages.json`, optional `en/messages.json`)

## What you still do manually

1. Pay / register the Chrome Web Store developer account  
2. Enable GitHub Pages (`/docs` on `main`) if the privacy URL is not live yet  
3. Upload the zip and paste listing / privacy / permission text  
4. Submit for review  

Everything else in this repository is prepared for copy-paste.
