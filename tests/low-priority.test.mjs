import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ruMessages = JSON.parse(
  fs.readFileSync(path.join(ROOT, "_locales/ru/messages.json"), "utf8")
);
const enMessages = JSON.parse(
  fs.readFileSync(path.join(ROOT, "_locales/en/messages.json"), "utf8")
);

function makeI18n(messages) {
  return {
    getMessage(key, substitutions) {
      const entry = messages[key];
      if (!entry) return "";
      let msg = entry.message;
      const subs = Array.isArray(substitutions)
        ? substitutions
        : substitutions != null
          ? [String(substitutions)]
          : [];
      subs.forEach((val, idx) => {
        msg = msg.replaceAll(`$${idx + 1}`, String(val));
      });
      return msg;
    },
  };
}

function createPersistentStorage(initialData = {}) {
  const state = structuredClone(initialData);
  if (!state.watches) state.watches = {};
  const listeners = new Set();

  const local = {
    async get(key) {
      if (typeof key === "string") {
        return { [key]: structuredClone(state[key]) };
      }
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) out[k] = structuredClone(state[k]);
        return out;
      }
      return structuredClone(state);
    },
    async set(patch) {
      const changes = {};
      for (const [k, v] of Object.entries(patch)) {
        const oldValue = structuredClone(state[k]);
        state[k] = structuredClone(v);
        changes[k] = { oldValue, newValue: structuredClone(v) };
      }
      for (const fn of listeners) {
        fn(changes, "local");
      }
    },
  };

  return {
    local,
    onChanged: {
      addListener(fn) {
        listeners.add(fn);
      },
      removeListener(fn) {
        listeners.delete(fn);
      },
    },
    getAll: () => structuredClone(state),
  };
}

function loadShared({ storage, messages = ruMessages, fetchImpl } = {}) {
  const storageMock = storage || createPersistentStorage();
  const context = {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    console,
    fetch:
      fetchImpl ||
      (async () => {
        throw new Error("fetch not mocked");
      }),
    chrome: {
      storage: storageMock,
      i18n: makeI18n(messages),
      runtime: { id: "test-ext-id" },
    },
  };
  context.globalThis = context;
  context.self = context;

  const code = fs.readFileSync(path.join(ROOT, "src/shared.js"), "utf8");
  vm.runInNewContext(code, context, { filename: "src/shared.js" });
  return { OnlinerPT: context.OnlinerPT, storage: storageMock };
}

function loadBackground({
  fetchImpl,
  storage,
  initialData = {},
  fetchGapMs = 0,
  messages = ruMessages,
} = {}) {
  const storageMock = storage || createPersistentStorage(initialData);
  const notifications = [];
  const alarms = new Map();
  const badgeState = {
    text: "",
    backgroundColor: null,
    textColor: null,
    title: null,
    calls: [],
  };

  let messageListener = null;

  const context = {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    console,
    fetch:
      fetchImpl ||
      (async () => {
        throw new Error("fetch not mocked");
      }),
    chrome: {
      storage: storageMock,
      i18n: makeI18n(messages),
      action: {
        async setBadgeText({ text }) {
          badgeState.text = text;
          badgeState.calls.push({ op: "setBadgeText", text });
        },
        async setBadgeBackgroundColor({ color }) {
          badgeState.backgroundColor = color;
          badgeState.calls.push({ op: "setBadgeBackgroundColor", color });
        },
        async setBadgeTextColor({ color }) {
          badgeState.textColor = color;
          badgeState.calls.push({ op: "setBadgeTextColor", color });
        },
        async setTitle({ title }) {
          badgeState.title = title;
          badgeState.calls.push({ op: "setTitle", title });
        },
      },
      runtime: {
        id: "test-ext-id",
        getURL: (p) => `chrome-extension://test/${p}`,
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: {
          addListener(fn) {
            messageListener = fn;
          },
        },
      },
      alarms: {
        async get(name) {
          return alarms.get(name) || null;
        },
        async clear(name) {
          return alarms.delete(name);
        },
        create(name, info) {
          alarms.set(name, { name, ...info });
        },
        onAlarm: { addListener() {} },
      },
      notifications: {
        async create(id, opts) {
          notifications.push({ id, ...opts });
          return id;
        },
        async clear() {
          return true;
        },
        onClicked: { addListener() {} },
        onClosed: { addListener() {} },
      },
      tabs: {
        async query() {
          return [];
        },
        async create(opts) {
          return { id: 101, windowId: 1, ...opts };
        },
      },
    },
    importScripts(file) {
      const scriptCode = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
      vm.runInContext(scriptCode, vmContext, { filename: `src/${file}` });
      if (file === "shared.js" && fetchGapMs !== undefined) {
        context.OnlinerPT.FETCH_GAP_MS = fetchGapMs;
      }
    },
  };
  context.globalThis = context;
  context.self = context;

  const vmContext = vm.createContext(context);
  const bgCode = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");
  vm.runInContext(bgCode, vmContext, { filename: "src/background.js" });

  return {
    OnlinerPT: context.OnlinerPT,
    checkAllWatches: context.checkAllWatches,
    handleNotificationClick: context.handleNotificationClick,
    syncActionBadge: context.syncActionBadge,
    storage: storageMock,
    notifications,
    badgeState,
    sendMessage: (msg) =>
      new Promise((resolve) => messageListener(msg, {}, resolve)),
  };
}

