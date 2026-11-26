/**
 * Shared helpers for Onliner Price Tracker (content script + popup + background).
 * Loaded as a classic script; attaches to globalThis.OnlinerPT.
 */
(function (global) {
  "use strict";

  const CHECK_ALARM = "onliner-price-check";
  /** Background price check interval (hours). Documented in README. */
  const CHECK_INTERVAL_HOURS = 3;
  const CHECK_PERIOD_MINUTES = CHECK_INTERVAL_HOURS * 60;
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

  const API_BASE = "https://catalog.api.onliner.by/products/";

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
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(key)) return null;
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

  /**
   * Fetch JSON with a per-attempt AbortController timeout and exponential
   * backoff retries on timeouts, network errors, 408, 429, and 5xx responses.
   */
  async function fetchJsonWithRetry(url, options = {}) {
    const {
      timeoutMs = FETCH_TIMEOUT_MS,
      maxRetries = FETCH_MAX_RETRIES,
      retryDelayMs = FETCH_RETRY_DELAY_MS,
      fetchOptions = {},
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

        return await res.json();
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
   * Fetch product snapshot from the public catalog API.
   * Prefer API over DOM so background checks stay resilient.
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
    const price =
      parseAmount(data?.prices?.price_min?.amount) ??
      parseAmount(data?.sale?.min_prices_median?.amount);
    const currency =
      data?.prices?.price_min?.currency ||
      data?.sale?.min_prices_median?.currency ||
      "BYN";
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
      offersCount: data?.prices?.offers?.count ?? null,
      fetchedAt: Date.now(),
    };
  }

  /**
   * DOM fallbacks for the content script when API is slow/blocked.
   */
  function scrapeProductFromDom(doc = document) {
    const urlKey = parseProductUrl(doc.location?.href || "")?.key || null;
    const meta = doc.querySelector('meta[name="product-id"]');
    const key = urlKey || meta?.getAttribute("product-id") || null;

    let title =
      doc.querySelector("h1")?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
      doc.title ||
      "";
    title = title.replace(/\s+купить.*$/i, "").trim();

    let price = null;
    let currency = "BYN";

    const ldScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const el of ldScripts) {
      try {
        const raw = JSON.parse(el.textContent || "null");
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
          if (!item || item["@type"] !== "Product") continue;
          if (urlKey && item.url) {
            const ldKey = parseProductUrl(String(item.url))?.key;
            if (ldKey && ldKey !== urlKey) continue;
          }
          if (item.name && !title) title = String(item.name);
          const offers = item.offers;
          if (offers) {
            price =
              parseAmount(offers.lowPrice) ??
              parseAmount(offers.price) ??
              price;
            currency = offers.priceCurrency || currency;
          }
        }
      } catch {
        /* ignore malformed JSON-LD */
      }
    }

    if (price == null) {
      const priceEl =
        doc.querySelector(".js-description-price-link .h_txt_ell") ||
        doc.querySelector('[class*="price"] .h_txt_ell');
      if (priceEl) {
        price = parseAmount(priceEl.textContent);
      }
    }

    return { key, title, price, currency };
  }

  // Serialize read-modify-write storage ops within the same JS context.
  let storageQueue = Promise.resolve();
  function withStorageLock(fn) {
    const next = storageQueue.then(fn, fn);
    storageQueue = next.catch(() => {});
    return next;
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

  async function watchProduct(product) {
    if (!product?.key) throw new Error("Missing product key");
    return withStorageLock(async () => {
      const watches = await getWatches();
      const existing = watches[product.key] || {};
      const price = product.price;
      const history =
        price != null
          ? appendHistory(
              { history: existing.history || [] },
              price,
              product.fetchedAt || Date.now()
            )
          : existing.history || [];

      watches[product.key] = {
        key: product.key,
        title: product.title || existing.title || product.key,
        url: product.url || existing.url || null,
        image: product.image || existing.image || null,
        currency: product.currency || existing.currency || "BYN",
        lastPrice: price != null ? price : existing.lastPrice ?? null,
        lastCheckedAt: product.fetchedAt || Date.now(),
        addedAt: existing.addedAt || Date.now(),
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
    FETCH_GAP_MS,
    FETCH_TIMEOUT_MS,
    FETCH_MAX_RETRIES,
    FETCH_RETRY_DELAY_MS,
    HISTORY_LIMIT,
    STORAGE_KEY,
    EXCLUDED_PRODUCT_SUBPAGES,
    parseProductUrl,
    parseProductPageUrl,
    parseAmount,
    isRetryableStatus,
    fetchJsonWithRetry,
    fetchProduct,
    scrapeProductFromDom,
    getWatches,
    setWatches,
    isWatched,
    appendHistory,
    updateWatchIfPresent,
    watchProduct,
    unwatchProduct,
    formatPrice,
    t,
    pluralForm,
    tPlural,
    sleep,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
