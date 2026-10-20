# Multi Currency Converter

An iPhone-calculator-style converter that shows **several currencies at once**, with no ads.

- Type in any row; every other row converts as you type. Supports `+ − × ÷ %` (e.g. `45+12.5`, `200+10%`).
- **Your saved currencies** (default VND, USD) stay until you remove them (Edit → Remove).
- **The local currency** is added automatically from the phone's time zone (marked 📍 HERE) and drops off when you leave the country. If the guess is wrong, use ＋ → "Use GPS".
- Add a friend's currency with ＋. It stays until you remove it.
- Works offline with the last downloaded rates; the header shows "Rates as of <date>" and turns red after 3 days.

## Accuracy
Rates are daily **mid-market** rates from [open.er-api.com](https://www.exchangerate-api.com/docs/free) (free, no key, includes VND).
Card foreign-transaction fees (~1–3%) and cash exchangers (often 3–8%) are **not** included.

## Install on iPhone
1. Host it (GitHub Pages: repo Settings → Pages → Deploy from branch `main`, folder `/root`).
2. Open the Pages URL in **Safari** → Share → **Add to Home Screen**.

## Run locally
`npx http-server -p 8123` then open http://localhost:8123.

`tz-map.js` is generated: `node tools/build-tz-map.mjs > tz-map.js`.
