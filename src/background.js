/* global importScripts, OnlinerPT */
importScripts("shared.js");

const {
  CHECK_ALARM,
  STORAGE_KEY,
  SETTINGS_KEY,
  FETCH_GAP_MS,
  BADGE_DROP_COLOR,
  BADGE_TEXT_COLOR,
  isCatalogOnlinerUrl,
  parseProductUrl,
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
  updateWatchIfPresent,
  appendHistory,
  evaluatePriceAlert,
  fetchProductWithFallback,
  sleep,
  formatPrice,
  t,
  tPlural,
} = OnlinerPT;

let activeCheckPromise = null;
let activeStaleCheckPromise = null;

async function applyActionBadge(count) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  const text = formatBadgeText(safeCount);
  if (!chrome.action) {
    return { text, count: safeCount };
  }
  if (typeof chrome.action.setBadgeText === "function") {
    await chrome.action.setBadgeText({ text });
  }
  if (safeCount > 0) {
    if (typeof chrome.action.setBadgeBackgroundColor === "function") {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_DROP_COLOR });
    }
    if (typeof chrome.action.setBadgeTextColor === "function") {
      await chrome.action.setBadgeTextColor({ color: BADGE_TEXT_COLOR });
    }
  }
  if (typeof chrome.action.setTitle === "function") {
    const title =
      safeCount > 0
        ? `${t("extName")} — ${tPlural("badgeDrops", safeCount)}`
        : t("extName");
    await chrome.action.setTitle({ title });
  }
  return { text, count: safeCount };
}

async function syncActionBadge() {
  const [watches, keys] = await Promise.all([
    getWatches(),
    getUnreadDropKeys(),
  ]);
  const validKeys = keys.filter((k) => Boolean(watches[k]));
  if (validKeys.length !== keys.length) {
    await pruneUnreadDropKeys(watches);
  }
  return applyActionBadge(validKeys.length);
}

async function ensureAlarm({ forceReschedule = false } = {}) {
  const { checkIntervalHours } = await getSettings();
  const periodInMinutes = checkIntervalHours * 60;
  const existing = await chrome.alarms.get(CHECK_ALARM);
  if (
    forceReschedule ||
    !existing ||
    existing.periodInMinutes !== periodInMinutes
  ) {
    if (existing && typeof chrome.alarms.clear === "function") {
      await chrome.alarms.clear(CHECK_ALARM);
    }
    chrome.alarms.create(CHECK_ALARM, {
      delayInMinutes: periodInMinutes,
      periodInMinutes,
    });
  }
  return { checkIntervalHours, periodInMinutes };
}

async function createProductNotification(notificationId, watch, { title, message, priority = 2 }) {
  const safeUrl =
    isCatalogOnlinerUrl(watch?.url) || "https://catalog.onliner.by/";
  await saveNotificationTarget(notificationId, {
    key: watch?.key || null,
    url: safeUrl,
  });
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
    priority,
  });
  return notificationId;
}

async function notifyPriceDrop(watch, previous, next) {
  const drop = previous - next;
  const title = t("priceDroppedTitle");
  const message = `${watch.title}\n${formatPrice(previous, watch.currency)} → ${formatPrice(next, watch.currency)} (−${formatPrice(drop, watch.currency)})`;
  return createProductNotification(`drop-${watch.key}-${Date.now()}`, watch, {
    title,
    message,
    priority: 2,
  });
}

async function notifyTargetPriceReached(watch, next) {
  const title = t("targetPriceReachedTitle");
  const body = t("targetPriceReachedBody", [
    formatPrice(next, watch.currency),
    formatPrice(watch.targetPrice, watch.currency),
  ]);
  const message = `${watch.title}\n${body}`;
  return createProductNotification(`target-${watch.key}-${Date.now()}`, watch, {
    title,
    message,
    priority: 2,
  });
}

