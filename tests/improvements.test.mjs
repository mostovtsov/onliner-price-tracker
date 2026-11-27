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
  initialTabs = [],
  fetchGapMs = 0,
  messages = ruMessages,
} = {}) {
  const storageMock = storage || createPersistentStorage(initialData);
  const notifications = [];
  const clearedNotifications = [];
  const alarms = new Map();
  const alarmEvents = [];
  const tabs = structuredClone(initialTabs);
  const createdTabs = [];
  const updatedTabs = [];
  const updatedWindows = [];

  let messageListener = null;
  let startupListener = null;
  let alarmListener = null;
  let notifClickListener = null;
  let notifCloseListener = null;

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
      runtime: {
        id: "test-ext-id",
        getURL: (p) => `chrome-extension://test/${p}`,
        onInstalled: { addListener() {} },
        onStartup: {
          addListener(fn) {
            startupListener = fn;
          },
        },
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
          const rec = { name, ...info };
          alarms.set(name, rec);
          alarmEvents.push(rec);
        },
        onAlarm: {
          addListener(fn) {
            alarmListener = fn;
          },
        },
      },
      notifications: {
        async create(id, opts) {
          notifications.push({ id, ...opts });
          return id;
        },
        async clear(id) {
          clearedNotifications.push(id);
          return true;
        },
        onClicked: {
          addListener(fn) {
            notifClickListener = fn;
          },
        },
        onClosed: {
          addListener(fn) {
            notifCloseListener = fn;
          },
        },
      },
      tabs: {
        async query() {
          return structuredClone(tabs);
        },
        async create(opts) {
          const tab = { id: tabs.length + 100, windowId: 1, ...opts };
          tabs.push(tab);
          createdTabs.push(tab);
          return tab;
        },
        async update(tabId, opts) {
          updatedTabs.push({ tabId, ...opts });
          return { id: tabId, ...opts };
        },
      },
      windows: {
        async update(windowId, opts) {
          updatedWindows.push({ windowId, ...opts });
          return { id: windowId, ...opts };
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
    context,
    OnlinerPT: context.OnlinerPT,
    checkAllWatches: context.checkAllWatches,
    checkIfStale: context.checkIfStale,
    handleNotificationClick: context.handleNotificationClick,
    storage: storageMock,
    notifications,
    clearedNotifications,
    alarms,
    alarmEvents,
    createdTabs,
    updatedTabs,
    updatedWindows,
    triggerStartup: () => startupListener?.(),
    triggerAlarm: (name) => alarmListener?.({ name }),
    triggerNotificationClick: (id) => notifClickListener?.(id),
    triggerNotificationClose: (id) => notifCloseListener?.(id),
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

// ---------- Manifest & i18n ----------

test("v1.2.1: manifest permissions remain minimal and RU/EN locales have matching keys & placeholders", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
  );
  assert.equal(manifest.version, "1.2.1");
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "notifications"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://catalog.onliner.by/*",
    "https://catalog.api.onliner.by/*",
  ]);

  const ruKeys = Object.keys(ruMessages).sort();
  const enKeys = Object.keys(enMessages).sort();
  assert.deepEqual(ruKeys, enKeys);

  for (const key of ruKeys) {
    assert.ok(ruMessages[key].message.length > 0, `RU empty for ${key}`);
    assert.ok(enMessages[key].message.length > 0, `EN empty for ${key}`);
    const ruPlaceholders = (ruMessages[key].message.match(/\$\d+/g) || []).sort();
    const enPlaceholders = (enMessages[key].message.match(/\$\d+/g) || []).sort();
    assert.deepEqual(
      ruPlaceholders,
      enPlaceholders,
      `Placeholder mismatch for ${key}`
    );
  }
});

// ---------- Feature 1: Notification opens product page ----------

