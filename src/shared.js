/**
 * Shared helpers for Onliner Price Tracker (content script + popup + background).
 * Loaded as a classic script; attaches to globalThis.OnlinerPT.
 */
(function (global) {
  "use strict";

  const CHECK_ALARM = "onliner-price-check";
  /** Default background price check interval (hours). */
  const CHECK_INTERVAL_HOURS = 3;
  const CHECK_PERIOD_MINUTES = CHECK_INTERVAL_HOURS * 60;
  const ALLOWED_INTERVAL_HOURS = [1, 3, 6, 12, 24];
  /** Delay between product fetches during a check run (ms). */
  const FETCH_GAP_MS = 1500;
  /** Per-attempt timeout for catalog API requests (ms). */
  const FETCH_TIMEOUT_MS = 10000;
  /** Number of retries after an initial transient API failure. */
  const FETCH_MAX_RETRIES = 2;
  /** Initial backoff delay before first retry (ms); doubles each attempt. */
  const FETCH_RETRY_DELAY_MS = 1000;
  /** Upper bound for retry backoff / Retry-After wait (ms). */
  const FETCH_MAX_RETRY_DELAY_MS = 15000;
  const HISTORY_LIMIT = 200;
  const STORAGE_KEY = "watches";
  const SETTINGS_KEY = "settings";
  const LAST_CHECK_KEY = "lastCheckAt";
  const NOTIFICATION_URLS_KEY = "notificationUrls";
  const UNREAD_DROPS_KEY = "unreadDropKeys";
  const NOTIFICATION_MAP_LIMIT = 100;
  const BADGE_DROP_COLOR = "#047857";
  const BADGE_TEXT_COLOR = "#ffffff";
  const BACKUP_APP_ID = "onliner-price-tracker";
  const BACKUP_SCHEMA_VERSION = 1;
  const PRICE_EPSILON = 0.009;

  const API_BASE = "https://catalog.api.onliner.by/products/";
  const PRODUCT_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/i;
  const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  const EXCLUDED_PRODUCT_SUBPAGES = new Set([
    "reviews",
    "prices",
    "used",
    "forum",
  ]);
  const RESERVED_SEGMENTS = new Set([
    "reviews",
    "prices",
    "used",
    "forum",
    "photos",
    "edit",
  ]);
  const RESERVED_CATEGORIES = new Set([
    ...RESERVED_SEGMENTS,
    "search",
    "user",
    "compare",
    "cart",
    "order",
    "news",
    "prime",
    "b2b",
    "sdapi",
    "promo",
  ]);

  function isPlainObject(value) {
    return (
      value != null &&
      typeof value === "object" &&
      !Array.isArray(value)
    );
  }

  function isCatalogOnlinerUrl(urlString) {
    if (typeof urlString !== "string" || !urlString.trim()) return null;
    try {
      const url = new URL(urlString);
      if (url.protocol !== "https:" || url.hostname !== "catalog.onliner.by") {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  function isSafeHttpsUrl(urlString) {
    if (typeof urlString !== "string" || !urlString.trim()) return null;
    try {
      const url = new URL(urlString);
      if (url.protocol !== "https:") return null;
      return url.href;
    } catch {
      return null;
    }
  }

  /**
   * Product page URL shape: /{category}/{manufacturer}/{key}
   * Optional trailing segments (reviews, prices, …) are captured as `subpage`.
   */
  function parseProductUrl(urlString) {
    let url;
    try {
      url = new URL(urlString, "https://catalog.onliner.by");
    } catch {
      return null;
    }
    if (url.hostname !== "catalog.onliner.by") return null;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3) return null;

    const category = parts[0];
    const manufacturer = parts[1];
    const key = parts[2];
    const subpage = parts[3] || null;

    if (RESERVED_SEGMENTS.has(key.toLowerCase())) return null;
    if (!PRODUCT_KEY_RE.test(key)) return null;
    if (RESERVED_CATEGORIES.has(category.toLowerCase())) {
      return null;
    }

    return {
      key,
      category,
      manufacturer,
      subpage,
      url: `https://catalog.onliner.by/${category}/${manufacturer}/${key}`,
    };
  }

  /**
   * Like parseProductUrl, but returns null on subpages where the floating
   * watch button should stay hidden (reviews, prices, used, forum).
   */
  function parseProductPageUrl(urlString) {
    const ref = parseProductUrl(urlString);
    if (!ref) return null;
    if (
      ref.subpage &&
      EXCLUDED_PRODUCT_SUBPAGES.has(ref.subpage.toLowerCase())
    ) {
      return null;
    }
    return ref;
  }

  function parseAmount(value) {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const n = parseFloat(String(value).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Parses user-entered target price.
   * Empty/null -> null (cleared), valid > 0 -> rounded to 2 decimals, invalid -> NaN.
   */
  function parseTargetPrice(value) {
    if (value == null) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const n = parseAmount(value);
    if (n == null || !Number.isFinite(n) || n <= 0) return NaN;
    return Math.round(n * 100) / 100;
  }

  function isRetryableStatus(status) {
    return status === 408 || status === 429 || (status >= 500 && status <= 599);
  }

  function parseRetryAfterMs(headerValue) {
    if (!headerValue) return null;
    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, FETCH_MAX_RETRY_DELAY_MS);
    }
    const dateMs = Date.parse(headerValue);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta > 0) return Math.min(delta, FETCH_MAX_RETRY_DELAY_MS);
    }
    return null;
  }

  function decodeHtmlEntities(str) {
    if (typeof str !== "string" || !str) return "";
    return str
      .replace(/&nbsp;|&#160;|&#xa0;|&thinsp;|&ensp;|&emsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_m, dec) => {
        const code = Number(dec);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      })
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      });
  }

  function detectCurrency(text, fallback = null) {
    if (typeof text !== "string" || !text) return fallback;
    if (/\bBYN\b|р\.|руб/i.test(text)) return "BYN";
    if (/\bUSD\b|\$/i.test(text)) return "USD";
    if (/\bEUR\b|€/i.test(text)) return "EUR";
    if (/\bRUB\b|₽/i.test(text)) return "RUB";
    return fallback;
  }

  /**
   * Extracts a positive price and optional currency from free-form scraped
   * HTML/DOM text (e.g. "от 2 999,50 р.", "2&nbsp;999,00 BYN", "1499.99").
   */
  function parsePriceText(raw) {
    if (typeof raw === "number") {
      return Number.isFinite(raw) && raw > 0
        ? { price: raw, currency: null }
        : { price: null, currency: null };
    }
    if (typeof raw !== "string" || !raw.trim()) {
      return { price: null, currency: null };
    }
    const cleaned = decodeHtmlEntities(raw).replace(/[\u00a0\u2009\u202f]/g, " ").trim();
    const match = cleaned.match(
      /(?:^|[^\d-])(\d{1,3}(?: \d{3})+|\d+)(?:[.,](\d{1,2}))?(?!\d)/
    );
    if (!match) {
      return { price: null, currency: detectCurrency(cleaned, null) };
    }
    const intPart = match[1].replace(/\s+/g, "");
    const fracPart = match[2] ? `.${match[2]}` : "";
    const n = parseFloat(`${intPart}${fracPart}`);
    return {
      price: Number.isFinite(n) && n > 0 ? n : null,
      currency: detectCurrency(cleaned, null),
    };
  }

  function cleanProductTitle(raw) {
    if (typeof raw !== "string") return "";
    return decodeHtmlEntities(raw)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+купить.*$/i, "")
      .trim();
  }

  /**
   * Fetch JSON or text with a per-attempt AbortController timeout and
   * exponential backoff retries on timeouts, network errors, 408, 429, and 5xx.
   */
  async function fetchWithRetry(url, options = {}) {
    const {
      timeoutMs = FETCH_TIMEOUT_MS,
      maxRetries = FETCH_MAX_RETRIES,
      retryDelayMs = FETCH_RETRY_DELAY_MS,
      fetchOptions = {},
      responseType = "json",
    } = options;

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let retryAfterMs = null;
      try {
        const res = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = new Error(t("apiHttpError", [String(res.status)]));
          err.status = res.status;
          err.retryable = isRetryableStatus(res.status);
          if (res.status === 429) {
            retryAfterMs = parseRetryAfterMs(res.headers?.get?.("Retry-After"));
          }
          throw err;
        }

        if (responseType === "text") {
          return await res.text();
        }
        try {
          return await res.json();
        } catch (parseErr) {
          const err = new Error(t("apiInvalidResponse"));
          err.code = "INVALID_JSON";
          err.cause = parseErr;
          err.retryable = false;
          throw err;
        }
      } catch (err) {
        if (err && err.retryable === false) {
          throw err;
        }

        let normalized = err;
        if (timedOut || err?.name === "AbortError") {
          normalized = new Error(t("apiTimeout"));
          normalized.code = "TIMEOUT";
          normalized.retryable = true;
        } else if (err?.status == null) {
          normalized = new Error(t("apiNetworkError"));
          normalized.code = "NETWORK";
          normalized.cause = err;
          normalized.retryable = true;
        }
        lastError = normalized;

        if (attempt >= maxRetries) {
          throw normalized;
        }
      } finally {
        clearTimeout(timer);
      }

      const backoffMs = Math.min(
        retryDelayMs * Math.pow(2, attempt),
        FETCH_MAX_RETRY_DELAY_MS
      );
      await sleep(Math.max(backoffMs, retryAfterMs || 0));
    }

    throw lastError || new Error(t("apiNetworkError"));
  }

  /**
   * Fetch JSON with a per-attempt AbortController timeout and exponential
   * backoff retries on timeouts, network errors, 408, 429, and 5xx responses.
   */
  async function fetchJsonWithRetry(url, options = {}) {
    return fetchWithRetry(url, { ...options, responseType: "json" });
  }

  /**
   * Fetch text/HTML reusing the shared timeout and retry/backoff helper.
   */
  async function fetchTextWithRetry(url, options = {}) {
    return fetchWithRetry(url, { ...options, responseType: "text" });
  }

  function extractAlternateApiPrice(data) {
    if (!isPlainObject(data)) return { price: null, currency: null };
    const candidates = [
      data.prices?.min_price,
      data.prices?.min,
      data.prices?.price,
      data.prices?.offers?.min_price,
      data.price_min,
      data.min_price,
      data.price,
    ];
    for (const candidate of candidates) {
      if (isPlainObject(candidate)) {
        const amount = parseAmount(candidate.amount ?? candidate.value ?? candidate.min);
        if (amount != null && amount > 0) {
          return {
            price: amount,
            currency:
              typeof candidate.currency === "string" && candidate.currency.trim()
                ? candidate.currency.trim()
                : null,
          };
        }
      } else {
        const amount = parseAmount(candidate);
        if (amount != null && amount > 0) {
          return { price: amount, currency: null };
        }
      }
    }
    return { price: null, currency: null };
  }

  /**
   * Normalize a catalog.api.onliner.by product JSON payload.
   *
   * Distinguishes between:
   * - Explicit unavailable (`prices: null`, `prices.offers.count === 0`, or
   *   canonical `prices` object with `price_min: null`) -> `unavailable: true`.
   * - Unrecognized / changed API shape (`prices` key absent or non-object
   *   with no alternate price fields) -> `shapeChanged: true` so callers can
   *   fall back to HTML/DOM scraping without falsely marking out-of-stock.
   */
  function extractProductFromApiPayload(key, data, fetchedAt = Date.now()) {
    if (!isPlainObject(data)) {
      return {
        key,
        id: null,
        title: key,
        price: null,
        currency: "BYN",
        url: null,
        image: null,
        offersCount: null,
        unavailable: false,
        unavailableReason: null,
        shapeChanged: true,
        source: "api",
        fetchedAt,
      };
    }

    const hasPricesKey = Object.prototype.hasOwnProperty.call(data, "prices");
    const pricesObj = isPlainObject(data.prices) ? data.prices : null;
    const offersCount = pricesObj?.offers?.count ?? null;
    const canonicalMin = parseAmount(pricesObj?.price_min?.amount);
    const hasCanonicalPricesShape =
      pricesObj != null &&
      (Object.prototype.hasOwnProperty.call(pricesObj, "price_min") ||
        Object.prototype.hasOwnProperty.call(pricesObj, "offers"));

    let price = null;
    let currency =
      pricesObj?.price_min?.currency ||
      data?.sale?.min_prices_median?.currency ||
      "BYN";
    let unavailable = false;
    let shapeChanged = false;
    let source = "api";

    if (hasPricesKey && data.prices === null) {
      unavailable = true;
    } else if (offersCount === 0) {
      unavailable = true;
    } else if (canonicalMin != null) {
      price = canonicalMin;
    } else {
      const alt = extractAlternateApiPrice(data);
      if (alt.price != null) {
        price = alt.price;
        if (alt.currency) currency = alt.currency;
        source = "api-fallback";
      } else if (hasCanonicalPricesShape) {
        unavailable = true;
      } else {
        shapeChanged = true;
      }
    }

    const title =
      data?.extended_name ||
      data?.full_name ||
      data?.name ||
      key;
    const htmlUrl = data?.html_url || null;
    const image = data?.images?.header || null;

    return {
      key: data?.key || key,
      id: data?.id ?? null,
      title,
      price,
      currency,
      url: htmlUrl,
      image,
      offersCount,
      unavailable,
      unavailableReason: unavailable ? "no_offers" : null,
      shapeChanged,
      source,
      fetchedAt,
    };
  }

  /**
   * Fetch product snapshot from the public catalog API.
   * Marks product unavailable when `prices` is null, `price_min` is missing
   * in a canonical `prices` object, or `prices.offers.count === 0`.
   */
  async function fetchProduct(key, options = {}) {
    const data = await fetchJsonWithRetry(
      `${API_BASE}${encodeURIComponent(key)}`,
      {
        ...options,
        fetchOptions: {
          headers: { Accept: "application/json" },
          credentials: "omit",
          cache: "no-store",
          ...(options.fetchOptions || {}),
        },
      }
    );
    return extractProductFromApiPayload(key, data, Date.now());
  }

  function extractJsonLdImage(rawImage) {
    if (typeof rawImage === "string") return isSafeHttpsUrl(rawImage);
    if (Array.isArray(rawImage)) {
      for (const entry of rawImage) {
        const found = extractJsonLdImage(entry);
        if (found) return found;
      }
      return null;
    }
    if (isPlainObject(rawImage)) {
      return isSafeHttpsUrl(rawImage.url || rawImage.contentUrl || "");
    }
    return null;
  }

  function collectJsonLdNodes(raw, out = []) {
    if (Array.isArray(raw)) {
      for (const item of raw) collectJsonLdNodes(item, out);
      return out;
    }
    if (!isPlainObject(raw)) return out;
    out.push(raw);
    if (Array.isArray(raw["@graph"])) {
      collectJsonLdNodes(raw["@graph"], out);
    }
    if (isPlainObject(raw.mainEntity)) {
      collectJsonLdNodes(raw.mainEntity, out);
    }
    return out;
  }

  function flattenJsonLdOffers(rawOffers, out = []) {
    if (Array.isArray(rawOffers)) {
      for (const item of rawOffers) flattenJsonLdOffers(item, out);
      return out;
    }
    if (!isPlainObject(rawOffers)) return out;
    out.push(rawOffers);
    if (Array.isArray(rawOffers.offers)) {
      flattenJsonLdOffers(rawOffers.offers, out);
    }
    return out;
  }

  /**
   * Extracts product metadata and lowest offer price from parsed JSON-LD blocks.
   * Supports single Product nodes, arrays, `@graph`, `mainEntity`, array `@type`,
   * single Offer/AggregateOffer, and Offer arrays.
   */
  function extractProductFromJsonLdObjects(rawObjects, urlKey = null) {
    let title = null;
    let price = null;
    let currency = null;
    let image = null;
    let url = null;
    let sawOutOfStock = false;
    let sawInStock = false;

    for (const raw of rawObjects || []) {
      const nodes = collectJsonLdNodes(raw);
      for (const item of nodes) {
        const type = item["@type"];
        const isProduct =
          type === "Product" ||
          (Array.isArray(type) && type.includes("Product"));
        if (!isProduct) continue;

        if (urlKey && item.url) {
          const ldKey = parseProductUrl(String(item.url))?.key;
          if (ldKey && ldKey !== urlKey) continue;
        }

        if (!title && typeof item.name === "string" && item.name.trim()) {
          title = cleanProductTitle(item.name);
        }
        if (!image) {
          image = extractJsonLdImage(item.image);
        }
        if (!url && typeof item.url === "string") {
          url = isCatalogOnlinerUrl(item.url);
        }

        const offers = flattenJsonLdOffers(item.offers);
        for (const offer of offers) {
          const availability = String(offer.availability || "");
          if (/OutOfStock|Discontinued|SoldOut/i.test(availability)) {
            sawOutOfStock = true;
          } else if (/InStock|PreOrder|LimitedAvailability/i.test(availability)) {
            sawInStock = true;
          }
          if (Number(offer.offerCount) === 0) {
            sawOutOfStock = true;
          }

          const spec = isPlainObject(offer.priceSpecification)
            ? offer.priceSpecification
            : null;
          const rawCandidates = [
            offer.lowPrice,
            offer.price,
            spec?.minPrice,
            spec?.price,
          ];
          for (const rawCandidate of rawCandidates) {
            const parsed = parsePriceText(rawCandidate);
            if (parsed.price != null && parsed.price > 0) {
              if (price == null || parsed.price < price) {
                price = parsed.price;
                currency =
                  offer.priceCurrency ||
                  spec?.priceCurrency ||
                  parsed.currency ||
                  currency;
              }
              break;
            }
          }
          if (!currency && (offer.priceCurrency || spec?.priceCurrency)) {
            currency = offer.priceCurrency || spec?.priceCurrency;
          }
        }
      }
    }

    const unavailable = price == null && sawOutOfStock && !sawInStock;
    return {
      title,
      price,
      currency,
      image,
      url,
      unavailable,
    };
  }

  /**
   * Live-page DOM fallback for the content script when API fails or changes shape.
   *
   * Fallback extraction order:
   * 1. JSON-LD (`<script type="application/ld+json">`, Product + Offers)
   * 2. Structured meta / microdata tags (`product:price:amount`, `og:price:amount`, `itemprop="price"`)
   * 3. Catalog page DOM price selectors (`.js-description-price-link`, `.offers-description__link_nodecor`, `.product-aside__price`, etc.)
   */
  function scrapeProductFromDom(doc = document) {
    const pageUrl = doc.location?.href || "";
    const parsedRef = parseProductUrl(pageUrl);
    const urlKey = parsedRef?.key || null;
    const metaId = doc.querySelector('meta[name="product-id"]');
    const key =
      urlKey ||
      metaId?.getAttribute("content") ||
      metaId?.getAttribute("product-id") ||
      null;

    let title = cleanProductTitle(
      doc.querySelector("h1")?.textContent ||
        doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
        doc.title ||
        ""
    );
    let image = isSafeHttpsUrl(
      doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
        ""
    );
    let price = null;
    let currency = "BYN";
    let unavailable = false;
    let source = null;

    // Step 1: JSON-LD Product schema
    const ldObjects = [];
    const ldScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const el of ldScripts) {
      try {
        ldObjects.push(JSON.parse(el.textContent || "null"));
      } catch {
        /* ignore malformed JSON-LD */
      }
    }
    const ld = extractProductFromJsonLdObjects(ldObjects, urlKey);
    if (!title && ld.title) title = ld.title;
    if (!image && ld.image) image = ld.image;
    if (ld.price != null) {
      price = ld.price;
      currency = ld.currency || currency;
      source = "dom-jsonld";
    } else if (ld.unavailable) {
      unavailable = true;
      source = "dom-jsonld";
    }

    // Step 2: Structured meta / microdata tags
    if (price == null) {
      const metaPriceSelectors = [
        'meta[property="product:price:amount"]',
        'meta[property="og:price:amount"]',
        'meta[itemprop="price"]',
        'meta[name="price"]',
        '[itemprop="price"]',
      ];
      for (const selector of metaPriceSelectors) {
        const el = doc.querySelector(selector);
        if (!el) continue;
        const rawVal =
          el.getAttribute?.("content") || el.textContent || "";
        const parsed = parsePriceText(rawVal);
        if (parsed.price != null) {
          price = parsed.price;
          currency =
            doc
              .querySelector(
                'meta[property="product:price:currency"], meta[property="og:price:currency"], meta[itemprop="priceCurrency"], [itemprop="priceCurrency"]'
              )
              ?.getAttribute?.("content") ||
            parsed.currency ||
            currency;
          unavailable = false;
          source = "dom-meta";
          break;
        }
      }
    }

    // Step 3: Catalog page DOM price selectors
    if (price == null) {
      const domPriceSelectors = [
        ".js-description-price-link .h_txt_ell",
        ".js-description-price-link",
        ".offers-description__link_nodecor",
        ".product-aside__price",
        '[class*="price"] .h_txt_ell',
      ];
      for (const selector of domPriceSelectors) {
        const el = doc.querySelector(selector);
        if (!el) continue;
        const parsed = parsePriceText(el.textContent || "");
        if (parsed.price != null) {
          price = parsed.price;
          currency = parsed.currency || currency;
          unavailable = false;
          source = "dom-selector";
          break;
        }
      }
    }

    return {
      key,
      title,
      price,
      currency,
      image,
      url: ld.url || parsedRef?.url || null,
      unavailable,
      source,
    };
  }

  function parseHtmlAttributes(tagText) {
    const attrs = {};
    const attrRe =
      /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let match;
    while ((match = attrRe.exec(tagText)) !== null) {
      const name = match[1].toLowerCase();
      const val = match[2] ?? match[3] ?? match[4] ?? "";
      attrs[name] = decodeHtmlEntities(val);
    }
    return attrs;
  }

  /**
   * HTML-string fallback parser for service workers (where DOMParser is
   * unavailable). Mirrors `scrapeProductFromDom` extraction order:
   * 1. JSON-LD (`<script type="application/ld+json">`)
   * 2. Structured `<meta>` / `itemprop="price"` tags
   * 3. Catalog HTML price container selectors
   */
  function scrapeProductFromHtml(html, { url = null, key = null } = {}) {
    const safeUrl = isCatalogOnlinerUrl(url);
    const parsedRef = safeUrl ? parseProductUrl(safeUrl) : null;
    const urlKey = parsedRef?.key || key || null;

    if (typeof html !== "string" || !html.trim()) {
      return {
        key: urlKey,
        title: "",
        price: null,
        currency: "BYN",
        image: null,
        url: safeUrl,
        unavailable: false,
        source: null,
      };
    }

    const metas = [];
    const metaRe = /<meta\b[^>]*>/gi;
    let m;
    while ((m = metaRe.exec(html)) !== null) {
      metas.push(parseHtmlAttributes(m[0]));
    }
    const findMeta = (attr, value) => {
      const target = value.toLowerCase();
      const hit = metas.find((item) => (item[attr] || "").toLowerCase() === target);
      return hit ? hit.content || "" : "";
    };

    const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    let title = cleanProductTitle(
      h1Match?.[1] || findMeta("property", "og:title") || titleMatch?.[1] || ""
    );
    let image = isSafeHttpsUrl(findMeta("property", "og:image"));
    let price = null;
    let currency = "BYN";
    let unavailable = false;
    let source = null;

    // Step 1: JSON-LD script blocks
    const ldObjects = [];
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    while ((m = scriptRe.exec(html)) !== null) {
      const attrs = parseHtmlAttributes(m[1] || "");
      const type = (attrs.type || "").toLowerCase();
      if (!type.includes("application/ld+json")) continue;
      try {
        ldObjects.push(JSON.parse(m[2] || "null"));
      } catch {
        /* ignore malformed JSON-LD */
      }
    }
    const ld = extractProductFromJsonLdObjects(ldObjects, urlKey);
    if (!title && ld.title) title = ld.title;
    if (!image && ld.image) image = ld.image;
    if (ld.price != null) {
      price = ld.price;
      currency = ld.currency || currency;
      source = "html-jsonld";
    } else if (ld.unavailable) {
      unavailable = true;
      source = "html-jsonld";
    }

    // Step 2: Structured meta / microdata price tags
    if (price == null) {
      const metaCandidates = [
        findMeta("property", "product:price:amount"),
        findMeta("property", "og:price:amount"),
        findMeta("itemprop", "price"),
        findMeta("name", "price"),
      ];
      const metaCurrency =
        findMeta("property", "product:price:currency") ||
        findMeta("property", "og:price:currency") ||
        findMeta("itemprop", "pricecurrency") ||
        null;

      for (const candidate of metaCandidates) {
        const parsed = parsePriceText(candidate);
        if (parsed.price != null) {
          price = parsed.price;
          currency = metaCurrency || parsed.currency || currency;
          unavailable = false;
          source = "html-meta";
          break;
        }
      }
    }

    if (price == null) {
      const itemPropRe =
        /<([a-z0-9]+)\b([^>]*\bitemprop\s*=\s*["']price["'][^>]*)>([\s\S]{0,120}?)<\/\1>/gi;
      while ((m = itemPropRe.exec(html)) !== null) {
        const attrs = parseHtmlAttributes(m[2] || "");
        const rawVal = attrs.content || m[3].replace(/<[^>]+>/g, " ");
        const parsed = parsePriceText(rawVal);
        if (parsed.price != null) {
          price = parsed.price;
          currency = parsed.currency || currency;
          unavailable = false;
          source = "html-microdata";
          break;
        }
      }
    }

    // Step 3: Known Onliner catalog HTML price containers
    if (price == null) {
      const containerRe =
        /<([a-z0-9]+)\b[^>]*class\s*=\s*["'][^"']*(?:js-description-price-link|offers-description__link_nodecor|product-aside__price)[^"']*["'][^>]*>([\s\S]{0,300}?)<\/\1>/gi;
      while ((m = containerRe.exec(html)) !== null) {
        const text = m[2].replace(/<[^>]+>/g, " ");
        const parsed = parsePriceText(text);
        if (parsed.price != null) {
          price = parsed.price;
          currency = parsed.currency || currency;
          unavailable = false;
          source = "html-selector";
          break;
        }
      }
    }

    return {
      key: urlKey,
      title,
      price,
      currency,
      image,
      url: ld.url || safeUrl,
      unavailable,
      source,
    };
  }

  /**
   * Fetch and parse a watched product's catalog HTML page as a secondary
   * fallback. Reuses shared timeout/retry helpers with conservative retry limit.
   */
  async function fetchProductFromPage(pageUrl, key, options = {}) {
    const safeUrl = isCatalogOnlinerUrl(pageUrl);
    if (!safeUrl) return null;

    const html = await fetchTextWithRetry(safeUrl, {
      timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
      maxRetries: Math.min(options.maxRetries ?? 1, 1),
      retryDelayMs: options.retryDelayMs ?? FETCH_RETRY_DELAY_MS,
      fetchOptions: {
        headers: { Accept: "text/html,application/xhtml+xml" },
        credentials: "omit",
        cache: "no-store",
        ...(options.pageFetchOptions || {}),
      },
    });

    const scraped = scrapeProductFromHtml(html, { url: safeUrl, key });
    if (scraped.price == null && !scraped.unavailable) {
      return null;
    }

    return {
      key: key || scraped.key,
      id: null,
      title: scraped.title || key,
      price: scraped.price,
      currency: scraped.currency || "BYN",
      url: scraped.url || safeUrl,
      image: scraped.image || null,
      offersCount: null,
      unavailable: Boolean(scraped.unavailable && scraped.price == null),
      unavailableReason:
        scraped.unavailable && scraped.price == null ? "no_offers" : null,
      shapeChanged: false,
      source: scraped.source || "html-fallback",
      fetchedAt: Date.now(),
    };
  }

  /**
   * Resilient product fetch for watched items.
   *
   * Fallback order:
   * 1. Public catalog JSON API (`https://catalog.api.onliner.by/products/{key}`)
   *    via `fetchJsonWithRetry` (timeout + exponential backoff retries):
   *    a) Canonical `prices.price_min.amount`
   *    b) Alternate JSON price fields if the API payload changed shape
   * 2. Watched product HTML page (`options.fallbackUrl` on `catalog.onliner.by`)
   *    via `fetchTextWithRetry` + `scrapeProductFromHtml` (JSON-LD -> meta/microdata -> HTML selectors):
   *    - Triggered ONLY when Step 1 fails with a non-404/410 error OR Step 1
   *      returned an unrecognized JSON shape (`shapeChanged: true`) without a price.
   *    - Skipped on HTTP 404/410 (delisted) and on explicit API `prices: null` /
   *      `offers.count === 0` (out of stock).
   *    - Skipped when no valid `catalog.onliner.by` URL is available.
   */
  async function fetchProductWithFallback(key, options = {}) {
    const { fallbackUrl = null, ...fetchOpts } = options;
    const safeFallbackUrl = isCatalogOnlinerUrl(fallbackUrl);

    let apiError = null;
    let apiSnapshot = null;

    try {
      apiSnapshot = await fetchProduct(key, fetchOpts);
      if (!apiSnapshot.shapeChanged) {
        return apiSnapshot;
      }
    } catch (err) {
      // HTTP 404/410 means the product was delisted; do not scrape HTML.
      if (err?.status === 404 || err?.status === 410) {
        throw err;
      }
      apiError = err;
    }

    if (safeFallbackUrl) {
      try {
        const pageSnapshot = await fetchProductFromPage(
          safeFallbackUrl,
          key,
          fetchOpts
        );
        if (pageSnapshot) {
          return {
            ...pageSnapshot,
            title:
              pageSnapshot.title && pageSnapshot.title !== key
                ? pageSnapshot.title
                : apiSnapshot?.title || key,
            image: pageSnapshot.image || apiSnapshot?.image || null,
            url: pageSnapshot.url || apiSnapshot?.url || safeFallbackUrl,
          };
        }
      } catch (pageErr) {
        if (pageErr?.status === 404 || pageErr?.status === 410) {
          throw pageErr;
        }
        /* preserve primary API error below when fallback page also fails */
      }
    }

    if (apiError) {
      throw apiError;
    }

    throw new Error(t("noPriceInApi"));
  }

  // Serialize read-modify-write storage ops within the same JS context.
  let storageQueue = Promise.resolve();
  function withStorageLock(fn) {
    const next = storageQueue.then(fn, fn);
    storageQueue = next.catch(() => {});
    return next;
  }

  function normalizeCheckIntervalHours(value) {
    const num = Number(value);
    if (ALLOWED_INTERVAL_HOURS.includes(num)) return num;
    return CHECK_INTERVAL_HOURS;
  }

  async function getSettings() {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = isPlainObject(result[SETTINGS_KEY]) ? result[SETTINGS_KEY] : {};
    return {
      checkIntervalHours: normalizeCheckIntervalHours(raw.checkIntervalHours),
    };
  }

  async function setSettings(patch) {
    return withStorageLock(async () => {
      const current = await getSettings();
      const next = {
        checkIntervalHours: normalizeCheckIntervalHours(
          patch && "checkIntervalHours" in patch
            ? patch.checkIntervalHours
            : current.checkIntervalHours
        ),
      };
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      return next;
    });
  }

  async function getLastCheckAt() {
    const result = await chrome.storage.local.get(LAST_CHECK_KEY);
    const val = result[LAST_CHECK_KEY];
    return typeof val === "number" && Number.isFinite(val) && val > 0
      ? val
      : null;
  }

  async function setLastCheckAt(timestamp = Date.now()) {
    await chrome.storage.local.set({ [LAST_CHECK_KEY]: timestamp });
  }

  /**
   * Returns true if there is at least one watched product and the last
   * recorded check is older than (or equal to) the configured interval.
   */
  function isCheckStale({
    lastCheckAt = null,
    watches = {},
    intervalHours = CHECK_INTERVAL_HOURS,
    now = Date.now(),
  } = {}) {
    const items = isPlainObject(watches) ? Object.values(watches) : [];
    if (items.length === 0) return false;

    const intervalMs = normalizeCheckIntervalHours(intervalHours) * 60 * 60 * 1000;
    if (typeof lastCheckAt === "number" && Number.isFinite(lastCheckAt) && lastCheckAt > 0) {
      return now - lastCheckAt >= intervalMs;
    }

    let latestWatchCheck = 0;
    for (const item of items) {
      const ts = item?.lastCheckedAt;
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
        return true;
      }
      if (ts > latestWatchCheck) latestWatchCheck = ts;
    }
    return latestWatchCheck <= 0 || now - latestWatchCheck >= intervalMs;
  }

  function parseNotificationKey(notificationId) {
    if (typeof notificationId !== "string") return null;
    const match = notificationId.match(/^(?:drop|target|delisted)-(.+)-\d+$/);
    return match ? match[1] : null;
  }

  async function saveNotificationTarget(notificationId, target) {
    if (!notificationId || !target) return;
    return withStorageLock(async () => {
      const result = await chrome.storage.local.get(NOTIFICATION_URLS_KEY);
      const map = isPlainObject(result[NOTIFICATION_URLS_KEY])
        ? { ...result[NOTIFICATION_URLS_KEY] }
        : {};
      map[notificationId] = {
        key: target.key || null,
        url: isCatalogOnlinerUrl(target.url) || null,
        createdAt: Date.now(),
      };
      const entries = Object.entries(map);
      if (entries.length > NOTIFICATION_MAP_LIMIT) {
        entries.sort((a, b) => (a[1]?.createdAt || 0) - (b[1]?.createdAt || 0));
        const trimmed = Object.fromEntries(
          entries.slice(entries.length - NOTIFICATION_MAP_LIMIT)
        );
        await chrome.storage.local.set({ [NOTIFICATION_URLS_KEY]: trimmed });
        return;
      }
      await chrome.storage.local.set({ [NOTIFICATION_URLS_KEY]: map });
    });
  }

  async function consumeNotificationTarget(notificationId) {
    if (!notificationId) return null;
    return withStorageLock(async () => {
      const result = await chrome.storage.local.get(NOTIFICATION_URLS_KEY);
      const map = isPlainObject(result[NOTIFICATION_URLS_KEY])
        ? { ...result[NOTIFICATION_URLS_KEY] }
        : {};
      const entry = map[notificationId] || null;
      if (entry) {
        delete map[notificationId];
        await chrome.storage.local.set({ [NOTIFICATION_URLS_KEY]: map });
      }
      return entry;
    });
  }

  async function removeNotificationTarget(notificationId) {
    if (!notificationId) return;
    return withStorageLock(async () => {
      const result = await chrome.storage.local.get(NOTIFICATION_URLS_KEY);
      const map = isPlainObject(result[NOTIFICATION_URLS_KEY])
        ? { ...result[NOTIFICATION_URLS_KEY] }
        : {};
      if (!(notificationId in map)) return;
      delete map[notificationId];
      await chrome.storage.local.set({ [NOTIFICATION_URLS_KEY]: map });
    });
  }

  async function getWatches() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const watches = result[STORAGE_KEY];
    return watches && typeof watches === "object" ? watches : {};
  }

  async function setWatches(watches) {
    await chrome.storage.local.set({ [STORAGE_KEY]: watches });
  }

  async function isWatched(key) {
    const watches = await getWatches();
    return Boolean(watches[key]);
  }

  function appendHistory(watch, price, at = Date.now()) {
    const history = Array.isArray(watch.history) ? watch.history.slice() : [];
    const last = history[history.length - 1];
    if (last && last.price === price) {
      // Same price: refresh timestamp on the last point only if far apart
      if (at - last.at < 30 * 60 * 1000) {
        return history;
      }
    }
    history.push({ price, at });
    if (history.length > HISTORY_LIMIT) {
      return history.slice(history.length - HISTORY_LIMIT);
    }
    return history;
  }

  /**
   * Decides whether to send a price alert and updates the anti-spam latch.
   *
   * Rule:
   * - If `watch.targetPrice` is set (> 0):
   *   - When `nextPrice <= targetPrice`: notify once (`type: "target"`), recording
   *     `targetNotifiedPrice = nextPrice`. On subsequent checks while still at/below
   *     target, only re-notify if `nextPrice` drops strictly below `targetNotifiedPrice`.
   *   - When `nextPrice > targetPrice`: do not notify, and reset `targetNotifiedPrice = null`
   *     so a later drop back to `<= targetPrice` triggers a fresh notification.
   * - If `watch.targetPrice` is not set:
   *   - Preserve default behavior: notify (`type: "drop"`) when `nextPrice < previousPrice`.
   */
  function evaluatePriceAlert(watch, previousPrice, nextPrice) {
    const hasTarget =
      typeof watch?.targetPrice === "number" &&
      Number.isFinite(watch.targetPrice) &&
      watch.targetPrice > 0;

    if (hasTarget) {
      if (nextPrice <= watch.targetPrice + PRICE_EPSILON) {
        const lastNotified =
          typeof watch.targetNotifiedPrice === "number" &&
          Number.isFinite(watch.targetNotifiedPrice)
            ? watch.targetNotifiedPrice
            : null;
        if (lastNotified == null || nextPrice < lastNotified - PRICE_EPSILON) {
          return {
            shouldNotify: true,
            type: "target",
            nextTargetNotifiedPrice: nextPrice,
          };
        }
        return {
          shouldNotify: false,
          type: null,
          nextTargetNotifiedPrice: lastNotified,
        };
      }
      return {
        shouldNotify: false,
        type: null,
        nextTargetNotifiedPrice: null,
      };
    }

    if (previousPrice != null && nextPrice < previousPrice - PRICE_EPSILON) {
      return {
        shouldNotify: true,
        type: "drop",
        nextTargetNotifiedPrice: null,
      };
    }
    return {
      shouldNotify: false,
      type: null,
      nextTargetNotifiedPrice: null,
    };
  }

  /**
   * Re-read storage and persist a single watched product if it is still
   * watched. Avoids resurrecting items removed concurrently mid-check.
   */
  async function updateWatchIfPresent(key, updater) {
    return withStorageLock(async () => {
      const watches = await getWatches();
      const existing = watches[key];
      if (!existing) {
        return { updated: false, watch: null, removed: true };
      }
      const next = updater({ ...existing });
      if (!next) {
        return { updated: false, watch: existing, removed: false };
      }
      watches[key] = next;
      await setWatches(watches);
      return { updated: true, watch: next, removed: false };
    });
  }

  async function setWatchTargetPrice(key, rawValue) {
    const parsed = parseTargetPrice(rawValue);
    if (Number.isNaN(parsed)) {
      throw new Error(t("targetPriceInvalid"));
    }
    return updateWatchIfPresent(key, (watch) => {
      watch.targetPrice = parsed;
      watch.targetNotifiedPrice = null;
      return watch;
    });
  }

  async function watchProduct(product) {
    if (!product?.key) throw new Error("Missing product key");
    return withStorageLock(async () => {
      const watches = await getWatches();
      const existing = watches[product.key] || {};
      const price = product.price;
      const now = product.fetchedAt || Date.now();
      const history =
        price != null
          ? appendHistory({ history: existing.history || [] }, price, now)
          : existing.history || [];
      const unavailable =
        price != null
          ? false
          : Boolean(product.unavailable ?? existing.unavailable);

      watches[product.key] = {
        key: product.key,
        title: product.title || existing.title || product.key,
        url: product.url || existing.url || null,
        image: product.image || existing.image || null,
        currency: product.currency || existing.currency || "BYN",
        lastPrice: price != null ? price : existing.lastPrice ?? null,
        lastCheckedAt: now,
        addedAt: existing.addedAt || Date.now(),
        targetPrice: existing.targetPrice ?? null,
        targetNotifiedPrice: existing.targetNotifiedPrice ?? null,
        unavailable,
        unavailableSince: unavailable
          ? existing.unavailableSince || now
          : null,
        unavailableReason: unavailable
          ? product.unavailableReason || existing.unavailableReason || "no_offers"
          : null,
        history,
      };
      await setWatches(watches);
      return watches[product.key];
    });
  }

  async function unwatchProduct(key) {
    return withStorageLock(async () => {
      const watches = await getWatches();
      if (!watches[key]) return false;
      delete watches[key];
      await setWatches(watches);
      return true;
    });
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatChartTick(timestamp, spanMs, singlePoint = false) {
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return "";
    const day = pad2(d.getDate());
    const month = pad2(d.getMonth() + 1);
    const hours = pad2(d.getHours());
    const mins = pad2(d.getMinutes());
    const yearShort = String(d.getFullYear()).slice(-2);

    if (singlePoint) {
      return `${day}.${month} ${hours}:${mins}`;
    }
    if (spanMs < 24 * 60 * 60 * 1000) {
      return `${hours}:${mins}`;
    }
    if (spanMs <= 180 * 24 * 60 * 60 * 1000) {
      return `${day}.${month}`;
    }
    return `${day}.${month}.${yearShort}`;
  }

  /**
   * Computes time-proportional coordinates, long-gap segments, and readable
   * X-axis date/time ticks for the canvas price chart.
   */
  function computeChartLayout(history, options = {}) {
    const {
      width = 340,
      height = 92,
      maxPoints = 60,
      padLeft = 8,
      padRight = 8,
      padTop = 10,
      padBottom = 18,
    } = options;

    const plotLeft = padLeft;
    const plotRight = Math.max(padLeft + 1, width - padRight);
    const plotTop = padTop;
    const plotBottom = Math.max(padTop + 1, height - padBottom);
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    const validPricePoints = (Array.isArray(history) ? history : []).filter(
      (p) => p && typeof p.price === "number" && Number.isFinite(p.price)
    );

    if (validPricePoints.length === 0) {
      return {
        points: [],
        segments: [],
        ticks: [],
        minPrice: 0,
        maxPrice: 0,
        minAt: 0,
        maxAt: 0,
        span: 0,
        plotLeft,
        plotRight,
        plotTop,
        plotBottom,
        plotW,
        plotH,
        falling: true,
      };
    }

    const withValidAt = validPricePoints.filter(
      (p) => typeof p.at === "number" && Number.isFinite(p.at)
    );

    let normalized;
    if (withValidAt.length > 0) {
      const sorted = withValidAt
        .map((p, idx) => ({ price: p.price, at: p.at, idx }))
        .sort((a, b) => (a.at !== b.at ? a.at - b.at : a.idx - b.idx));

      // Collapse duplicate timestamps cleanly by keeping the latest reading for that timestamp.
      const deduped = [];
      for (const p of sorted) {
        if (deduped.length && deduped[deduped.length - 1].at === p.at) {
          deduped[deduped.length - 1] = { price: p.price, at: p.at };
        } else {
          deduped.push({ price: p.price, at: p.at });
        }
      }
      normalized = deduped.slice(-maxPoints);
    } else {
      normalized = validPricePoints
        .slice(-maxPoints)
        .map((p, idx) => ({ price: p.price, at: idx }));
    }

    const prices = normalized.map((p) => p.price);
    let minPrice = Math.min(...prices);
    let maxPrice = Math.max(...prices);
    if (minPrice === maxPrice) {
      minPrice -= 1;
      maxPrice += 1;
    }

    const minAt = normalized[0].at;
    const maxAt = normalized[normalized.length - 1].at;
    const span = Math.max(0, maxAt - minAt);

    const points = normalized.map((p) => {
      const x =
        normalized.length === 1 || span <= 0
          ? plotLeft + plotW / 2
          : plotLeft + ((p.at - minAt) / span) * plotW;
      const y = plotTop + (1 - (p.price - minPrice) / (maxPrice - minPrice)) * plotH;
      return { x, y, price: p.price, at: p.at };
    });

    const dts = [];
    for (let i = 1; i < points.length; i++) {
      const dt = points[i].at - points[i - 1].at;
      if (dt > 0) dts.push(dt);
    }
    let medianDt = 0;
    if (dts.length > 0) {
      const sortedDts = dts.slice().sort((a, b) => a - b);
      const mid = Math.floor(sortedDts.length / 2);
      medianDt =
        sortedDts.length % 2 === 1
          ? sortedDts[mid]
          : (sortedDts[mid - 1] + sortedDts[mid]) / 2;
    }

    const longGapThreshold = Math.max(medianDt * 4, 24 * 60 * 60 * 1000);
    const segments = [];
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1];
      const to = points[i];
      const dt = to.at - from.at;
      const isLongGap =
        points.length >= 3 &&
        span > 0 &&
        dt >= longGapThreshold &&
        dt / span >= 0.35;
      segments.push({ from, to, dt, isLongGap });
    }

    const ticks = [];
    const hasRealTimestamps = withValidAt.length > 0 && maxAt > 1000000000;
    if (hasRealTimestamps) {
      if (points.length === 1 || span === 0) {
        ticks.push({
          x: plotLeft + plotW / 2,
          at: minAt,
          align: "center",
          label: formatChartTick(minAt, 0, true),
        });
      } else {
        const startLabel = formatChartTick(minAt, span, false);
        const endLabel = formatChartTick(maxAt, span, false);
        ticks.push({
          x: plotLeft,
          at: minAt,
          align: "left",
          label: startLabel,
        });
        if (plotW >= 180) {
          const midAt = Math.round(minAt + span / 2);
          const midLabel = formatChartTick(midAt, span, false);
          if (midLabel && midLabel !== startLabel && midLabel !== endLabel) {
            ticks.push({
              x: plotLeft + plotW / 2,
              at: midAt,
              align: "center",
              label: midLabel,
            });
          }
        }
        ticks.push({
          x: plotRight,
          at: maxAt,
          align: "right",
          label: endLabel,
        });
      }
    }

    const falling = points[points.length - 1].price <= points[0].price;

    return {
      points,
      segments,
      ticks,
      minPrice,
      maxPrice,
      minAt,
      maxAt,
      span,
      plotLeft,
      plotRight,
      plotTop,
      plotBottom,
      plotW,
      plotH,
      falling,
    };
  }

  function sanitizeHistoryList(rawHistory) {
    if (rawHistory == null) return { ok: true, history: [] };
    if (!Array.isArray(rawHistory)) {
      return { ok: false, error: "history must be an array" };
    }
    const clean = [];
    for (const point of rawHistory) {
      if (!isPlainObject(point)) {
        return { ok: false, error: "history entry must be an object" };
      }
      if (
        typeof point.price !== "number" ||
        !Number.isFinite(point.price) ||
        point.price < 0
      ) {
        return { ok: false, error: "invalid history price" };
      }
      if (
        typeof point.at !== "number" ||
        !Number.isFinite(point.at) ||
        point.at < 0
      ) {
        return { ok: false, error: "invalid history timestamp" };
      }
      clean.push({ price: point.price, at: point.at });
    }
    clean.sort((a, b) => a.at - b.at);
    const deduped = [];
    for (const pt of clean) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.at === pt.at && prev.price === pt.price) continue;
      deduped.push(pt);
    }
    return {
      ok: true,
      history:
        deduped.length > HISTORY_LIMIT
          ? deduped.slice(deduped.length - HISTORY_LIMIT)
          : deduped,
    };
  }

  function buildExportPayload({
    watches = {},
    settings = { checkIntervalHours: CHECK_INTERVAL_HOURS },
    exportedAt = new Date().toISOString(),
  } = {}) {
    return {
      app: BACKUP_APP_ID,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt,
      settings: {
        checkIntervalHours: normalizeCheckIntervalHours(
          settings?.checkIntervalHours
        ),
      },
      watches: isPlainObject(watches) ? watches : {},
    };
  }

  function validateImportPayload(raw) {
    if (!isPlainObject(raw)) {
      return { ok: false, errorCode: "INVALID_SCHEMA", error: t("importInvalidSchema") };
    }
    if ("app" in raw && raw.app !== BACKUP_APP_ID) {
      return { ok: false, errorCode: "INVALID_APP", error: t("importInvalidSchema") };
    }
    if ("schemaVersion" in raw && raw.schemaVersion !== BACKUP_SCHEMA_VERSION) {
      return { ok: false, errorCode: "INVALID_VERSION", error: t("importInvalidSchema") };
    }
    if (!isPlainObject(raw.watches)) {
      return { ok: false, errorCode: "INVALID_WATCHES", error: t("importInvalidSchema") };
    }

    let settings = null;
    if ("settings" in raw && raw.settings != null) {
      if (!isPlainObject(raw.settings)) {
        return { ok: false, errorCode: "INVALID_SETTINGS", error: t("importInvalidSchema") };
      }
      if (
        "checkIntervalHours" in raw.settings &&
        !ALLOWED_INTERVAL_HOURS.includes(Number(raw.settings.checkIntervalHours))
      ) {
        return { ok: false, errorCode: "INVALID_INTERVAL", error: t("importInvalidSchema") };
      }
      settings = {
        checkIntervalHours: normalizeCheckIntervalHours(
          raw.settings.checkIntervalHours
        ),
      };
    }

    const sanitizedWatches = {};
    for (const [mapKey, item] of Object.entries(raw.watches)) {
      if (
        FORBIDDEN_KEYS.has(mapKey) ||
        !PRODUCT_KEY_RE.test(mapKey) ||
        !isPlainObject(item)
      ) {
        return { ok: false, errorCode: "INVALID_WATCH_ENTRY", error: t("importInvalidSchema") };
      }
      if (item.key != null && (typeof item.key !== "string" || item.key !== mapKey)) {
        return { ok: false, errorCode: "KEY_MISMATCH", error: t("importInvalidSchema") };
      }

      const histRes = sanitizeHistoryList(item.history);
      if (!histRes.ok) {
        return { ok: false, errorCode: "INVALID_HISTORY", error: t("importInvalidSchema") };
      }

      let url = null;
      if (item.url != null) {
        url = isCatalogOnlinerUrl(item.url);
        if (!url) {
          return { ok: false, errorCode: "INVALID_URL", error: t("importInvalidSchema") };
        }
      }

      let image = null;
      if (item.image != null) {
        image = isSafeHttpsUrl(item.image);
        if (!image) {
          return { ok: false, errorCode: "INVALID_IMAGE", error: t("importInvalidSchema") };
        }
      }

      let lastPrice = null;
      if (item.lastPrice != null) {
        if (
          typeof item.lastPrice !== "number" ||
          !Number.isFinite(item.lastPrice) ||
          item.lastPrice < 0
        ) {
          return { ok: false, errorCode: "INVALID_PRICE", error: t("importInvalidSchema") };
        }
        lastPrice = item.lastPrice;
      }

      let targetPrice = null;
      if (item.targetPrice != null) {
        if (
          typeof item.targetPrice !== "number" ||
          !Number.isFinite(item.targetPrice) ||
          item.targetPrice <= 0
        ) {
          return { ok: false, errorCode: "INVALID_TARGET", error: t("importInvalidSchema") };
        }
        targetPrice = Math.round(item.targetPrice * 100) / 100;
      }

      let targetNotifiedPrice = null;
      if (item.targetNotifiedPrice != null) {
        if (
          typeof item.targetNotifiedPrice !== "number" ||
          !Number.isFinite(item.targetNotifiedPrice) ||
          item.targetNotifiedPrice < 0
        ) {
          return { ok: false, errorCode: "INVALID_TARGET_NOTIFIED", error: t("importInvalidSchema") };
        }
        targetNotifiedPrice = item.targetNotifiedPrice;
      }

      const optionalTs = (v) =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

      const unavailable = Boolean(item.unavailable);
      const unavailableReason =
        unavailable && (item.unavailableReason === "delisted" || item.unavailableReason === "no_offers")
          ? item.unavailableReason
          : unavailable
            ? "no_offers"
            : null;

      sanitizedWatches[mapKey] = {
        key: mapKey,
        title:
          typeof item.title === "string" && item.title.trim()
            ? item.title.trim()
            : mapKey,
        url,
        image,
        currency:
          typeof item.currency === "string" && item.currency.trim()
            ? item.currency.trim()
            : "BYN",
        lastPrice:
          lastPrice != null
            ? lastPrice
            : histRes.history.length
              ? histRes.history[histRes.history.length - 1].price
              : null,
        lastCheckedAt: optionalTs(item.lastCheckedAt),
        addedAt: optionalTs(item.addedAt) ?? Date.now(),
        targetPrice,
        targetNotifiedPrice,
        unavailable,
        unavailableSince: unavailable ? optionalTs(item.unavailableSince) : null,
        unavailableReason,
        lastError: typeof item.lastError === "string" ? item.lastError : null,
        history: histRes.history,
      };
    }

    return {
      ok: true,
      data: {
        watches: sanitizedWatches,
        settings,
      },
    };
  }

  function mergeHistory(existingHistory, importedHistory) {
    const combined = [
      ...(Array.isArray(existingHistory) ? existingHistory : []),
      ...(Array.isArray(importedHistory) ? importedHistory : []),
    ].filter(
      (p) =>
        p &&
        typeof p.price === "number" &&
        Number.isFinite(p.price) &&
        typeof p.at === "number" &&
        Number.isFinite(p.at)
    );
    combined.sort((a, b) => a.at - b.at);
    const deduped = [];
    for (const pt of combined) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.at === pt.at && prev.price === pt.price) continue;
      deduped.push({ price: pt.price, at: pt.at });
    }
    return deduped.length > HISTORY_LIMIT
      ? deduped.slice(deduped.length - HISTORY_LIMIT)
      : deduped;
  }

  function mergeWatches(existingWatches, importedWatches) {
    const merged = isPlainObject(existingWatches) ? { ...existingWatches } : {};
    for (const [key, imp] of Object.entries(importedWatches || {})) {
      const cur = merged[key];
      if (!cur) {
        merged[key] = { ...imp, history: imp.history.slice() };
        continue;
      }

      const curTs = cur.lastCheckedAt || 0;
      const impTs = imp.lastCheckedAt || 0;
      const primary = impTs >= curTs ? imp : cur;
      const secondary = impTs >= curTs ? cur : imp;

      const history = mergeHistory(cur.history, imp.history);
      const targetPrice =
        imp.targetPrice != null ? imp.targetPrice : (cur.targetPrice ?? null);
      const targetChanged = targetPrice !== (cur.targetPrice ?? null);
      const addedAtCandidates = [cur.addedAt, imp.addedAt].filter(
        (v) => typeof v === "number" && Number.isFinite(v) && v > 0
      );

      merged[key] = {
        key,
        title: primary.title || secondary.title || key,
        url: primary.url || secondary.url || null,
        image: primary.image || secondary.image || null,
        currency: primary.currency || secondary.currency || "BYN",
        lastPrice:
          primary.lastPrice != null
            ? primary.lastPrice
            : secondary.lastPrice != null
              ? secondary.lastPrice
              : history.length
                ? history[history.length - 1].price
                : null,
        lastCheckedAt: Math.max(curTs, impTs) || null,
        addedAt: addedAtCandidates.length
          ? Math.min(...addedAtCandidates)
          : Date.now(),
        targetPrice,
        targetNotifiedPrice: targetChanged
          ? imp.targetNotifiedPrice ?? null
          : cur.targetNotifiedPrice ?? null,
        unavailable: Boolean(primary.unavailable),
        unavailableSince: primary.unavailable
          ? primary.unavailableSince ?? secondary.unavailableSince ?? null
          : null,
        unavailableReason: primary.unavailable
          ? primary.unavailableReason ?? secondary.unavailableReason ?? "no_offers"
          : null,
        lastError: primary.lastError ?? null,
        history,
      };
    }
    return merged;
  }

  async function importBackup(rawPayload, { mode = "merge" } = {}) {
    const validated = validateImportPayload(rawPayload);
    if (!validated.ok) {
      return validated;
    }

    const importMode = mode === "replace" ? "replace" : "merge";
    return withStorageLock(async () => {
      const currentWatches = await getWatches();
      const importedWatches = validated.data.watches;
      const importedKeys = Object.keys(importedWatches);

      const nextWatches =
        importMode === "replace"
          ? importedWatches
          : mergeWatches(currentWatches, importedWatches);

      const patch = { [STORAGE_KEY]: nextWatches };
      let settingsUpdated = false;
      if (validated.data.settings) {
        patch[SETTINGS_KEY] = validated.data.settings;
        settingsUpdated = true;
      }

      await chrome.storage.local.set(patch);

      return {
        ok: true,
        mode: importMode,
        importedCount: importedKeys.length,
        watchCount: Object.keys(nextWatches).length,
        settingsUpdated,
        settings: validated.data.settings,
      };
    });
  }

  function formatBadgeText(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n <= 0) return "";
    if (n === 1) return "↓";
    if (n <= 9) return `↓${n}`;
    return "↓9+";
  }

  function normalizeUnreadDropKeys(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const clean = [];
    for (const key of raw) {
      if (typeof key !== "string" || !key || seen.has(key)) continue;
      seen.add(key);
      clean.push(key);
    }
    return clean;
  }

  async function getUnreadDropKeys() {
    const result = await chrome.storage.local.get(UNREAD_DROPS_KEY);
    return normalizeUnreadDropKeys(result[UNREAD_DROPS_KEY]);
  }

  async function addUnreadDropKey(key) {
    if (typeof key !== "string" || !key) return getUnreadDropKeys();
    return withStorageLock(async () => {
      const current = await getUnreadDropKeys();
      if (current.includes(key)) return current;
      const next = [...current, key];
      await chrome.storage.local.set({ [UNREAD_DROPS_KEY]: next });
      return next;
    });
  }

  async function removeUnreadDropKey(key) {
    if (typeof key !== "string" || !key) return getUnreadDropKeys();
    return withStorageLock(async () => {
      const current = await getUnreadDropKeys();
      if (!current.includes(key)) return current;
      const next = current.filter((k) => k !== key);
      await chrome.storage.local.set({ [UNREAD_DROPS_KEY]: next });
      return next;
    });
  }

  async function clearUnreadDropKeys() {
    return withStorageLock(async () => {
      const current = await getUnreadDropKeys();
      if (current.length > 0) {
        await chrome.storage.local.set({ [UNREAD_DROPS_KEY]: [] });
      }
      return [];
    });
  }

  async function pruneUnreadDropKeys(validWatches) {
    const watchMap = isPlainObject(validWatches) ? validWatches : {};
    return withStorageLock(async () => {
      const current = await getUnreadDropKeys();
      const next = current.filter((k) => Boolean(watchMap[k]));
      if (next.length !== current.length) {
        await chrome.storage.local.set({ [UNREAD_DROPS_KEY]: next });
      }
      return next;
    });
  }

  function formatPrice(amount, currency = "BYN") {
    if (amount == null || !Number.isFinite(amount)) return "—";
    const formatted = amount.toLocaleString("ru-BY", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${formatted} ${currency}`;
  }

  function t(key, substitutions) {
    try {
      const msg = chrome.i18n.getMessage(key, substitutions);
      if (msg) return msg;
    } catch {
      /* chrome.i18n unavailable in some test contexts */
    }
    return key;
  }

  /** Russian-style plural picker; EN messages use the same few/many text. */
  function pluralForm(n) {
    const abs = Math.abs(Number(n)) || 0;
    const n10 = abs % 10;
    const n100 = abs % 100;
    if (n10 === 1 && n100 !== 11) return "one";
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return "few";
    return "many";
  }

  function tPlural(baseKey, n) {
    const form = pluralForm(n);
    const key =
      form === "one"
        ? `${baseKey}One`
        : form === "few"
          ? `${baseKey}Few`
          : `${baseKey}Many`;
    return t(key, [String(n)]);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  global.OnlinerPT = {
    CHECK_ALARM,
    CHECK_INTERVAL_HOURS,
    CHECK_PERIOD_MINUTES,
    ALLOWED_INTERVAL_HOURS,
    FETCH_GAP_MS,
    FETCH_TIMEOUT_MS,
    FETCH_MAX_RETRIES,
    FETCH_RETRY_DELAY_MS,
    HISTORY_LIMIT,
    STORAGE_KEY,
    SETTINGS_KEY,
    LAST_CHECK_KEY,
    NOTIFICATION_URLS_KEY,
    UNREAD_DROPS_KEY,
    BADGE_DROP_COLOR,
    BADGE_TEXT_COLOR,
    BACKUP_APP_ID,
    BACKUP_SCHEMA_VERSION,
    PRICE_EPSILON,
    EXCLUDED_PRODUCT_SUBPAGES,
    isCatalogOnlinerUrl,
    isSafeHttpsUrl,
    parseProductUrl,
    parseProductPageUrl,
    parseAmount,
    parsePriceText,
    parseTargetPrice,
    decodeHtmlEntities,
    isRetryableStatus,
    fetchWithRetry,
    fetchJsonWithRetry,
    fetchTextWithRetry,
    extractProductFromApiPayload,
    extractProductFromJsonLdObjects,
    fetchProduct,
    fetchProductFromPage,
    fetchProductWithFallback,
    scrapeProductFromDom,
    scrapeProductFromHtml,
    normalizeCheckIntervalHours,
    getSettings,
    setSettings,
    getLastCheckAt,
    setLastCheckAt,
    isCheckStale,
    parseNotificationKey,
    saveNotificationTarget,
    consumeNotificationTarget,
    removeNotificationTarget,
    formatBadgeText,
    getUnreadDropKeys,
    addUnreadDropKey,
    removeUnreadDropKey,
    clearUnreadDropKeys,
    pruneUnreadDropKeys,
    getWatches,
    setWatches,
    isWatched,
    appendHistory,
    evaluatePriceAlert,
    updateWatchIfPresent,
    setWatchTargetPrice,
    watchProduct,
    unwatchProduct,
    formatChartTick,
    computeChartLayout,
    buildExportPayload,
    validateImportPayload,
    mergeWatches,
    importBackup,
    formatPrice,
    t,
    pluralForm,
    tPlural,
    sleep,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
