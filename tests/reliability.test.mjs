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

function createStorageMock(initialWatches = {}) {
  let state = { watches: structuredClone(initialWatches) };
  const writes = [];
  const listeners = new Set();

  const local = {
    async get(key) {
      if (typeof key === "string") {
        return { [key]: structuredClone(state[key]) };
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
      if ("watches" in patch) {
        writes.push(structuredClone(state.watches));
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
    getState: () => structuredClone(state.watches),
    getWrites: () => writes,
  };
}

function loadShared({ fetchImpl, storageMock, messages = ruMessages } = {}) {
  const storage = storageMock || createStorageMock();
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
    fetch: fetchImpl || (async () => {
      throw new Error("fetch not mocked");
    }),
    chrome: {
      storage,
      i18n: makeI18n(messages),
      runtime: { id: "test-ext-id" },
    },
  };
  context.globalThis = context;
  context.self = context;

  const code = fs.readFileSync(path.join(ROOT, "src/shared.js"), "utf8");
  vm.runInNewContext(code, context, { filename: "src/shared.js" });
  return { OnlinerPT: context.OnlinerPT, storage, context };
}

function loadBackground({
  fetchImpl,
  initialWatches = {},
  fetchGapMs = 0,
  messages = ruMessages,
} = {}) {
  const storage = createStorageMock(initialWatches);
  const notifications = [];
  const alarms = new Map();
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
    fetch: fetchImpl,
    chrome: {
      storage,
      i18n: makeI18n(messages),
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
    checkAllWatches: context.checkAllWatches,
    OnlinerPT: context.OnlinerPT,
    storage,
    notifications,
    sendMessage: (msg) =>
      new Promise((resolve) => messageListener(msg, {}, resolve)),
  };
}

test("manifest and locales are valid and aligned for v1.2.1", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
  );
  assert.equal(manifest.version, "1.2.1");
  assert.equal(manifest.default_locale, "ru");
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "notifications"]);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://catalog.onliner.by/*",
  ]);
  assert.equal(manifest.content_scripts[0].exclude_matches, undefined);

  const ruKeys = Object.keys(ruMessages).sort();
  const enKeys = Object.keys(enMessages).sort();
  assert.deepEqual(ruKeys, enKeys);
  assert.ok(ruMessages.apiTimeout.message.length > 0);
  assert.ok(ruMessages.apiHttpError.message.includes("$1"));
  assert.ok(ruMessages.apiNetworkError.message.length > 0);
});

test("OPT-7: fetchProduct retries on 5xx and succeeds without waiting for next alarm", async () => {
  let calls = 0;
  const { OnlinerPT } = loadShared({
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        return { ok: false, status: 503, headers: new Map() };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key: "iphone16",
            full_name: "Apple iPhone 16",
            prices: { price_min: { amount: "2999.00", currency: "BYN" } },
          };
        },
      };
    },
  });

  const snap = await OnlinerPT.fetchProduct("iphone16", {
    timeoutMs: 500,
    maxRetries: 2,
    retryDelayMs: 10,
  });
  assert.equal(calls, 3);
  assert.equal(snap.price, 2999);
  assert.equal(snap.title, "Apple iPhone 16");
});

test("OPT-7: fetchProduct retries on network error and succeeds", async () => {
  let calls = 0;
  const { OnlinerPT } = loadShared({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key: "pixel9",
            name: "Google Pixel 9",
            prices: { price_min: { amount: "2100.50", currency: "BYN" } },
          };
        },
      };
    },
  });

  const snap = await OnlinerPT.fetchProduct("pixel9", {
    timeoutMs: 500,
    maxRetries: 2,
    retryDelayMs: 10,
  });
  assert.equal(calls, 2);
  assert.equal(snap.price, 2100.5);
});