test("F1: clicking notification opens product tab, clears notification, and survives MV3 SW restart", async () => {
  const sharedStorage = createPersistentStorage({
    watches: {
      iphone16: {
        key: "iphone16",
        title: "iPhone 16",
        url: "https://catalog.onliner.by/mobile/apple/iphone16",
        lastPrice: 3000,
        history: [{ price: 3000, at: 1000 }],
      },
    },
  });

  // Instance 1 creates the notification and persists mapping to chrome.storage.local
  const sw1 = loadBackground({
    storage: sharedStorage,
    fetchImpl: async () =>
      okProductResponse("iphone16", {
        price: 2799,
        name: "iPhone 16",
        url: "https://catalog.onliner.by/mobile/apple/iphone16",
      }),
  });

  await sw1.checkAllWatches({ notify: true });
  assert.equal(sw1.notifications.length, 1);
  const notifId = sw1.notifications[0].id;
  assert.ok(sharedStorage.getAll().notificationUrls[notifId]);

  // Simulate MV3 service worker restart: fresh VM instance sharing only chrome.storage.local
  const sw2 = loadBackground({ storage: sharedStorage });
  const result = await sw2.handleNotificationClick(notifId);

  assert.equal(result.opened, true);
  assert.equal(result.focused, false);
  assert.equal(
    sw2.createdTabs[0].url,
    "https://catalog.onliner.by/mobile/apple/iphone16"
  );
  assert.deepEqual(sw2.clearedNotifications, [notifId]);
  assert.equal(sharedStorage.getAll().notificationUrls[notifId], undefined);
});

test("F1: clicking notification focuses existing product tab instead of opening duplicate", async () => {
  const bg = loadBackground({
    initialData: {
      watches: {
        pixel9: {
          key: "pixel9",
          title: "Pixel 9",
          url: "https://catalog.onliner.by/mobile/google/pixel9",
          lastPrice: 2200,
          history: [{ price: 2200, at: 1000 }],
        },
      },
    },
    initialTabs: [
      {
        id: 42,
        windowId: 7,
        url: "https://catalog.onliner.by/mobile/google/pixel9?utm_source=test#top",
      },
    ],
    fetchImpl: async () =>
      okProductResponse("pixel9", {
        price: 1999,
        name: "Pixel 9",
        url: "https://catalog.onliner.by/mobile/google/pixel9",
      }),
  });

  await bg.checkAllWatches({ notify: true });
  const notifId = bg.notifications[0].id;
  const res = await bg.handleNotificationClick(notifId);

  assert.equal(res.opened, true);
  assert.equal(res.focused, true);
  assert.equal(res.tabId, 42);
  assert.equal(bg.createdTabs.length, 0);
  assert.deepEqual(bg.updatedTabs, [{ tabId: 42, active: true }]);
  assert.deepEqual(bg.updatedWindows, [{ windowId: 7, focused: true }]);
  assert.deepEqual(bg.clearedNotifications, [notifId]);
});

test("F1: clicking delisted notification opens product page and falls back to watch URL if map missing", async () => {
  const bg = loadBackground({
    initialData: {
      watches: {
        oldcam: {
          key: "oldcam",
          title: "Old Camera",
          url: "https://catalog.onliner.by/photo/sony/oldcam",
          lastPrice: 1500,
          history: [{ price: 1500, at: 1000 }],
        },
      },
    },
    fetchImpl: async () => ({ ok: false, status: 404, headers: new Map() }),
  });

  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 1);
  const notifId = bg.notifications[0].id;
  assert.ok(notifId.startsWith("delisted-oldcam-"));

  // Simulate map entry cleared via onClosed or eviction; fallback key lookup still works
  bg.triggerNotificationClose(notifId);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(bg.storage.getAll().notificationUrls[notifId], undefined);

  const res = await bg.handleNotificationClick(notifId);
  assert.equal(res.opened, true);
  assert.equal(
    bg.createdTabs[0].url,
    "https://catalog.onliner.by/photo/sony/oldcam"
  );
});

// ---------- Feature 2: Target price alerts ----------