function okProductResponse(key, { price, currency = "BYN", name, url, offersCount = 5 } = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        key,
        full_name: name || key.toUpperCase(),
        html_url: url || `https://catalog.onliner.by/mobile/test/${key}`,
        prices:
          price == null
            ? null
            : {
                price_min: { amount: String(price), currency },
                offers: { count: offersCount },
              },
      };
    },
  };
}

// ---------- OPT-15: CI workflow and zip packaging ----------

test("OPT-15: GitHub Actions CI workflow checks src syntax, runs tests, builds and uploads release zip", () => {
  const workflowPath = path.join(ROOT, ".github/workflows/ci.yml");
  assert.ok(fs.existsSync(workflowPath), ".github/workflows/ci.yml must exist");

  const yaml = fs.readFileSync(workflowPath, "utf8");
  assert.match(yaml, /node\s+--check/);
  assert.match(yaml, /node\s+--test/);
  assert.match(yaml, /\.\/scripts\/build-zip\.sh/);
  assert.match(yaml, /actions\/upload-artifact@v4/);
  assert.match(yaml, /dist\/onliner-price-tracker\.zip/);
});

// ---------- OPT-16: Badge on price drop / target reached ----------

test("OPT-16: formatBadgeText formats 0, 1, 2..9, and 10+ cleanly", () => {
  const { OnlinerPT } = loadShared();
  assert.equal(OnlinerPT.formatBadgeText(0), "");
  assert.equal(OnlinerPT.formatBadgeText(-1), "");
  assert.equal(OnlinerPT.formatBadgeText(1), "↓");
  assert.equal(OnlinerPT.formatBadgeText(2), "↓2");
  assert.equal(OnlinerPT.formatBadgeText(9), "↓9");
  assert.equal(OnlinerPT.formatBadgeText(10), "↓9+");
  assert.equal(OnlinerPT.formatBadgeText(42), "↓9+");
});

test("OPT-16: sets badge on price drop and target reached, accumulates count, and clears on CLEAR_BADGE", async () => {
  const bg = loadBackground({
    initialData: {
      watches: {
        p1: {
          key: "p1",
          title: "Phone One",
          url: "https://catalog.onliner.by/mobile/test/p1",
          lastPrice: 1000,
          history: [{ price: 1000, at: 1000 }],
        },
        p2: {
          key: "p2",
          title: "Laptop Target",
          url: "https://catalog.onliner.by/notebook/test/p2",
          lastPrice: 2500,
          targetPrice: 2000,
          history: [{ price: 2500, at: 1000 }],
        },
      },
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/p1")) {
        return okProductResponse("p1", { price: 900, name: "Phone One" });
      }
      return okProductResponse("p2", { price: 1990, name: "Laptop Target" });
    },
  });

  const res = await bg.checkAllWatches({ notify: true });
  assert.equal(res.drops, 2);
  assert.equal(bg.badgeState.text, "↓2");
  assert.equal(bg.badgeState.backgroundColor, bg.OnlinerPT.BADGE_DROP_COLOR);
  assert.equal(bg.badgeState.textColor, bg.OnlinerPT.BADGE_TEXT_COLOR);
  assert.equal(bg.badgeState.title, "Onliner Price Tracker — 2 снижения цены");
  assert.deepEqual(bg.storage.getAll().unreadDropKeys, ["p1", "p2"]);

  // Popup open sends CLEAR_BADGE -> clears badge and restores default title
  const cleared = await bg.sendMessage({ type: "CLEAR_BADGE" });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.text, "");
  assert.equal(cleared.count, 0);
  assert.equal(bg.badgeState.text, "");
  assert.equal(bg.badgeState.title, "Onliner Price Tracker");
  assert.deepEqual(bg.storage.getAll().unreadDropKeys, []);
});