test("OPT-7: fetchProduct aborts hung request on timeout and reports RU timeout error", async () => {
  let calls = 0;
  const { OnlinerPT } = loadShared({
    fetchImpl: (_url, opts) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("Aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    },
  });

  await assert.rejects(
    () =>
      OnlinerPT.fetchProduct("slow_item", {
        timeoutMs: 30,
        maxRetries: 1,
        retryDelayMs: 10,
      }),
    (err) => {
      assert.equal(err.code, "TIMEOUT");
      assert.equal(err.message, ruMessages.apiTimeout.message);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("OPT-7: fetchProduct does NOT retry non-retryable 404 and formats RU HTTP error", async () => {
  let calls = 0;
  const { OnlinerPT } = loadShared({
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 404, headers: new Map() };
    },
  });

  await assert.rejects(
    () =>
      OnlinerPT.fetchProduct("missing_item", {
        timeoutMs: 500,
        maxRetries: 2,
        retryDelayMs: 10,
      }),
    (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.message, "API Onliner (код 404)");
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("OPT-7: fetchProduct retries on HTTP 429 and succeeds", async () => {
  let calls = 0;
  const { OnlinerPT } = loadShared({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Map([["Retry-After", "0"]]),
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key: "airpods",
            name: "AirPods Pro",
            prices: { price_min: { amount: "799.00", currency: "BYN" } },
          };
        },
      };
    },
  });

  const snap = await OnlinerPT.fetchProduct("airpods", {
    timeoutMs: 500,
    maxRetries: 2,
    retryDelayMs: 10,
  });
  assert.equal(calls, 2);
  assert.equal(snap.price, 799);
});

test("OPT-5: checkAllWatches persists atomically after EACH product check", async () => {
  const persistedBeforeP2 = [];

  const { checkAllWatches, storage } = loadBackground({
    initialWatches: {
      p1: { key: "p1", title: "P1", lastPrice: 100, history: [{ price: 100, at: 1 }] },
      p2: { key: "p2", title: "P2", lastPrice: 200, history: [{ price: 200, at: 1 }] },
    },
    fetchImpl: async (url) => {
      const key = url.split("/").pop();
      if (key === "p2") {
        // By the time p2 starts fetching, p1 MUST already be saved in storage!
        persistedBeforeP2.push(storage.getState().p1.lastPrice);
      }
      const price = key === "p1" ? "90.00" : "195.00";
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key,
            name: key.toUpperCase(),
            prices: { price_min: { amount: price, currency: "BYN" } },
          };
        },
      };
    },
  });

  const res = await checkAllWatches({ notify: true });
  assert.deepEqual({ ...res }, { checked: 2, drops: 2, unavailable: 0 });
  assert.deepEqual(persistedBeforeP2, [90]);
  assert.equal(storage.getWrites().length, 2);
  assert.equal(storage.getState().p1.lastPrice, 90);
  assert.equal(storage.getState().p2.lastPrice, 195);
});

test("OPT-5: progress from earlier products survives a mid-run crash", async () => {
  const { checkAllWatches, storage } = loadBackground({
    initialWatches: {
      p1: { key: "p1", title: "P1", lastPrice: 100, history: [{ price: 100, at: 1 }] },
      p2: { key: "p2", title: "P2", lastPrice: 200, history: [{ price: 200, at: 1 }] },
    },
    fetchImpl: async (url) => {
      const key = url.split("/").pop();
      if (key === "p1") {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              key: "p1",
              name: "P1",
              prices: { price_min: { amount: "88.00", currency: "BYN" } },
            };
          },
        };
      }
      // Simulate fatal non-retryable API error on p2
      return { ok: false, status: 403, headers: new Map() };
    },
  });

  const res = await checkAllWatches({ notify: false });
  assert.deepEqual({ ...res }, { checked: 2, drops: 0, unavailable: 0 });
  assert.equal(storage.getState().p1.lastPrice, 88);
  assert.equal(storage.getState().p1.lastError, null);
  assert.equal(storage.getState().p2.lastError, "API Onliner (код 403)");
});

test("OPT-5: concurrent checkAllWatches calls share the in-flight run", async () => {
  let fetches = 0;
  const { checkAllWatches } = loadBackground({
    initialWatches: {
      p1: { key: "p1", title: "P1", lastPrice: 100, history: [{ price: 100, at: 1 }] },
    },
    fetchImpl: async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 25));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key: "p1",
            name: "P1",
            prices: { price_min: { amount: "95.00", currency: "BYN" } },
          };
        },
      };
    },
  });

  const [r1, r2] = await Promise.all([
    checkAllWatches({ notify: false }),
    checkAllWatches({ notify: false }),
  ]);
  assert.equal(fetches, 1);
  assert.deepEqual({ ...r1 }, { checked: 1, drops: 0, unavailable: 0 });
  assert.deepEqual({ ...r2 }, { checked: 1, drops: 0, unavailable: 0 });
});