test("F2: target price alert triggers at/below target, avoids spam, re-alerts on further drop or rise+re-drop", async () => {
  const prices = [2200, 2000, 2000, 2000, 1950, 1980, 2100, 1990];
  let idx = 0;

  const bg = loadBackground({
    initialData: {
      watches: {
        laptop: {
          key: "laptop",
          title: "Laptop Pro",
          url: "https://catalog.onliner.by/notebook/apple/laptop",
          currency: "BYN",
          lastPrice: 2500,
          targetPrice: 2000,
          history: [{ price: 2500, at: 1000 }],
        },
      },
    },
    fetchImpl: async () =>
      okProductResponse("laptop", {
        price: prices[idx++],
        name: "Laptop Pro",
        url: "https://catalog.onliner.by/notebook/apple/laptop",
      }),
  });

  // 1) 2500 -> 2200 (still above 2000 target): NO notification
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 0);

  // 2) 2200 -> 2000 (hits target): NOTIFY #1
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 1);
  assert.ok(bg.notifications[0].id.startsWith("target-laptop-"));
  assert.equal(bg.notifications[0].title, ruMessages.targetPriceReachedTitle.message);
  assert.equal(bg.storage.getAll().watches.laptop.targetNotifiedPrice, 2000);

  // 3) stays at 2000: NO spam
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 1);

  // 4) stays at 2000 again: NO spam
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 1);

  // 5) drops further to 1950 (< 2000): NOTIFY #2
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 2);
  assert.equal(bg.storage.getAll().watches.laptop.targetNotifiedPrice, 1950);

  // 6) rebounds slightly to 1980 (still <= target, but > last notified 1950): NO spam
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 2);
  assert.equal(bg.storage.getAll().watches.laptop.targetNotifiedPrice, 1950);

  // 7) rises strictly above target to 2100: NO notify, latch resets to null
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 2);
  assert.equal(bg.storage.getAll().watches.laptop.targetNotifiedPrice, null);

  // 8) drops back below target to 1990: NOTIFY #3
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 3);
  assert.equal(bg.storage.getAll().watches.laptop.targetNotifiedPrice, 1990);
});

test("F2: clearing target price reverts to standard price-drop notifications", async () => {
  const { OnlinerPT, storage } = loadShared({
    storage: createPersistentStorage({
      watches: {
        tv: {
          key: "tv",
          title: "OLED TV",
          lastPrice: 3000,
          targetPrice: 2500,
          targetNotifiedPrice: 2400,
          history: [{ price: 3000, at: 1000 }],
        },
      },
    }),
  });

  // Invalid inputs reject
  await assert.rejects(() => OnlinerPT.setWatchTargetPrice("tv", "-5"));
  await assert.rejects(() => OnlinerPT.setWatchTargetPrice("tv", "abc"));

  // Valid update resets targetNotifiedPrice
  await OnlinerPT.setWatchTargetPrice("tv", "2 650,50");
  assert.equal(storage.getAll().watches.tv.targetPrice, 2650.5);
  assert.equal(storage.getAll().watches.tv.targetNotifiedPrice, null);

  // Clear target price
  await OnlinerPT.setWatchTargetPrice("tv", "");
  assert.equal(storage.getAll().watches.tv.targetPrice, null);

  // Now normal price-drop rule applies
  const alert = OnlinerPT.evaluatePriceAlert(
    storage.getAll().watches.tv,
    3000,
    2950
  );
  assert.equal(alert.shouldNotify, true);
  assert.equal(alert.type, "drop");
});

// ---------- Feature 3: Check prices on Chrome startup ----------

