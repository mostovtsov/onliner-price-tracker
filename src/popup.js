/* global OnlinerPT */
(function () {
  "use strict";

  const {
    CHECK_INTERVAL_HOURS,
    getWatches,
    unwatchProduct,
    formatPrice,
    t,
    tPlural,
  } = OnlinerPT;

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const statusEl = document.getElementById("status");
  const checkBtn = document.getElementById("checkNow");
  const intervalLabel = document.getElementById("intervalLabel");

  function applyStaticI18n() {
    const name = t("extName");
    document.title = name;
    document.getElementById("extTitle").textContent = name;
    document.getElementById("subtitleBefore").textContent = t(
      "popupSubtitleBefore"
    );
    document.getElementById("subtitleAfter").textContent = t(
      "popupSubtitleAfter"
    );
    checkBtn.textContent = t("checkNow");
    document.getElementById("emptyBefore").textContent = t("emptyStateBefore");
    document.getElementById("emptyAfter").textContent = t("emptyStateAfter");
    intervalLabel.textContent = String(CHECK_INTERVAL_HOURS);
  }

  applyStaticI18n();

  function deltaClass(current, previous) {
    if (previous == null || current == null) return { text: "", cls: "flat" };
    const diff = current - previous;
    if (Math.abs(diff) < 0.01) return { text: t("noChange"), cls: "flat" };
    if (diff < 0) {
      return {
        text: `↓ ${formatPrice(Math.abs(diff))}`,
        cls: "down",
      };
    }
    return {
      text: `↑ ${formatPrice(diff)}`,
      cls: "up",
    };
  }

  function drawChart(canvas, history) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 340;
    const cssH = canvas.clientHeight || 72;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const points = (history || [])
      .filter((p) => p && Number.isFinite(p.price))
      .slice(-60);

    if (points.length === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "12px Segoe UI, system-ui, sans-serif";
      ctx.fillText(t("noPricePoints"), 12, cssH / 2 + 4);
      return;
    }

    const prices = points.map((p) => p.price);
    let min = Math.min(...prices);
    let max = Math.max(...prices);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const padX = 8;
    const padY = 10;
    const w = cssW - padX * 2;
    const h = cssH - padY * 2;

    const xy = points.map((p, i) => {
      const x =
        points.length === 1
          ? padX + w / 2
          : padX + (i / (points.length - 1)) * w;
      const y = padY + (1 - (p.price - min) / (max - min)) * h;
      return { x, y, price: p.price };
    });

    // fill
    const grad = ctx.createLinearGradient(0, 0, 0, cssH);
    const falling = points[points.length - 1].price <= points[0].price;
    grad.addColorStop(0, falling ? "rgba(4,120,87,0.22)" : "rgba(180,83,9,0.18)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.beginPath();
    ctx.moveTo(xy[0].x, cssH);
    xy.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(xy[xy.length - 1].x, cssH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    xy.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = falling ? "#047857" : "#b45309";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // last point
    const last = xy[xy.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = falling ? "#047857" : "#b45309";
    ctx.fill();
  }

  function firstPrice(watch) {
    const h = watch.history || [];
    return h.length ? h[0].price : null;
  }

  function renderWatch(watch) {
    const li = document.createElement("li");
    li.className = "card";

    const top = document.createElement("div");
    top.className = "card-top";

    if (watch.image) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.alt = "";
      img.src = watch.image;
      top.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "thumb placeholder";
      ph.textContent = t("thumbPlaceholder");
      top.appendChild(ph);
    }

    const mid = document.createElement("div");
    mid.className = "title";
    const link = document.createElement("a");
    link.href = watch.url || `https://catalog.onliner.by/`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = watch.title || watch.key;
    mid.appendChild(link);

    const meta = document.createElement("div");
    meta.className = "meta";
    const checked = watch.lastCheckedAt
      ? new Date(watch.lastCheckedAt).toLocaleString("ru-BY")
      : t("neverChecked");
    meta.textContent = watch.lastError
      ? t("errorPrefix", [watch.lastError])
      : t("checkedPrefix", [checked]);
    mid.appendChild(meta);
    top.appendChild(mid);

    const priceBox = document.createElement("div");
    priceBox.className = "price";
    priceBox.textContent = formatPrice(watch.lastPrice, watch.currency);
    const d = deltaClass(watch.lastPrice, firstPrice(watch));
    if (d.text) {
      const delta = document.createElement("span");
      delta.className = `delta ${d.cls}`;
      delta.textContent = d.text;
      priceBox.appendChild(delta);
    }
    top.appendChild(priceBox);
    li.appendChild(top);

    const chartWrap = document.createElement("div");
    chartWrap.className = "chart-wrap";
    const canvas = document.createElement("canvas");
    chartWrap.appendChild(canvas);
    li.appendChild(chartWrap);

    const actions = document.createElement("div");
    actions.className = "actions";
    const hint = document.createElement("span");
    hint.className = "hint";
    const points = (watch.history || []).length;
    hint.textContent = tPlural("historyPoints", points);
    actions.appendChild(hint);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = t("unwatch");
    remove.addEventListener("click", async () => {
      await unwatchProduct(watch.key);
      await render();
    });
    actions.appendChild(remove);
    li.appendChild(actions);

    listEl.appendChild(li);
    // Draw after layout so clientWidth is available
    requestAnimationFrame(() => drawChart(canvas, watch.history));
  }

  async function render() {
    const watches = await getWatches();
    const items = Object.values(watches).sort(
      (a, b) => (b.addedAt || 0) - (a.addedAt || 0)
    );
    listEl.innerHTML = "";
    emptyEl.hidden = items.length > 0;
    items.forEach(renderWatch);
    statusEl.textContent = items.length
      ? tPlural("watchedCount", items.length)
      : "";
  }

  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    statusEl.textContent = t("checking");
    try {
      const res = await chrome.runtime.sendMessage({
        type: "CHECK_NOW",
        notify: true,
      });
      if (!res?.ok) throw new Error(res?.error || t("checkFailed"));
      statusEl.textContent = t("checkSummary", [
        String(res.checked),
        String(res.drops),
      ]);
      await render();
    } catch (err) {
      statusEl.textContent = String(err?.message || err);
    } finally {
      checkBtn.disabled = false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.watches) render();
  });

  render();
})();
