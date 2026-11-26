/* global OnlinerPT */
(function () {
  "use strict";

  const {
    parseProductPageUrl,
    scrapeProductFromDom,
    fetchProduct,
    isWatched,
    watchProduct,
    unwatchProduct,
    formatPrice,
    t,
  } = OnlinerPT;

  const BTN_ID = "onliner-pt-watch-btn";
  const URL_POLL_MS = 1000;
  const CONTENT_FETCH_OPTIONS = {
    timeoutMs: 6000,
    maxRetries: 1,
    retryDelayMs: 500,
  };

  let lastHref = location.href;
  let refreshSeq = 0;
  let refreshTimer = null;
  let disposed = false;

  function isExtensionAlive() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function currentProductRef() {
    return parseProductPageUrl(location.href);
  }

  function ensureButton() {
    let btn = document.getElementById(BTN_ID);
    if (btn && btn.isConnected) return btn;

    if (!btn) {
      btn = document.createElement("button");
      btn.id = BTN_ID;
      btn.type = "button";
      btn.className = "onliner-pt-btn";
      btn.addEventListener("click", onToggle);
    }
    (document.documentElement || document.body).appendChild(btn);
    return btn;
  }

  async function resolveProduct(ref) {
    if (!ref) return null;

    const dom = scrapeProductFromDom(document);
    let snapshot = {
      key: ref.key,
      title: dom.title || ref.key,
      price: dom.price,
      currency: dom.currency || "BYN",
      url: ref.url,
      image: null,
      fetchedAt: Date.now(),
    };

    try {
      const api = await fetchProduct(ref.key, CONTENT_FETCH_OPTIONS);
      snapshot = {
        ...snapshot,
        ...api,
        url: api.url || ref.url,
        title: api.title || snapshot.title,
        price: api.price ?? snapshot.price,
      };
    } catch (err) {
      console.warn("[OnlinerPT] API fetch failed, using DOM", err);
    }

    return snapshot;
  }

  async function refreshButton() {
    if (disposed) return;
    if (!isExtensionAlive()) {
      cleanup();
      return;
    }

    const seq = ++refreshSeq;
    const ref = currentProductRef();
    const existingBtn = document.getElementById(BTN_ID);

    if (!ref) {
      if (existingBtn) {
        existingBtn.hidden = true;
        delete existingBtn.dataset.productKey;
        existingBtn.removeAttribute("title");
      }
      return;
    }

    const watched = await isWatched(ref.key);
    // Drop stale async updates if the user already navigated elsewhere.
    if (disposed || seq !== refreshSeq) return;
    const latestRef = currentProductRef();
    if (!latestRef || latestRef.key !== ref.key) return;

    const btn = ensureButton();
    if (btn.dataset.productKey !== ref.key) {
      btn.dataset.productKey = ref.key;
      btn.removeAttribute("title");
    }
    btn.hidden = false;
    btn.dataset.watched = watched ? "1" : "0";
    btn.textContent = watched ? t("unwatchStar") : t("watchPrice");
    btn.setAttribute(
      "aria-label",
      watched ? t("ariaUnwatch") : t("ariaWatch")
    );
  }

  async function onToggle(event) {
    event.preventDefault();
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const ref = currentProductRef();
      if (!ref) return;

      if (await isWatched(ref.key)) {
        await unwatchProduct(ref.key);
        if (currentProductRef()?.key === ref.key) {
          btn.removeAttribute("title");
        }
      } else {
        const product = await resolveProduct(ref);
        if (!product) return;
        await watchProduct(product);
        if (product.price != null && currentProductRef()?.key === ref.key) {
          btn.title = t("savedPrice", [
            formatPrice(product.price, product.currency),
          ]);
        }
      }
      await refreshButton();
    } catch (err) {
      console.error("[OnlinerPT] toggle failed", err);
      alert(t("toggleFailedPrefix", [String(err?.message || err)]));
    } finally {
      btn.disabled = false;
    }
  }

  function scheduleRefresh() {
    if (disposed || refreshTimer != null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshButton().catch((err) => {
        if (!isExtensionAlive()) {
          cleanup();
          return;
        }
        console.warn("[OnlinerPT] refresh failed", err);
      });
    }, 0);
  }

  function handleRouteOrDomChange() {
    if (disposed) return;
    const href = location.href;
    if (href !== lastHref) {
      lastHref = href;
      scheduleRefresh();
      return;
    }
    // Re-inject button if an SPA re-render removed it while on a product page.
    if (currentProductRef() && !document.getElementById(BTN_ID)) {
      scheduleRefresh();
    }
  }

  function onClickDeferredCheck() {
    if (disposed) return;
    setTimeout(handleRouteOrDomChange, 0);
    setTimeout(handleRouteOrDomChange, 150);
  }

  function onVisibilityChange() {
    if (!document.hidden) handleRouteOrDomChange();
  }

  function onPageShow() {
    lastHref = location.href;
    scheduleRefresh();
  }

  function onStorageChanged(changes, area) {
    if (area === "local" && changes.watches) scheduleRefresh();
  }

  const observer = new MutationObserver(handleRouteOrDomChange);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("popstate", handleRouteOrDomChange);
  window.addEventListener("hashchange", handleRouteOrDomChange);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("click", onClickDeferredCheck, true);

  const nav = typeof window !== "undefined" ? window.navigation : null;
  if (nav && typeof nav.addEventListener === "function") {
    nav.addEventListener("currententrychange", handleRouteOrDomChange);
    nav.addEventListener("navigatesuccess", handleRouteOrDomChange);
  }

  // Fallback for MAIN-world history.pushState/replaceState without DOM churn.
  const pollTimer = setInterval(() => {
    if (!document.hidden) handleRouteOrDomChange();
  }, URL_POLL_MS);

  chrome.storage.onChanged.addListener(onStorageChanged);

  function cleanup() {
    if (disposed) return;
    disposed = true;
    if (refreshTimer != null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    clearInterval(pollTimer);
    observer.disconnect();
    window.removeEventListener("popstate", handleRouteOrDomChange);
    window.removeEventListener("hashchange", handleRouteOrDomChange);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("click", onClickDeferredCheck, true);
    if (nav && typeof nav.removeEventListener === "function") {
      nav.removeEventListener("currententrychange", handleRouteOrDomChange);
      nav.removeEventListener("navigatesuccess", handleRouteOrDomChange);
    }
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      /* ignore if context already torn down */
    }
  }

  scheduleRefresh();
})();