test("F3: onStartup checks watches when stale and skips when fresh", async () => {
  const now = Date.now();
  const fourHoursAgo = now - 4 * 60 * 60 * 1000;
  const tenMinAgo = now - 10 * 60 * 1000;

  let fetchesFresh = 0;
  const freshBg = loadBackground({
    initialData: {
      settings: { checkIntervalHours: 3 },
      lastCheckAt: tenMinAgo,
      watches: {
        p1: {
          key: "p1",
          title: "P1",
          lastPrice: 100,
          lastCheckedAt: tenMinAgo,
          history: [{ price: 100, at: tenMinAgo }],
        },
      },
    },
    fetchImpl: async () => {
      fetchesFresh += 1;
      return okProductResponse("p1", { price: 95 });
    },
  });

  freshBg.triggerStartup();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetchesFresh, 0, "fresh watches should not be checked on startup");

  let fetchesStale = 0;
  const staleBg = loadBackground({
    initialData: {
      settings: { checkIntervalHours: 3 },
      // No lastCheckAt so top-level SW init doesn't run before triggerStartup
      watches: {
        p1: {
          key: "p1",
          title: "P1",
          lastPrice: 100,
          lastCheckedAt: fourHoursAgo,
          history: [{ price: 100, at: fourHoursAgo }],
        },
      },
    },
    fetchImpl: async () => {
      fetchesStale += 1;
      return okProductResponse("p1", { price: 90 });
    },
  });

  staleBg.triggerStartup();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fetchesStale, 1, "stale watches should be checked on startup");
  assert.equal(staleBg.storage.getAll().watches.p1.lastPrice, 90);
  assert.ok(staleBg.storage.getAll().lastCheckAt >= now);
});

test("F3: simultaneous startup + alarm checks dedupe via in-flight lock", async () => {
  const old = Date.now() - 10 * 60 * 60 * 1000;
  let fetches = 0;

  const bg = loadBackground({
    initialData: {
      settings: { checkIntervalHours: 3 },
      lastCheckAt: old,
      watches: {
        p1: {
          key: "p1",
          title: "P1",
          lastPrice: 500,
          lastCheckedAt: old,
          history: [{ price: 500, at: old }],
        },
      },
    },
    fetchImpl: async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 35));
      return okProductResponse("p1", { price: 480 });
    },
  });

  // Top-level SW init + onStartup + checkIfStale + alarm all fire concurrently
  bg.triggerStartup();
  const [r1, r2] = await Promise.all([
    bg.checkIfStale({ notify: true }),
    bg.checkAllWatches({ notify: true }),
  ]);

  assert.equal(fetches, 1, "concurrent startup checks must not double-fetch");
  assert.equal(r1.checked, 1);
  assert.equal(r2.checked, 1);
});

// ---------- Feature 4: Notify when product delisted / unavailable ----------

test("F4: detects unavailable (prices null / 0 offers / 404), notifies once, and clears flag when back in stock", async () => {
  const responses = [
    // 1) prices: null -> transitions available -> unavailable (notifies once)
    okProductResponse("gpu", { price: null, name: "RTX 5080" }),
    // 2) still 0 offers -> stays unavailable (NO second notification)
    {
      ok: true,
      status: 200,
      async json() {
        return {
          key: "gpu",
          full_name: "RTX 5080",
          prices: {
            price_min: { amount: "4000", currency: "BYN" },
            offers: { count: 0 },
          },
        };
      },
    },
    // 3) back in stock with lower price -> clears unavailable flag & triggers price drop alert
    okProductResponse("gpu", { price: 3700, name: "RTX 5080", offersCount: 3 }),
    // 4) HTTP 404 -> transitions to delisted & notifies once
    { ok: false, status: 404, headers: new Map() },
    // 5) HTTP 404 again -> NO duplicate notification
    { ok: false, status: 404, headers: new Map() },
  ];
  let step = 0;

  const bg = loadBackground({
    initialData: {
      watches: {
        gpu: {
          key: "gpu",
          title: "RTX 5080",
          url: "https://catalog.onliner.by/videocard/nvidia/gpu",
          lastPrice: 4000,
          history: [{ price: 4000, at: 1000 }],
        },
      },
    },
    fetchImpl: async () => responses[step++],
  });

  // 1) prices: null
  const r1 = await bg.checkAllWatches({ notify: true });
  assert.equal(r1.unavailable, 1);
  assert.equal(bg.storage.getAll().watches.gpu.unavailable, true);
  assert.equal(bg.storage.getAll().watches.gpu.unavailableReason, "no_offers");
  assert.equal(bg.notifications.length, 1);
  assert.equal(bg.notifications[0].title, ruMessages.productUnavailableTitle.message);
  assert.ok(bg.notifications[0].message.includes(ruMessages.productNoOffersBody.message));

  // 2) offers.count === 0 while already unavailable -> no duplicate notification
  const r2 = await bg.checkAllWatches({ notify: true });
  assert.equal(r2.unavailable, 1);
  assert.equal(bg.notifications.length, 1);

  // 3) returns in stock at 3700 -> clears unavailable, sends drop alert
  const r3 = await bg.checkAllWatches({ notify: true });
  assert.equal(r3.unavailable, 0);
  assert.equal(r3.drops, 1);
  assert.equal(bg.storage.getAll().watches.gpu.unavailable, false);
  assert.equal(bg.storage.getAll().watches.gpu.unavailableReason, null);
  assert.equal(bg.storage.getAll().watches.gpu.unavailableSince, null);
  assert.equal(bg.storage.getAll().watches.gpu.lastPrice, 3700);
  assert.equal(bg.notifications.length, 2);
  assert.ok(bg.notifications[1].id.startsWith("drop-gpu-"));

  // 4) 404 delisted -> notifies once with delisted body
  const r4 = await bg.checkAllWatches({ notify: true });
  assert.equal(r4.unavailable, 1);
  assert.equal(bg.storage.getAll().watches.gpu.unavailable, true);
  assert.equal(bg.storage.getAll().watches.gpu.unavailableReason, "delisted");
  assert.equal(bg.notifications.length, 3);
  assert.ok(bg.notifications[2].message.includes(ruMessages.productDelistedBody.message));

  // 5) 404 again -> no duplicate notification
  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.notifications.length, 3);
});

