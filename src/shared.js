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
  const HISTORY_LIMIT = 200;
  const STORAGE_KEY = "watches";

  const API_BASE = "https://catalog.api.onliner.by/products/";

  /**
   * Product page URL shape: /{category}/{manufacturer}/{key}
   * Optional trailing segments (reviews, prices, …) are ignored for the key.
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

    const reserved = new Set([
      "reviews",
      "prices",
      "used",
      "forum",
      "photos",
      "edit",
    ]);
    if (reserved.has(parts[2])) return null;

    const category = parts[0];
    const manufacturer = parts[1];
    const key = parts[2];
    if (!/^[a-z0-9_]+$/i.test(key)) return null;
    if (reserved.has(category) || category === "search" || category === "user") {
      return null;
    }

    return {
      key,
      category,
      manufacturer,
      url: `https://catalog.onliner.by/${category}/${manufacturer}/${key}`,
    };
  }

  function parseAmount(value) {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const n = parseFloat(String(value).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Fetch product snapshot from the public catalog API.
   * Prefer API over DOM so background checks stay resilient.
   */
  async function fetchProduct(key) {
    const res = await fetch(`${API_BASE}${encodeURIComponent(key)}`, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Onliner API ${res.status} for ${key}`);
    }
    const data = await res.json();
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
    const meta = doc.querySelector('meta[name="product-id"]');
    const key =
      meta?.getAttribute("product-id") ||
      parseProductUrl(doc.location?.href || "")?.key ||
      null;

    let title =
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
      doc.querySelector("h1")?.textContent ||
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
          if (item.name) title = String(item.name);
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

  async function watchProduct(product) {
    if (!product?.key) throw new Error("Missing product key");
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
  }

  async function unwatchProduct(key) {
    const watches = await getWatches();
    if (!watches[key]) return false;
    delete watches[key];
    await setWatches(watches);
    return true;
  }

  function formatPrice(amount, currency = "BYN") {
    if (amount == null || !Number.isFinite(amount)) return "—";
    const formatted = amount.toLocaleString("ru-BY", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${formatted} ${currency}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  global.OnlinerPT = {
    CHECK_ALARM,
    CHECK_INTERVAL_HOURS,
    CHECK_PERIOD_MINUTES,
    FETCH_GAP_MS,
    HISTORY_LIMIT,
    STORAGE_KEY,
    parseProductUrl,
    parseAmount,
    fetchProduct,
    scrapeProductFromDom,
    getWatches,
    setWatches,
    isWatched,
    appendHistory,
    watchProduct,
    unwatchProduct,
    formatPrice,
    sleep,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
