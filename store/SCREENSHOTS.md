# Screenshots for Chrome Web Store

## Included placeholders (ready to upload)

| File | Size | Shows |
|------|------|--------|
| `store/screenshots/01-popup-chart.png` | 1280×800 | Promo of the popup with price history charts |
| `store/screenshots/02-watch-button.png` | 1280×800 | Promo of the product-page **Watch price** control |

These were generated from `scripts/promo-*.html` via headless Chrome. They meet store size requirements so the listing is not blocked.

## Regenerate placeholders

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --window-size=1280,800 \
  --screenshot=store/screenshots/01-popup-chart.png \
  "file://$PWD/scripts/promo-popup.html"

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --window-size=1280,800 \
  --screenshot=store/screenshots/02-watch-button.png \
  "file://$PWD/scripts/promo-watch.html"
```

## Optional: capture from the real extension

Store reviewers accept promo art; live shots look more authentic.

1. Load unpacked (repo root with `manifest.json`) at `chrome://extensions/`.
2. Open a product on `https://catalog.onliner.by/.../.../...` → click **Watch price**.
3. Open the extension popup (with at least one watched item and a chart).
4. Capture at **1280×800** or **640×400** (macOS Screenshot → capture window, or a screen tool set to that size).
5. Suggested shot list:
   - Popup with 1–2 watches and visible chart
   - Catalog product page with the Watch / Unwatch button visible
   - (Optional) Chrome notification after a price drop (harder to stage)

Replace files under `store/screenshots/` with the same names before re-upload if you want live captures.