test("F4: transient 503 error does NOT mark product unavailable or send delisted notification", async () => {
  const bg = loadBackground({
    initialData: {
      watches: {
        item: {
          key: "item",
          title: "Item",
          lastPrice: 500,
          history: [{ price: 500, at: 1000 }],
        },
      },
    },
    fetchImpl: async () => ({ ok: false, status: 503, headers: new Map() }),
  });

  await bg.checkAllWatches({ notify: true });
  assert.equal(bg.storage.getAll().watches.item.unavailable, undefined);
  assert.equal(bg.notifications.length, 0);
  assert.ok(bg.storage.getAll().watches.item.lastError.includes("503"));
});

// ---------- Feature 5: Configurable check interval ----------

test("F5: SET_CHECK_INTERVAL persists setting and immediately reschedules chrome.alarms", async () => {
  const bg = loadBackground();
  await new Promise((r) => setTimeout(r, 15));

  // Default alarm is 3 hours (180 min)
  const initialAlarm = bg.alarms.get("onliner-price-check");
  assert.equal(initialAlarm.periodInMinutes, 180);

  // Change to 6h
  const res6 = await bg.sendMessage({
    type: "SET_CHECK_INTERVAL",
    checkIntervalHours: 6,
  });
  assert.equal(res6.ok, true);
  assert.equal(res6.settings.checkIntervalHours, 6);
  assert.equal(res6.periodMinutes, 360);
  assert.equal(bg.alarms.get("onliner-price-check").periodInMinutes, 360);
  assert.equal(bg.storage.getAll().settings.checkIntervalHours, 6);

  // Change to 1h
  const res1 = await bg.sendMessage({
    type: "SET_CHECK_INTERVAL",
    checkIntervalHours: 1,
  });
  assert.equal(res1.periodMinutes, 60);
  assert.equal(bg.alarms.get("onliner-price-check").periodInMinutes, 60);

  // Invalid value falls back to default 3h
  const resInvalid = await bg.sendMessage({
    type: "SET_CHECK_INTERVAL",
    checkIntervalHours: 99,
  });
  assert.equal(resInvalid.settings.checkIntervalHours, 3);
  assert.equal(bg.alarms.get("onliner-price-check").periodInMinutes, 180);

  // GET_STATUS reflects active setting
  const status = await bg.sendMessage({ type: "GET_STATUS" });
  assert.equal(status.checkIntervalHours, 3);
  assert.equal(status.periodMinutes, 180);
});

// ---------- Feature 6: Time-based price chart ----------