async function notifyProductUnavailable(watch, reason) {
  const title = t("productUnavailableTitle");
  const body =
    reason === "delisted"
      ? t("productDelistedBody")
      : t("productNoOffersBody");
  const message = `${watch.title}\n${body}`;
  return createProductNotification(
    `delisted-${watch.key}-${Date.now()}`,
    watch,
    {
      title,
      message,
      priority: 1,
    }
  );
}

function stripHash(urlString) {
  try {
    const u = new URL(urlString);
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return urlString;
  }
}

async function openOrFocusProductUrl(targetUrl, productKey = null) {
  const safeUrl = isCatalogOnlinerUrl(targetUrl);
  if (!safeUrl || !chrome.tabs) {
    return { opened: false, focused: false, url: null };
  }

  const targetRef = parseProductUrl(safeUrl);
  const normalizedTarget = stripHash(safeUrl);

  if (typeof chrome.tabs.query === "function") {
    try {
      const tabs = await chrome.tabs.query({
        url: "https://catalog.onliner.by/*",
      });
      const existing = (tabs || []).find((tab) => {
        if (!tab || tab.id == null || !tab.url) return false;
        const tabRef = parseProductUrl(tab.url);
        if (targetRef && tabRef) {
          if (!tabRef.subpage && tabRef.url === targetRef.url) return true;
          if (productKey && !tabRef.subpage && tabRef.key === productKey) {
            return true;
          }
        }
        return stripHash(tab.url) === normalizedTarget;
      });

      if (existing && typeof chrome.tabs.update === "function") {
        await chrome.tabs.update(existing.id, { active: true });
        if (
          existing.windowId != null &&
          chrome.windows &&
          typeof chrome.windows.update === "function"
        ) {
          try {
            await chrome.windows.update(existing.windowId, { focused: true });
          } catch {
            /* ignore window focus errors */
          }
        }
        return {
          opened: true,
          focused: true,
          tabId: existing.id,
          url: safeUrl,
        };
      }
    } catch {
      /* fallback to tabs.create if query fails */
    }
  }

  if (typeof chrome.tabs.create === "function") {
    const created = await chrome.tabs.create({ url: safeUrl });
    return {
      opened: true,
      focused: false,
      tabId: created?.id ?? null,
      url: safeUrl,
    };
  }

  return { opened: false, focused: false, url: safeUrl };
}

async function handleNotificationClick(notificationId) {
  const saved = await consumeNotificationTarget(notificationId);
  let key = saved?.key || parseNotificationKey(notificationId);
  let url = saved?.url || null;

  if (!url && key) {
    const watches = await getWatches();
    url = isCatalogOnlinerUrl(watches[key]?.url) || null;
  }

  if (chrome.notifications && typeof chrome.notifications.clear === "function") {
    try {
      await chrome.notifications.clear(notificationId);
    } catch {
      /* ignore clear failures */
    }
  }

  if (key) {
    await removeUnreadDropKey(key);
    await syncActionBadge();
  }

  if (!url) {
    return { opened: false, focused: false, url: null };
  }

  return openOrFocusProductUrl(url, key);
}