test("OPT-5: concurrent unwatch mid-fetch does NOT resurrect watch or notify", async () => {
  const fetchedKeys = [];

  const { checkAllWatches, OnlinerPT, storage, notifications } = loadBackground({
    initialWatches: {
      p1: { key: "p1", title: "P1", lastPrice: 100, history: [{ price: 100, at: 1 }] },
      p2: { key: "p2", title: "P2", lastPrice: 200, history: [{ price: 200, at: 1 }] },
      p3: { key: "p3", title: "P3", lastPrice: 300, history: [{ price: 300, at: 1 }] },
    },
    fetchImpl: async (url) => {
      const key = url.split("/").pop();
      fetchedKeys.push(key);

      // While p1 is in flight, user removes p1 AND p2, and adds p4.
      if (key === "p1") {
        await OnlinerPT.unwatchProduct("p1");
        await OnlinerPT.unwatchProduct("p2");
        await OnlinerPT.watchProduct({
          key: "p4",
          title: "P4",
          price: 400,
          currency: "BYN",
        });
      }

      const price = key === "p1" ? "50.00" : "250.00";
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            key,
            name: key.toUpperCase(),
            prices: { price_min: { amount: price, currency: "BYN" } },
          };
        },
      };
    },
  });

  const res = await checkAllWatches({ notify: true });
  // p1 unwatched mid-fetch, p2 skipped before fetch, only p3 checked & dropped
  assert.deepEqual(fetchedKeys, ["p1", "p3"]);
  assert.deepEqual({ ...res }, { checked: 1, drops: 1, unavailable: 0 });

  const finalState = storage.getState();
  assert.equal(finalState.p1, undefined, "p1 must not be resurrected");
  assert.equal(finalState.p2, undefined, "p2 must stay removed");
  assert.equal(finalState.p3.lastPrice, 250, "p3 updated");
  assert.equal(finalState.p4.lastPrice, 400, "p4 added mid-check preserved");

  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].id.startsWith("drop-p3-"));
});

test("OPT-6: parseProductUrl and parseProductPageUrl handle catalog/SPA routes", () => {
  const { OnlinerPT } = loadShared();

  assert.equal(OnlinerPT.parseProductPageUrl("https://catalog.onliner.by/"), null);
  assert.equal(OnlinerPT.parseProductPageUrl("https://catalog.onliner.by/mobile"), null);
  assert.equal(
    OnlinerPT.parseProductPageUrl("https://catalog.onliner.by/mobile/apple"),
    null
  );
  assert.equal(
    OnlinerPT.parseProductPageUrl("https://catalog.onliner.by/search?query=iphone"),
    null
  );
  assert.equal(
    OnlinerPT.parseProductPageUrl("https://catalog.onliner.by/compare/a/b"),
    null
  );

  const prod = OnlinerPT.parseProductPageUrl(
    "https://catalog.onliner.by/mobile/apple/iphone16"
  );
  assert.equal(prod.key, "iphone16");
  assert.equal(prod.subpage, null);

  const hyphenProd = OnlinerPT.parseProductPageUrl(
    "https://catalog.onliner.by/router/tp-link/tl-wr841n"
  );
  assert.equal(hyphenProd.key, "tl-wr841n");

  // Subpages like reviews/prices hide the button via parseProductPageUrl
  assert.equal(
    OnlinerPT.parseProductPageUrl(
      "https://catalog.onliner.by/mobile/apple/iphone16/reviews"
    ),
    null
  );
  assert.equal(
    OnlinerPT.parseProductPageUrl(
      "https://catalog.onliner.by/mobile/apple/iphone16/prices"
    ),
    null
  );
  // While parseProductUrl still extracts the canonical key
  assert.equal(
    OnlinerPT.parseProductUrl(
      "https://catalog.onliner.by/mobile/apple/iphone16/reviews"
    ).key,
    "iphone16"
  );
});