test("F6: computeChartLayout plots X proportional to timestamps, handles single/duplicate/long-gap cases", () => {
  const { OnlinerPT } = loadShared();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const base = Date.UTC(2026, 10, 1, 10, 0, 0);

  // 1) Proportional X: t=0, t=1h, t=10h -> middle point at 10% of plotW, NOT 50%
  const prop = OnlinerPT.computeChartLayout(
    [
      { price: 100, at: base },
      { price: 90, at: base + 1 * HOUR },
      { price: 80, at: base + 10 * HOUR },
    ],
    { width: 216, height: 92, padLeft: 8, padRight: 8 }
  );
  assert.equal(prop.plotW, 200);
  assert.equal(prop.points[0].x, 8);
  assert.equal(prop.points[1].x, 28); // 8 + 0.1 * 200
  assert.equal(prop.points[2].x, 208);
  assert.equal(prop.ticks.length, 3);
  assert.match(prop.ticks[0].label, /^\d{2}:\d{2}$/);

  // 2) Single point: centered X, 1 centered label, no NaN
  const single = OnlinerPT.computeChartLayout([{ price: 500, at: base }], {
    width: 216,
    height: 92,
    padLeft: 8,
    padRight: 8,
  });
  assert.equal(single.points.length, 1);
  assert.equal(single.points[0].x, 108);
  assert.ok(Number.isFinite(single.points[0].y));
  assert.equal(single.ticks.length, 1);
  assert.equal(single.ticks[0].align, "center");
  assert.match(single.ticks[0].label, /^\d{2}\.\d{2} \d{2}:\d{2}$/);

  // 3) Duplicate timestamps: collapsed cleanly, all-identical timestamps do not divide by zero
  const dupAll = OnlinerPT.computeChartLayout(
    [
      { price: 100, at: base },
      { price: 95, at: base },
    ],
    { width: 216, height: 92, padLeft: 8, padRight: 8 }
  );
  assert.equal(dupAll.points.length, 1);
  assert.equal(dupAll.points[0].price, 95);
  assert.equal(dupAll.points[0].x, 108);

  // 4) Unsorted timestamps + duplicate in middle
  const unsorted = OnlinerPT.computeChartLayout(
    [
      { price: 80, at: base + 4 * DAY },
      { price: 100, at: base },
      { price: 90, at: base + 2 * DAY },
      { price: 88, at: base + 2 * DAY },
    ],
    { width: 216, height: 92 }
  );
  assert.deepEqual(
    Array.from(unsorted.points.map((p) => p.price)),
    [100, 88, 80]
  );
  assert.match(unsorted.ticks[0].label, /^\d{2}\.\d{2}$/);

  // 5) Long gap detection: 3h, 3h, then 15-day gap
  const gapped = OnlinerPT.computeChartLayout(
    [
      { price: 100, at: base },
      { price: 99, at: base + 3 * HOUR },
      { price: 98, at: base + 6 * HOUR },
      { price: 85, at: base + 15 * DAY },
    ],
    { width: 340, height: 92 }
  );
  assert.equal(gapped.segments.length, 3);
  assert.equal(gapped.segments[0].isLongGap, false);
  assert.equal(gapped.segments[1].isLongGap, false);
  assert.equal(gapped.segments[2].isLongGap, true);
});

// ---------- Feature 7: Export and import history ----------