async function runCheckAllWatches({ notify = true } = {}) {
  const initialWatches = await getWatches();
  const keys = Object.keys(initialWatches);
  if (!keys.length) return { checked: 0, drops: 0, unavailable: 0 };

  let checked = 0;
  let drops = 0;
  let unavailableCount = 0;
  let didFetch = false;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];

    // Skip products that were unwatched before their turn in this run.
    const beforeFetch = await getWatches();
    let currentWatch = beforeFetch[key];
    if (!currentWatch) continue;

    if (didFetch) {
      await sleep(FETCH_GAP_MS);
      const afterGap = await getWatches();
      currentWatch = afterGap[key];
      if (!currentWatch) continue;
    }
    didFetch = true;

    try {
      const snapshot = await fetchProductWithFallback(key, {
        fallbackUrl: currentWatch.url || null,
      });
      let alertInfo = null;
      let unavailableNotify = null;

      const result = await updateWatchIfPresent(key, (watch) => {
        watch.title = snapshot.title || watch.title;
        watch.url = snapshot.url || watch.url;
        watch.image = snapshot.image || watch.image;
        watch.currency = snapshot.currency || watch.currency || "BYN";
        watch.lastCheckedAt = snapshot.fetchedAt;

        if (snapshot.unavailable || snapshot.price == null) {
          const wasUnavailable = Boolean(watch.unavailable);
          const reason = snapshot.unavailableReason || "no_offers";
          watch.unavailable = true;
          watch.unavailableReason = reason;
          watch.unavailableSince = wasUnavailable
            ? watch.unavailableSince || snapshot.fetchedAt
            : snapshot.fetchedAt;
          watch.lastError = null;
          if (notify && !wasUnavailable) {
            unavailableNotify = {
              watch: { ...watch },
              reason,
            };
          }
          return watch;
        }

        const previous =
          watch.lastPrice != null
            ? watch.lastPrice
            : watch.history?.length
              ? watch.history[watch.history.length - 1].price
              : null;

        watch.unavailable = false;
        watch.unavailableSince = null;
        watch.unavailableReason = null;
        watch.history = appendHistory(watch, snapshot.price, snapshot.fetchedAt);
        watch.lastError = null;
        watch.lastPrice = snapshot.price;

        const alert = evaluatePriceAlert(watch, previous, snapshot.price);
        if (alert.shouldNotify) {
          if (notify) {
            watch.targetNotifiedPrice = alert.nextTargetNotifiedPrice;
            alertInfo = {
              type: alert.type,
              watch: { ...watch },
              previous,
              next: snapshot.price,
            };
          }
        } else {
          watch.targetNotifiedPrice = alert.nextTargetNotifiedPrice;
        }
        return watch;
      });

      if (result.removed) continue;

      checked += 1;
      if (snapshot.unavailable || snapshot.price == null) {
        unavailableCount += 1;
        if (unavailableNotify) {
          await notifyProductUnavailable(
            unavailableNotify.watch,
            unavailableNotify.reason
          );
        }
      } else if (alertInfo) {
        drops += 1;
        if (alertInfo.type === "target") {
          await notifyTargetPriceReached(alertInfo.watch, alertInfo.next);
        } else {
          await notifyPriceDrop(
            alertInfo.watch,
            alertInfo.previous,
            alertInfo.next
          );
        }
        await addUnreadDropKey(key);
        await syncActionBadge();
      }
    } catch (err) {
      if (err?.status === 404 || err?.status === 410) {
        let unavailableNotify = null;
        const now = Date.now();
        const result = await updateWatchIfPresent(key, (watch) => {
          const wasUnavailable = Boolean(watch.unavailable);
          watch.unavailable = true;
          watch.unavailableReason = "delisted";
          watch.unavailableSince = wasUnavailable
            ? watch.unavailableSince || now
            : now;
          watch.lastCheckedAt = now;
          watch.lastError = null;
          if (notify && !wasUnavailable) {
            unavailableNotify = {
              watch: { ...watch },
              reason: "delisted",
            };
          }
          return watch;
        });
        if (!result.removed) {
          checked += 1;
          unavailableCount += 1;
          if (unavailableNotify) {
            await notifyProductUnavailable(
              unavailableNotify.watch,
              unavailableNotify.reason
            );
          }
        }
        continue;
      }

      const result = await updateWatchIfPresent(key, (watch) => {
        watch.lastCheckedAt = Date.now();
        watch.lastError = String(err?.message || err);
        return watch;
      });
      if (!result.removed) {
        checked += 1;
      }
      console.warn("[OnlinerPT] check failed", key, err);
    }
  }

  if (checked > 0) {
    await setLastCheckAt(Date.now());
  }

  return { checked, drops, unavailable: unavailableCount };
}

function checkAllWatches(options = {}) {
  if (activeCheckPromise) return activeCheckPromise;
  activeCheckPromise = runCheckAllWatches(options).finally(() => {
    activeCheckPromise = null;
  });
  return activeCheckPromise;
}