test("OPT-16: clicking drop notification decrements/clears badge and badge restores after SW restart", async () => {
  const sharedStorage = createPersistentStorage({
    watches: {
      p1: {
        key: "p1",
        title: "Phone One",
        url: "https://catalog.onliner.by/mobile/test/p1",
        lastPrice: 1000,
        history: [{ price: 1000, at: 1000 }],
      },
      p2: {
        key: "p2",
        title: "Tablet Two",
        url: "https://catalog.onliner.by/tablet/test/p2",
        lastPrice: 1500,
        history: [{ price: 1500, at: 1000 }],
      },
    },
  });

  const sw1 = loadBackground({
    storage: sharedStorage,
    messages: enMessages,
    fetchImpl: async (url) => {
      if (url.endsWith("/p1")) {
        return okProductResponse("p1", {
          price: 899,
          url: "https://catalog.onliner.by/mobile/test/p1",
        });
      }
      return okProductResponse("p2", {
        price: 1350,
        url: "https://catalog.onliner.by/tablet/test/p2",
      });
    },
  });

  await sw1.checkAllWatches({ notify: true });
  assert.equal(sw1.badgeState.text, "↓2");
  assert.equal(sw1.badgeState.title, "Onliner Price Tracker — 2 price drops");

  // Simulate MV3 service worker restart -> badge restored from storage
  const sw2 = loadBackground({ storage: sharedStorage, messages: enMessages });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sw2.badgeState.text, "↓2");

  // Clicking p1 notification acknowledges p1 -> badge drops from ↓2 to ↓
  const p1Notif = sw1.notifications.find((n) => n.id.startsWith("drop-p1-"));
  await sw2.handleNotificationClick(p1Notif.id);
  assert.equal(sw2.badgeState.text, "↓");
  assert.equal(sw2.badgeState.title, "Onliner Price Tracker — 1 price drop");
  assert.deepEqual(sharedStorage.getAll().unreadDropKeys, ["p2"]);

  // Unwatching p2 prunes unreadDropKeys and clears badge automatically
  await sw2.OnlinerPT.unwatchProduct("p2");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sw2.badgeState.text, "");
  assert.equal(sw2.badgeState.title, "Onliner Price Tracker");
});

// ---------- OPT-17: Fallback price scraping ----------

test("OPT-17: scrapeProductFromHtml follows documented order (JSON-LD @graph/Offer[] -> meta -> HTML selector)", () => {
  const { OnlinerPT } = loadShared();

  // 1) JSON-LD with @graph and multiple offers -> picks lowest offer price
  const htmlJsonLd = `
    <html>
      <head>
        <title>Apple iPhone 16 купить в Минске</title>
        <meta property="og:image" content="https://content2.onliner.by/catalog/iphone16.jpg">
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebPage", "name": "Catalog" },
              {
                "@type": "Product",
                "name": "Apple iPhone 16 128GB",
                "url": "https://catalog.onliner.by/mobile/apple/iphone16",
                "offers": [
                  { "@type": "Offer", "price": "3150.00", "priceCurrency": "BYN" },
                  { "@type": "Offer", "price": "2899.50", "priceCurrency": "BYN" }
                ]
              }
            ]
          }
        </script>
      </head>
      <body><h1>Apple iPhone 16 128GB</h1></body>
    </html>
  `;
  const r1 = OnlinerPT.scrapeProductFromHtml(htmlJsonLd, {
    url: "https://catalog.onliner.by/mobile/apple/iphone16",
    key: "iphone16",
  });
  assert.equal(r1.price, 2899.5);
  assert.equal(r1.currency, "BYN");
  assert.equal(r1.title, "Apple iPhone 16 128GB");
  assert.equal(r1.image, "https://content2.onliner.by/catalog/iphone16.jpg");
  assert.equal(r1.source, "html-jsonld");

  // 2) No JSON-LD -> falls back to meta tags
  const htmlMeta = `
    <html>
      <head>
        <meta content="1 499,90" property="product:price:amount" />
        <meta property="product:price:currency" content="BYN" />
        <meta property="og:title" content="Sony WH-1000XM5 купить в Минске" />
      </head>
      <body></body>
    </html>
  `;
  const r2 = OnlinerPT.scrapeProductFromHtml(htmlMeta, {
    url: "https://catalog.onliner.by/headphones/sony/wh1000xm5",
    key: "wh1000xm5",
  });
  assert.equal(r2.price, 1499.9);
  assert.equal(r2.currency, "BYN");
  assert.equal(r2.title, "Sony WH-1000XM5");
  assert.equal(r2.source, "html-meta");

  // 3) No JSON-LD or meta -> falls back to Onliner catalog HTML price container
  const htmlSelector = `
    <html>
      <head><title>MacBook Air M3 купить</title></head>
      <body>
        <h1>Apple MacBook Air 13 M3</h1>
        <a class="offers-description__link js-description-price-link" href="/prices">
          <span class="h_txt_ell">от 3&nbsp;450,00&nbsp;р.</span>
        </a>
      </body>
    </html>
  `;
  const r3 = OnlinerPT.scrapeProductFromHtml(htmlSelector, {
    url: "https://catalog.onliner.by/notebook/apple/mba13m3",
    key: "mba13m3",
  });
  assert.equal(r3.price, 3450);
  assert.equal(r3.currency, "BYN");
  assert.equal(r3.title, "Apple MacBook Air 13 M3");
  assert.equal(r3.source, "html-selector");
});