test("F7: export/import validates schema strictly and supports merge & replace cleanly", async () => {
  const storage = createPersistentStorage({
    settings: { checkIntervalHours: 3 },
    watches: {
      existing_only: {
        key: "existing_only",
        title: "Existing Item",
        url: "https://catalog.onliner.by/mobile/test/existing_only",
        currency: "BYN",
        lastPrice: 500,
        lastCheckedAt: 2000,
        addedAt: 1000,
        history: [{ price: 500, at: 2000 }],
      },
      shared_item: {
        key: "shared_item",
        title: "Shared Item",
        url: "https://catalog.onliner.by/mobile/test/shared_item",
        currency: "BYN",
        lastPrice: 900,
        lastCheckedAt: 5000,
        addedAt: 1500,
        history: [
          { price: 1000, at: 1500 },
          { price: 900, at: 5000 },
        ],
      },
    },
  });

  const { OnlinerPT } = loadShared({ storage });

  // Export payload round-trip check
  const exported = OnlinerPT.buildExportPayload({
    watches: await OnlinerPT.getWatches(),
    settings: await OnlinerPT.getSettings(),
  });
  assert.equal(exported.app, "onliner-price-tracker");
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.settings.checkIntervalHours, 3);
  assert.equal(Object.keys(exported.watches).length, 2);

  // Schema rejections
  assert.equal(OnlinerPT.validateImportPayload(null).ok, false);
  assert.equal(OnlinerPT.validateImportPayload({ app: "other", watches: {} }).ok, false);
  assert.equal(OnlinerPT.validateImportPayload({ schemaVersion: 99, watches: {} }).ok, false);
  assert.equal(
    OnlinerPT.validateImportPayload({
      app: "onliner-price-tracker",
      schemaVersion: 1,
      watches: {
        bad: { key: "bad", url: "javascript:alert(1)", history: [] },
      },
    }).ok,
    false
  );
  assert.equal(
    OnlinerPT.validateImportPayload({
      app: "onliner-price-tracker",
      schemaVersion: 1,
      watches: {
        bad: { key: "bad", history: "not-an-array" },
      },
    }).ok,
    false
  );
  assert.equal(
    OnlinerPT.validateImportPayload({
      app: "onliner-price-tracker",
      schemaVersion: 1,
      settings: { checkIntervalHours: 7 },
      watches: {},
    }).ok,
    false
  );

  // Valid backup payload to import
  const backup = {
    app: "onliner-price-tracker",
    schemaVersion: 1,
    exportedAt: "2026-11-26T00:00:00.000Z",
    settings: { checkIntervalHours: 12 },
    watches: {
      shared_item: {
        key: "shared_item",
        title: "Shared Item Updated",
        url: "https://catalog.onliner.by/mobile/test/shared_item",
        currency: "BYN",
        lastPrice: 850,
        lastCheckedAt: 7000,
        addedAt: 1200,
        targetPrice: 800,
        history: [
          { price: 1000, at: 1500 },
          { price: 950, at: 3000 },
          { price: 850, at: 7000 },
        ],
      },
      new_item: {
        key: "new_item",
        title: "Brand New",
        url: "https://catalog.onliner.by/mobile/test/new_item",
        currency: "BYN",
        lastPrice: 300,
        lastCheckedAt: 6000,
        addedAt: 6000,
        history: [{ price: 300, at: 6000 }],
      },
    },
  };

  // Merge mode: keeps existing_only, adds new_item, merges history for shared_item
  const mergeRes = await OnlinerPT.importBackup(backup, { mode: "merge" });
  assert.equal(mergeRes.ok, true);
  assert.equal(mergeRes.watchCount, 3);
  assert.equal(mergeRes.settingsUpdated, true);

  const afterMerge = storage.getAll();
  assert.equal(afterMerge.settings.checkIntervalHours, 12);
  assert.ok(afterMerge.watches.existing_only);
  assert.ok(afterMerge.watches.new_item);
  assert.equal(afterMerge.watches.shared_item.lastPrice, 850);
  assert.equal(afterMerge.watches.shared_item.targetPrice, 800);
  assert.equal(afterMerge.watches.shared_item.addedAt, 1200);
  assert.deepEqual(
    Array.from(afterMerge.watches.shared_item.history.map((p) => p.at)),
    [1500, 3000, 5000, 7000]
  );

  // Replace mode: drops existing_only, keeps only backup watches
  const replaceRes = await OnlinerPT.importBackup(backup, { mode: "replace" });
  assert.equal(replaceRes.ok, true);
  assert.equal(replaceRes.watchCount, 2);

  const afterReplace = storage.getAll();
  assert.equal(afterReplace.watches.existing_only, undefined);
  assert.ok(afterReplace.watches.shared_item);
  assert.ok(afterReplace.watches.new_item);
});