async function checkIfStale({ notify = true, requireLastCheckAt = false } = {}) {
  if (activeCheckPromise) return activeCheckPromise;
  if (requireLastCheckAt) {
    const lastCheckAt = await getLastCheckAt();
    if (lastCheckAt == null) {
      return { skipped: true, checked: 0, drops: 0, unavailable: 0 };
    }
  }
  if (activeCheckPromise) return activeCheckPromise;
  if (activeStaleCheckPromise) return activeStaleCheckPromise;

  activeStaleCheckPromise = (async () => {
    const [watches, settings, lastCheckAt] = await Promise.all([
      getWatches(),
      getSettings(),
      getLastCheckAt(),
    ]);
    if (
      !isCheckStale({
        lastCheckAt,
        watches,
        intervalHours: settings.checkIntervalHours,
      })
    ) {
      return { skipped: true, checked: 0, drops: 0, unavailable: 0 };
    }
    return checkAllWatches({ notify });
  })().finally(() => {
    activeStaleCheckPromise = null;
  });

  return activeStaleCheckPromise;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await syncActionBadge();
  // Initial check shortly after install/update if watches are stale.
  chrome.alarms.create("onliner-price-check-once", { delayInMinutes: 0.2 });
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm()
    .then(() => syncActionBadge())
    .then(() => checkIfStale({ notify: true }))
    .catch((err) => console.warn("[OnlinerPT] startup check failed", err));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CHECK_ALARM) {
    await ensureAlarm();
    await checkAllWatches({ notify: true });
    return;
  }
  if (alarm.name === "onliner-price-check-once") {
    await ensureAlarm();
    await checkIfStale({ notify: true });
  }
});

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    handleNotificationClick(notificationId).catch((err) =>
      console.warn("[OnlinerPT] notification click failed", err)
    );
  });
}

if (chrome.notifications?.onClosed) {
  chrome.notifications.onClosed.addListener((notificationId) => {
    removeNotificationTarget(notificationId).catch((err) =>
      console.warn("[OnlinerPT] notification cleanup failed", err)
    );
  });
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[SETTINGS_KEY]) {
      ensureAlarm().catch((err) =>
        console.warn("[OnlinerPT] alarm reschedule failed", err)
      );
    }
    if (changes[STORAGE_KEY]) {
      syncActionBadge().catch((err) =>
        console.warn("[OnlinerPT] badge sync failed", err)
      );
    }
  });
}

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
    if (message.type === "CLEAR_BADGE") {
      await clearUnreadDropKeys();
      const badge = await applyActionBadge(0);
      sendResponse({ ok: true, ...badge });
      return;
    }
    if (message.type === "SET_CHECK_INTERVAL") {
      const settings = await setSettings({
        checkIntervalHours: message.checkIntervalHours,
      });
      await ensureAlarm({ forceReschedule: true });
      const alarm = await chrome.alarms.get(CHECK_ALARM);
      sendResponse({
        ok: true,
        settings,
        periodMinutes: settings.checkIntervalHours * 60,
        alarm,
      });
      return;
    }
    if (message.type === "GET_STATUS") {
      const [settings, alarm, lastCheckAt, unreadDropKeys] = await Promise.all([
        getSettings(),
        chrome.alarms.get(CHECK_ALARM),
        getLastCheckAt(),
        getUnreadDropKeys(),
      ]);
      sendResponse({
        ok: true,
        checkIntervalHours: settings.checkIntervalHours,
        periodMinutes: settings.checkIntervalHours * 60,
        alarm,
        lastCheckAt,
        unreadDropCount: unreadDropKeys.length,
      });
      return;
    }
    sendResponse({ ok: false, error: "Unknown type" });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });
  return true;
});

ensureAlarm()
  .then(() => syncActionBadge())
  .then(() => checkIfStale({ notify: true, requireLastCheckAt: true }))
  .catch((err) => console.warn("[OnlinerPT] worker init check failed", err));
