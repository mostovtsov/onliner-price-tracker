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
  const NOTIFICATION_MAP_LIMIT = 100;
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
   * Marks product unavailable when `prices` is null, `price_min` is missing,
   * or `prices.offers.count === 0`.
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
    const minPrice = parseAmount(data?.prices?.price_min?.amount);
    const offersCount = data?.prices?.offers?.count ?? null;
    const unavailable =
      data?.prices == null || minPrice == null || offersCount === 0;
    const price = unavailable ? null : minPrice;
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
      offersCount,
      unavailable,
      unavailableReason: unavailable ? "no_offers" : null,
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
    BACKUP_APP_ID,
    BACKUP_SCHEMA_VERSION,
    PRICE_EPSILON,
    EXCLUDED_PRODUCT_SUBPAGES,
    isCatalogOnlinerUrl,
    isSafeHttpsUrl,
    parseProductUrl,
    parseProductPageUrl,
    parseAmount,
    parseTargetPrice,
    isRetryableStatus,
    fetchJsonWithRetry,
    fetchProduct,
    scrapeProductFromDom,
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
