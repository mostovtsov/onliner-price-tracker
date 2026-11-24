/* global OnlinerPT */
(function () {
  "use strict";

  const {
    parseProductUrl,
    scrapeProductFromDom,
    fetchProduct,
    isWatched,
    watchProduct,
    unwatchProduct,
    formatPrice,
    t,
  } = OnlinerPT;

  const BTN_ID = "onliner-pt-watch-btn";

  function currentProductRef() {
    return parseProductUrl(location.href);
  }

  function ensureButton() {
    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;

    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.className = "onliner-pt-btn";
    btn.addEventListener("click", onToggle);
    document.documentElement.appendChild(btn);
    return btn;
  }

  async function resolveProduct() {
    const ref = currentProductRef();
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
      const api = await fetchProduct(ref.key);
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
    const ref = currentProductRef();
    const btn = ensureButton();
    if (!ref) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    const watched = await isWatched(ref.key);
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
      } else {
        const product = await resolveProduct();
        if (!product) return;
        await watchProduct(product);
        if (product.price != null) {
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

  function maybeRefresh() {
    refreshButton().catch((err) =>
      console.warn("[OnlinerPT] refresh failed", err)
    );
  }

  // SPA navigations on Onliner
  let lastHref = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      maybeRefresh();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.watches) maybeRefresh();
  });

  maybeRefresh();
})();