test("OPT-6: content script injects, updates, hides, and re-injects watch button across SPA navigations", async () => {
  const storage = createStorageMock({
    mrx33: { key: "mrx33", title: "MacBook Pro", lastPrice: 5000 },
  });

  // Minimal DOM + browser event harness for content.js
  const elements = new Map();
  const docListeners = new Map();
  const winListeners = new Map();
  const navListeners = new Map();
  let observerCallback = null;

  const docEl = {
    children: [],
    appendChild(node) {
      node.isConnected = true;
      node.parentNode = docEl;
      if (!this.children.includes(node)) this.children.push(node);
      if (node.id) elements.set(node.id, node);
      return node;
    },
    removeChild(node) {
      node.isConnected = false;
      node.parentNode = null;
      this.children = this.children.filter((n) => n !== node);
      if (node.id) elements.delete(node.id);
    },
  };

  function makeElement(tag) {
    const attrs = new Map();
    const listeners = new Map();
    return {
      tagName: tag.toUpperCase(),
      id: "",
      type: "",
      className: "",
      hidden: false,
      disabled: false,
      textContent: "",
      dataset: {},
      isConnected: false,
      get title() {
        return attrs.get("title") || "";
      },
      set title(v) {
        attrs.set("title", String(v));
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
    };
  }

  const location = { href: "https://catalog.onliner.by/mobile" };
  const addTo = (map, type, fn) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  const removeFrom = (map, type, fn) => {
    map.get(type)?.delete(fn);
  };
  const emit = (map, type) => {
    for (const fn of map.get(type) || []) fn();
  };

  const timers = new Set();
  const trackedSetInterval = (fn, ms) => {
    const id = setInterval(fn, ms);
    timers.add(id);
    return id;
  };
  const trackedClearInterval = (id) => {
    timers.delete(id);
    clearInterval(id);
  };

  const context = {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
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
      documentElement: docEl,
      body: docEl,
      getElementById: (id) => elements.get(id) || null,
      createElement: makeElement,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (t, fn) => addTo(docListeners, t, fn),
      removeEventListener: (t, fn) => removeFrom(docListeners, t, fn),
    },
    MutationObserver: class {
      constructor(cb) {
        observerCallback = cb;
      }
      observe() {}
      disconnect() {}
    },
    navigation: {
      addEventListener: (t, fn) => addTo(navListeners, t, fn),
      removeEventListener: (t, fn) => removeFrom(navListeners, t, fn),
    },
    addEventListener: (t, fn) => addTo(winListeners, t, fn),
    removeEventListener: (t, fn) => removeFrom(winListeners, t, fn),
    chrome: {
      storage,
      i18n: makeI18n(ruMessages),
      runtime: { id: "test-ext-id" },
    },
    fetch: async () => {
      throw new Error("unexpected fetch");
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

  const flush = () => new Promise((r) => setTimeout(r, 25));

  try {
    // 1) Starts on category page (/mobile): button should NOT be injected.
    await flush();
    assert.equal(elements.get("onliner-pt-watch-btn"), undefined);

    // 2) SPA navigation to unwatched product via MutationObserver
    location.href = "https://catalog.onliner.by/mobile/apple/iphone16";
    observerCallback();
    await flush();
    const btn = elements.get("onliner-pt-watch-btn");
    assert.ok(btn, "button should be injected on SPA product nav");
    assert.equal(btn.hidden, false);
    assert.equal(btn.dataset.watched, "0");
    assert.equal(btn.dataset.productKey, "iphone16");
    assert.equal(btn.textContent, ruMessages.watchPrice.message);

    // Simulate tooltip set on previous product
    btn.title = "Сохранено: 2 999,00 BYN";

    // 3) SPA navigation via Navigation API to watched product (mrx33)
    location.href = "https://catalog.onliner.by/notebook/apple/mrx33";
    emit(navListeners, "navigatesuccess");
    await flush();
    assert.equal(btn.hidden, false);
    assert.equal(btn.dataset.watched, "1");
    assert.equal(btn.dataset.productKey, "mrx33");
    assert.equal(btn.textContent, ruMessages.unwatchStar.message);
    assert.equal(btn.title, "", "stale tooltip must be cleared on product switch");

    // 4) SPA navigation to reviews subpage via popstate -> button hides
    location.href = "https://catalog.onliner.by/notebook/apple/mrx33/reviews";
    emit(winListeners, "popstate");
    await flush();
    assert.equal(btn.hidden, true);

    // 5) SPA navigation back to product -> button reappears
    location.href = "https://catalog.onliner.by/notebook/apple/mrx33";
    emit(winListeners, "popstate");
    await flush();
    assert.equal(btn.hidden, false);
    assert.equal(btn.dataset.watched, "1");

    // 6) SPA re-render detaches button from DOM without URL change -> re-injected
    docEl.removeChild(btn);
    assert.equal(elements.get("onliner-pt-watch-btn"), undefined);
    observerCallback();
    await flush();
    const reinjected = elements.get("onliner-pt-watch-btn");
    assert.ok(reinjected, "button must be re-injected if removed by SPA DOM churn");
    assert.equal(reinjected.hidden, false);
    assert.equal(reinjected.dataset.watched, "1");
  } finally {
    for (const id of timers) clearInterval(id);
  }
});
