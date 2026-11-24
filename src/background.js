/* global importScripts, OnlinerPT */
importScripts("shared.js");

const {
  CHECK_ALARM,
  CHECK_PERIOD_MINUTES,
  FETCH_GAP_MS,
  getWatches,
  setWatches,
  appendHistory,
  fetchProduct,
  sleep,
  formatPrice,
  t,
} = OnlinerPT;

async function ensureAlarm() {
  const existing = await chrome.alarms.get(CHECK_ALARM);
  if (!existing) {
    chrome.alarms.create(CHECK_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: CHECK_PERIOD_MINUTES,
    });
  }
}

async function notifyPriceDrop(watch, previous, next) {
  const drop = previous - next;
  const title = t("priceDroppedTitle");
  const message = `${watch.title}\n${formatPrice(previous, watch.currency)} → ${formatPrice(next, watch.currency)} (−${formatPrice(drop, watch.currency)})`;
  await chrome.notifications.create(`drop-${watch.key}-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
    priority: 2,
  });
}

async function checkAllWatches({ notify = true } = {}) {
  const watches = await getWatches();
  const keys = Object.keys(watches);
  if (!keys.length) return { checked: 0, drops: 0 };

  let drops = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const watch = watches[key];
    try {
      const snapshot = await fetchProduct(key);
      if (snapshot.price == null) {
        watch.lastCheckedAt = Date.now();
        watch.lastError = t("noPriceInApi");
        continue;
      }

      const previous =
        watch.lastPrice != null
          ? watch.lastPrice
          : watch.history?.length
            ? watch.history[watch.history.length - 1].price
            : null;

      watch.title = snapshot.title || watch.title;
      watch.url = snapshot.url || watch.url;
      watch.image = snapshot.image || watch.image;
      watch.currency = snapshot.currency || watch.currency || "BYN";
      watch.history = appendHistory(watch, snapshot.price, snapshot.fetchedAt);
      watch.lastCheckedAt = snapshot.fetchedAt;
      watch.lastError = null;

      if (
        notify &&
        previous != null &&
        snapshot.price < previous - 0.009
      ) {
        drops += 1;
        await notifyPriceDrop(watch, previous, snapshot.price);
      }

      watch.lastPrice = snapshot.price;
    } catch (err) {
      watch.lastCheckedAt = Date.now();
      watch.lastError = String(err?.message || err);
      console.warn("[OnlinerPT] check failed", key, err);
    }

    watches[key] = watch;
    if (i < keys.length - 1) {
      await sleep(FETCH_GAP_MS);
    }
  }

  await setWatches(watches);
  return { checked: keys.length, drops };
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  // Initial quiet check shortly after install (no spam if empty).
  chrome.alarms.create("onliner-price-check-once", { delayInMinutes: 0.2 });
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (
    alarm.name === CHECK_ALARM ||
    alarm.name === "onliner-price-check-once"
  ) {
    await ensureAlarm();
    await checkAllWatches({ notify: true });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") {
      sendResponse({ ok: false, error: "Bad message" });
      return;
    }
    if (message.type === "CHECK_NOW") {
      const result = await checkAllWatches({
        notify: message.notify !== false,
      });
      sendResponse({ ok: true, ...result });
      return;
    }
    if (message.type === "GET_STATUS") {
      const alarm = await chrome.alarms.get(CHECK_ALARM);
      sendResponse({
        ok: true,
        periodMinutes: CHECK_PERIOD_MINUTES,
        alarm,
      });
      return;
    }
    sendResponse({ ok: false, error: "Unknown type" });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });
  return true;
});

ensureAlarm();