test("OPT-17: background check falls back to watched product HTML page when API fails or changes shape", async () => {
  const requestedUrls = [];
  const bg = loadBackground({
    initialData: {
      watches: {
        iphone16: {
          key: "iphone16",
          title: "Apple iPhone 16",
          url: "https://catalog.onliner.by/mobile/apple/iphone16",
          lastPrice: 3000,
          history: [{ price: 3000, at: 1000 }],
        },
        pixel9: {
          key: "pixel9",
          title: "Google Pixel 9",
          url: "https://catalog.onliner.by/mobile/google/pixel9",
          lastPrice: 2200,
          history: [{ price: 2200, at: 1000 }],
        },
      },
    },
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      // iphone16: API fails with non-retryable 403 -> falls back to product page JSON-LD
      if (url === "https://catalog.api.onliner.by/products/iphone16") {
        return { ok: false, status: 403, headers: new Map() };
      }
      if (url === "https://catalog.onliner.by/mobile/apple/iphone16") {
        return {
          ok: true,
          status: 200,
          async text() {
            return `
              <html><head>
                <script type="application/ld+json">
                  {"@type":"Product","name":"Apple iPhone 16","url":"https://catalog.onliner.by/mobile/apple/iphone16","offers":{"@type":"AggregateOffer","lowPrice":"2750.00","priceCurrency":"BYN"}}
                </script>
              </head></html>
            `;
          },
        };
      }
      // pixel9: API returns 200 with changed JSON shape (no `prices` key) -> falls back to HTML meta
      if (url === "https://catalog.api.onliner.by/products/pixel9") {
        return {
          ok: true,
          status: 200,
          async json() {
            return { key: "pixel9", full_name: "Google Pixel 9", catalog_v2: {} };
          },
        };
      }
      if (url === "https://catalog.onliner.by/mobile/google/pixel9") {
        return {
          ok: true,
          status: 200,
          async text() {
            return `
              <html><head>
                <meta property="product:price:amount" content="1999.00" />
                <meta property="product:price:currency" content="BYN" />
              </head></html>
            `;
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const res = await bg.checkAllWatches({ notify: true });
  assert.deepEqual({ ...res }, { checked: 2, drops: 2, unavailable: 0 });
  assert.equal(bg.storage.getAll().watches.iphone16.lastPrice, 2750);
  assert.equal(bg.storage.getAll().watches.iphone16.lastError, null);
  assert.equal(bg.storage.getAll().watches.pixel9.lastPrice, 1999);
  assert.equal(bg.storage.getAll().watches.pixel9.lastError, null);
  // Both drops also trigger badge!
  assert.equal(bg.badgeState.text, "↓2");
  assert.deepEqual(requestedUrls, [
    "https://catalog.api.onliner.by/products/iphone16",
    "https://catalog.onliner.by/mobile/apple/iphone16",
    "https://catalog.api.onliner.by/products/pixel9",
    "https://catalog.onliner.by/mobile/google/pixel9",
  ]);
});

test("OPT-17: fetchProductWithFallback does NOT scrape page on 404/410 or explicit out-of-stock API payload, and reuses retry helper on HTML fallback", async () => {
  const calls = [];
  const { OnlinerPT } = loadShared({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/delisted_item")) {
        return { ok: false, status: 404, headers: new Map() };
      }
      if (url.includes("/oos_item")) {
        return okProductResponse("oos_item", { price: null });
      }
      if (url.includes("/flaky_item") && url.includes("catalog.api.onliner.by")) {
        return {
          ok: true,
          status: 200,
          async json() {
            throw new SyntaxError("Unexpected token <");
          },
        };
      }
      if (url === "https://catalog.onliner.by/mobile/test/flaky_item") {
        // First HTML attempt fails with 503 -> retried via shared fetchTextWithRetry!
        const htmlHits = calls.filter((u) => u === url).length;
        if (htmlHits === 1) {
          return { ok: false, status: 503, headers: new Map() };
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return `<meta itemprop="price" content="599.50"><h1>Flaky Item</h1>`;
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  // 1) 404 must NOT trigger page scrape
  await assert.rejects(
    () =>
      OnlinerPT.fetchProductWithFallback("delisted_item", {
        fallbackUrl: "https://catalog.onliner.by/mobile/test/delisted_item",
        retryDelayMs: 5,
      }),
    (err) => err.status === 404
  );
  assert.deepEqual(calls, [
    "https://catalog.api.onliner.by/products/delisted_item",
  ]);

  // 2) Explicit prices: null must NOT trigger page scrape
  calls.length = 0;
  const oos = await OnlinerPT.fetchProductWithFallback("oos_item", {
    fallbackUrl: "https://catalog.onliner.by/mobile/test/oos_item",
    retryDelayMs: 5,
  });
  assert.equal(oos.unavailable, true);
  assert.deepEqual(calls, ["https://catalog.api.onliner.by/products/oos_item"]);

  // 3) Invalid JSON from API -> falls back to HTML page & retries 503 once via shared helper
  calls.length = 0;
  const recovered = await OnlinerPT.fetchProductWithFallback("flaky_item", {
    fallbackUrl: "https://catalog.onliner.by/mobile/test/flaky_item",
    timeoutMs: 500,
    maxRetries: 1,
    retryDelayMs: 5,
  });
  assert.equal(recovered.price, 599.5);
  assert.equal(recovered.source, "html-meta");
  assert.deepEqual(calls, [
    "https://catalog.api.onliner.by/products/flaky_item",
    "https://catalog.onliner.by/mobile/test/flaky_item",
    "https://catalog.onliner.by/mobile/test/flaky_item",
  ]);
});

test("OPT-17: scrapeProductFromDom extracts price from meta and catalog DOM selectors when JSON-LD is missing", () => {
  const { OnlinerPT } = loadShared();

  const makeDoc = ({ href, title = "", h1 = "", metaMap = {}, selectorMap = {}, ldJson = [] }) => ({
    location: { href },
    title,
    querySelector(sel) {
      if (sel === "h1" && h1) return { textContent: h1 };
      if (sel in metaMap) {
        return {
          getAttribute: (attr) => (attr === "content" ? metaMap[sel] : null),
          textContent: "",
        };
      }
      if (sel in selectorMap) {
        return {
          getAttribute: () => null,
          textContent: selectorMap[sel],
        };
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'script[type="application/ld+json"]') {
        return ldJson.map((textContent) => ({ textContent }));
      }
      return [];
    },
  });

  const domFromMeta = OnlinerPT.scrapeProductFromDom(
    makeDoc({
      href: "https://catalog.onliner.by/mobile/apple/iphone16",
      h1: "Apple iPhone 16",
      metaMap: {
        'meta[property="product:price:amount"]': "2890,00",
        'meta[property="og:image"]': "https://content2.onliner.by/img.png",
      },
    })
  );
  assert.equal(domFromMeta.price, 2890);
  assert.equal(domFromMeta.image, "https://content2.onliner.by/img.png");
  assert.equal(domFromMeta.source, "dom-meta");

  const domFromSelector = OnlinerPT.scrapeProductFromDom(
    makeDoc({
      href: "https://catalog.onliner.by/mobile/apple/iphone16",
      title: "Apple iPhone 16 купить в Минске",
      selectorMap: {
        ".offers-description__link_nodecor": "от 2 799,00 р.",
      },
    })
  );
  assert.equal(domFromSelector.price, 2799);
  assert.equal(domFromSelector.currency, "BYN");
  assert.equal(domFromSelector.title, "Apple iPhone 16");
  assert.equal(domFromSelector.source, "dom-selector");
});

test("OPT-17: content script recovers errored watched product from already-loaded DOM without extra fetches", async () => {
  const storage = createPersistentStorage({
    watches: {
      iphone16: {
        key: "iphone16",
        title: "Apple iPhone 16",
        url: "https://catalog.onliner.by/mobile/apple/iphone16",
        currency: "BYN",
        lastPrice: 3000,
        lastError: "API Onliner (код 503)",
        history: [{ price: 3000, at: 1000 }],
      },
    },
  });

  const elements = new Map();
  const docEl = {
    appendChild(node) {
      node.isConnected = true;
      if (node.id) elements.set(node.id, node);
      return node;
    },
  };
  const timers = new Set();
  let fetchCalls = 0;

  const location = { href: "https://catalog.onliner.by/mobile/apple/iphone16" };
  const context = {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      timers.add(id);
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
      clearInterval(id);
    },
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    console,
    location,
    document: {
      hidden: false,
      location,
      title: "Apple iPhone 16",
      documentElement: docEl,
      body: docEl,
      getElementById: (id) => elements.get(id) || null,
      createElement: () => ({
        id: "",
        type: "",
        className: "",
        hidden: false,
        disabled: false,
        textContent: "",
        dataset: {},
        isConnected: false,
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
      }),
      querySelector(sel) {
        if (sel === "h1") return { textContent: "Apple iPhone 16" };
        if (sel === 'meta[property="product:price:amount"]') {
          return { getAttribute: (a) => (a === "content" ? "2799.00" : null) };
        }
        return null;
      },
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    addEventListener() {},
    removeEventListener() {},
    chrome: {
      storage,
      i18n: makeI18n(ruMessages),
      runtime: { id: "test-ext-id" },
    },
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("should not fetch passively");
    },
  };
  context.window = context;
  context.globalThis = context;
  context.self = context;

  const vmCtx = vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "src/shared.js"), "utf8"),
    vmCtx,
    { filename: "src/shared.js" }
  );
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8"),
    vmCtx,
    { filename: "src/content.js" }
  );

  try {
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(fetchCalls, 0, "passive DOM recovery must make zero network calls");
    const watch = storage.getAll().watches.iphone16;
    assert.equal(watch.lastPrice, 2799);
    assert.equal(watch.lastError, null);
    assert.equal(watch.history.length, 2);
  } finally {
    for (const id of timers) clearInterval(id);
  }
});

test("OPT-16: popup clears badge on open via CLEAR_BADGE message", async () => {
  const sentMessages = [];
  const storage = createPersistentStorage({
    watches: {},
    unreadDropKeys: ["p1"],
  });

  const makeEl = (id) => ({
    id,
    textContent: "",
    innerHTML: "",
    value: "",
    hidden: false,
    disabled: false,
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute() {},
    addEventListener() {},
  });
  const ids = [
    "list",
    "empty",
    "status",
    "checkNow",
    "intervalSelect",
    "exportBtn",
    "importBtn",
    "importFile",
    "importConfirm",
    "importConfirmText",
    "importMergeBtn",
    "importReplaceBtn",
    "importCancelBtn",
    "extTitle",
    "subtitleBefore",
    "emptyBefore",
    "emptyAfter",
  ];
  const elMap = new Map(ids.map((id) => [id, makeEl(id)]));

  const context = {
    URL,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    console,
    document: {
      title: "",
      getElementById: (id) => elMap.get(id) || makeEl(id),
      createElement: (tag) => makeEl(tag),
    },
    chrome: {
      storage,
      i18n: makeI18n(ruMessages),
      runtime: {
        id: "test-ext-id",
        async sendMessage(msg) {
          sentMessages.push({ ...msg });
          return { ok: true, text: "", count: 0 };
        },
      },
    },
  };
  context.window = context;
  context.globalThis = context;
  context.self = context;

  const vmCtx = vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "src/shared.js"), "utf8"),
    vmCtx,
    { filename: "src/shared.js" }
  );
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "src/popup.js"), "utf8"),
    vmCtx,
    { filename: "src/popup.js" }
  );

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sentMessages, [{ type: "CLEAR_BADGE" }]);
});
