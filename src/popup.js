/* global OnlinerPT */
(function () {
  "use strict";

  const {
    ALLOWED_INTERVAL_HOURS,
    CHECK_INTERVAL_HOURS,
    STORAGE_KEY,
    SETTINGS_KEY,
    PRICE_EPSILON,
    normalizeCheckIntervalHours,
    getSettings,
    setSettings,
    getWatches,
    clearUnreadDropKeys,
    unwatchProduct,
    setWatchTargetPrice,
    computeChartLayout,
    buildExportPayload,
    validateImportPayload,
    importBackup,
    formatPrice,
    t,
    tPlural,
  } = OnlinerPT;

  const mainEl = document.getElementById("main");
  const loadingEl = document.getElementById("loading");
  const loadingTextEl = document.getElementById("loadingText");
  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const statusEl = document.getElementById("status");
  const checkBtn = document.getElementById("checkNow");
  const intervalSelect = document.getElementById("intervalSelect");
  const exportBtn = document.getElementById("exportBtn");
  const importBtn = document.getElementById("importBtn");
  const importFileInput = document.getElementById("importFile");
  const importConfirmEl = document.getElementById("importConfirm");
  const importConfirmTextEl = document.getElementById("importConfirmText");
  const importMergeBtn = document.getElementById("importMergeBtn");
  const importReplaceBtn = document.getElementById("importReplaceBtn");
  const importCancelBtn = document.getElementById("importCancelBtn");

  const CHART_BATCH_SIZE = 6;
  let dateTimeFormatter = null;
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
      dateTimeFormatter = new Intl.DateTimeFormat("ru-BY", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
  } catch {
    dateTimeFormatter = null;
  }

  let pendingImportPayload = null;
  let renderSeq = 0;
  let isChecking = false;
  let preserveStatusUntil = 0;
  let initialLoadComplete = false;

  function formatCheckedAt(ts) {
    const date = new Date(ts);
    if (dateTimeFormatter) {
      try {
        return dateTimeFormatter.format(date);
      } catch {
        /* fallback to toLocaleString below */
      }
    }
    return date.toLocaleString("ru-BY");
  }

  function finishInitialLoad() {
    if (initialLoadComplete) return;
    initialLoadComplete = true;
    if (loadingEl) loadingEl.hidden = true;
    if (mainEl && typeof mainEl.setAttribute === "function") {
      mainEl.setAttribute("aria-busy", "false");
    }
  }

  function scheduleFrame(fn) {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(fn);
    } else {
      setTimeout(fn, 0);
    }
  }

  function scheduleAfterPaint(fn) {
    scheduleFrame(() => setTimeout(fn, 0));
  }

  function setStatusFeedback(text, holdMs = 4000) {
    statusEl.textContent = text;
    preserveStatusUntil = Date.now() + holdMs;
  }

  function populateIntervalOptions() {
    intervalSelect.innerHTML = "";
    for (const hours of ALLOWED_INTERVAL_HOURS) {
      const opt = document.createElement("option");
      opt.value = String(hours);
      opt.textContent = t("intervalOptionHours", [String(hours)]);
      intervalSelect.appendChild(opt);
    }
    intervalSelect.value = String(CHECK_INTERVAL_HOURS);
    intervalSelect.setAttribute("aria-label", t("intervalSelectAria"));
  }

  function applyStaticI18n() {
    const name = t("extName");
    document.title = name;
    document.getElementById("extTitle").textContent = name;
    document.getElementById("subtitleBefore").textContent = t(
      "popupSubtitleBefore"
    );
    checkBtn.textContent = t("checkNow");
    if (loadingTextEl) {
      loadingTextEl.textContent = t("loading");
    }
    document.getElementById("emptyBefore").textContent = t("emptyStateBefore");
    document.getElementById("emptyAfter").textContent = t("emptyStateAfter");
    exportBtn.textContent = t("exportBtn");
    importBtn.textContent = t("importBtn");
    importMergeBtn.textContent = t("importMergeBtn");
    importReplaceBtn.textContent = t("importReplaceBtn");
    importCancelBtn.textContent = t("importCancelBtn");
    populateIntervalOptions();
  }

  async function clearDropBadge() {
    try {
      await chrome.runtime.sendMessage({ type: "CLEAR_BADGE" });
      return;
    } catch {
      /* background may be inactive or unavailable in tests */
    }
    try {
      await clearUnreadDropKeys();
      if (chrome.action && typeof chrome.action.setBadgeText === "function") {
        await chrome.action.setBadgeText({ text: "" });
      }
      if (chrome.action && typeof chrome.action.setTitle === "function") {
        await chrome.action.setTitle({ title: t("extName") });
      }
    } catch {
      /* ignore badge clear fallback errors */
    }
  }

  applyStaticI18n();

  async function loadInitialState() {
    const raw = await chrome.storage.local.get([STORAGE_KEY, SETTINGS_KEY]);
    const watches =
      raw && raw[STORAGE_KEY] && typeof raw[STORAGE_KEY] === "object"
        ? raw[STORAGE_KEY]
        : {};
    const rawSettings =
      raw && raw[SETTINGS_KEY] && typeof raw[SETTINGS_KEY] === "object"
        ? raw[SETTINGS_KEY]
        : {};
    return {
      watches,
      settings: {
        checkIntervalHours: normalizeCheckIntervalHours(
          rawSettings.checkIntervalHours
        ),
      },
    };
  }

  async function syncSettingsUi() {
    try {
      const settings = await getSettings();
      intervalSelect.value = String(settings.checkIntervalHours);
    } catch {
      intervalSelect.value = String(CHECK_INTERVAL_HOURS);
    }
  }

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

  function drawChart(canvas, history, targetPrice = null, dims = null) {
    if (!canvas || typeof canvas.getContext !== "function") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = (dims && dims.width) || canvas.clientWidth || 346;
    const cssH = (dims && dims.height) || canvas.clientHeight || 92;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const layout = computeChartLayout(history, {
      width: cssW,
      height: cssH,
      maxPoints: 60,
    });

    if (layout.points.length === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "12px Segoe UI, system-ui, sans-serif";
      ctx.fillText(t("noPricePoints"), 12, cssH / 2 + 4);
      return;
    }

    const strokeColor = layout.falling ? "#047857" : "#b45309";
    const fillTop = layout.falling
      ? "rgba(4,120,87,0.20)"
      : "rgba(180,83,9,0.16)";

    // Baseline separator above X-axis labels
    ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.plotLeft, layout.plotBottom);
    ctx.lineTo(layout.plotRight, layout.plotBottom);
    ctx.stroke();

    // Optional target price horizontal guide when within Y bounds
    if (
      typeof targetPrice === "number" &&
      Number.isFinite(targetPrice) &&
      targetPrice >= layout.minPrice &&
      targetPrice <= layout.maxPrice
    ) {
      const ty =
        layout.plotTop +
        (1 - (targetPrice - layout.minPrice) / (layout.maxPrice - layout.minPrice)) *
          layout.plotH;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(14, 116, 144, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(layout.plotLeft, ty);
      ctx.lineTo(layout.plotRight, ty);
      ctx.stroke();
      ctx.restore();
    }

    // Area fill under the price curve (skip fill for single point)
    if (layout.points.length > 1 && layout.span > 0) {
      const grad = ctx.createLinearGradient(0, layout.plotTop, 0, layout.plotBottom);
      grad.addColorStop(0, fillTop);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.beginPath();
      ctx.moveTo(layout.points[0].x, layout.plotBottom);
      layout.points.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.lineTo(layout.points[layout.points.length - 1].x, layout.plotBottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Line segments (solid normally, dashed across long unmeasured gaps)
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    for (const seg of layout.segments) {
      ctx.save();
      if (seg.isLongGap) {
        ctx.setLineDash([4, 3]);
        ctx.globalAlpha = 0.65;
      }
      ctx.beginPath();
      ctx.moveTo(seg.from.x, seg.from.y);
      ctx.lineTo(seg.to.x, seg.to.y);
      ctx.stroke();
      ctx.restore();
    }

    // Point markers for small sets and gap boundaries
    const markedIndices = new Set();
    if (layout.points.length <= 12) {
      for (let i = 0; i < layout.points.length; i++) markedIndices.add(i);
    } else {
      layout.segments.forEach((seg, idx) => {
        if (seg.isLongGap) {
          markedIndices.add(idx);
          markedIndices.add(idx + 1);
        }
      });
    }
    ctx.fillStyle = strokeColor;
    for (const idx of markedIndices) {
      const pt = layout.points[idx];
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Highlight last point
    const last = layout.points[layout.points.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = strokeColor;
    ctx.fill();

    // X-axis date/time labels
    if (layout.ticks.length > 0) {
      ctx.fillStyle = "#64748b";
      ctx.font = "10px Segoe UI, system-ui, sans-serif";
      ctx.textBaseline = "bottom";
      const labelY = cssH - 2;
      for (const tick of layout.ticks) {
        ctx.textAlign = tick.align;
        ctx.fillText(tick.label, tick.x, labelY);
      }
    }
  }

  function firstPrice(watch) {
    const h = watch.history || [];
    return h.length ? h[0].price : null;
  }

  function scheduleCharts(tasks, seq) {
    if (!tasks.length) return;
    let offset = 0;

    function runBatch() {
      if (seq !== renderSeq) return;
      const end = Math.min(offset + CHART_BATCH_SIZE, tasks.length);
      const batch = [];
      for (let i = offset; i < end; i++) {
        const task = tasks[i];
        batch.push({
          task,
          width: task.canvas.clientWidth || 346,
          height: task.canvas.clientHeight || 92,
        });
      }
      for (const item of batch) {
        drawChart(item.task.canvas, item.task.history, item.task.targetPrice, {
          width: item.width,
          height: item.height,
        });
      }
      offset = end;
      if (offset < tasks.length) {
        scheduleFrame(runBatch);
      }
    }

    scheduleFrame(runBatch);
  }

  function createWatchCard(watch, chartTasks) {
    const li = document.createElement("li");
    li.className = watch.unavailable ? "card is-unavailable" : "card";

    const top = document.createElement("div");
    top.className = "card-top";

    if (watch.image) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.width = 48;
      img.height = 48;
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
    link.href = watch.url || "https://catalog.onliner.by/";
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = watch.title || watch.key;
    mid.appendChild(link);

    const hasTarget =
      typeof watch.targetPrice === "number" &&
      Number.isFinite(watch.targetPrice) &&
      watch.targetPrice > 0;
    const targetReached =
      !watch.unavailable &&
      hasTarget &&
      watch.lastPrice != null &&
      watch.lastPrice <= watch.targetPrice + PRICE_EPSILON;

    if (watch.unavailable || targetReached) {
      const badges = document.createElement("div");
      badges.className = "badges";
      if (watch.unavailable) {
        const badge = document.createElement("span");
        const isDelisted = watch.unavailableReason === "delisted";
        badge.className = isDelisted ? "badge delisted" : "badge unavailable";
        badge.textContent = isDelisted
          ? t("statusDelisted")
          : t("statusUnavailable");
        badges.appendChild(badge);
      }
      if (targetReached) {
        const badge = document.createElement("span");
        badge.className = "badge target-hit";
        badge.textContent = t("targetPriceReachedBadge");
        badges.appendChild(badge);
      }
      mid.appendChild(badges);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const checked = watch.lastCheckedAt
      ? formatCheckedAt(watch.lastCheckedAt)
      : t("neverChecked");
    meta.textContent = watch.lastError
      ? t("errorPrefix", [watch.lastError])
      : t("checkedPrefix", [checked]);
    mid.appendChild(meta);
    top.appendChild(mid);

    const priceBox = document.createElement("div");
    priceBox.className = watch.unavailable ? "price is-unavailable" : "price";
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

    // Target price row
    const targetRow = document.createElement("div");
    targetRow.className = "target-row";

    const targetLabel = document.createElement("span");
    targetLabel.className = "target-label";
    targetLabel.textContent = `${t("targetPriceLabel")}:`;
    targetRow.appendChild(targetLabel);

    const targetInput = document.createElement("input");
    targetInput.type = "text";
    targetInput.inputMode = "decimal";
    targetInput.className = "target-input";
    targetInput.placeholder = t("targetPricePlaceholder");
    targetInput.value = hasTarget ? String(watch.targetPrice) : "";
    targetRow.appendChild(targetInput);

    const targetCurrency = document.createElement("span");
    targetCurrency.className = "target-currency";
    targetCurrency.textContent = watch.currency || "BYN";
    targetRow.appendChild(targetCurrency);

    const saveTargetBtn = document.createElement("button");
    saveTargetBtn.type = "button";
    saveTargetBtn.className = "target-save";
    saveTargetBtn.textContent = t("targetPriceSave");

    const saveTarget = async () => {
      targetInput.classList.remove("invalid");
      const raw = targetInput.value.trim();
      try {
        const res = await setWatchTargetPrice(watch.key, raw);
        if (res.removed) {
          await render();
          return;
        }
        setStatusFeedback(
          res.watch.targetPrice != null
            ? t("targetPriceSaved", [
                formatPrice(res.watch.targetPrice, res.watch.currency),
              ])
            : t("targetPriceCleared")
        );
        await render({ preserveStatus: true });
      } catch (err) {
        targetInput.classList.add("invalid");
        setStatusFeedback(String(err?.message || err));
      }
    };

    saveTargetBtn.addEventListener("click", saveTarget);
    targetInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveTarget();
      }
    });
    targetRow.appendChild(saveTargetBtn);

    if (hasTarget) {
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "target-clear";
      clearBtn.textContent = "×";
      clearBtn.title = t("targetPriceClear");
      clearBtn.setAttribute("aria-label", t("targetPriceClear"));
      clearBtn.addEventListener("click", async () => {
        await setWatchTargetPrice(watch.key, null);
        setStatusFeedback(t("targetPriceCleared"));
        await render({ preserveStatus: true });
      });
      targetRow.appendChild(clearBtn);
    }

    li.appendChild(targetRow);

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

    chartTasks.push({
      canvas,
      history: watch.history,
      targetPrice: watch.targetPrice ?? null,
    });
    return li;
  }

  function renderWatches(watches, { seq, preserveStatus = false }) {
    const items = Object.values(watches).sort(
      (a, b) => (b.addedAt || 0) - (a.addedAt || 0)
    );
    const chartTasks = [];
    const fragment =
      typeof document.createDocumentFragment === "function"
        ? document.createDocumentFragment()
        : null;

    listEl.innerHTML = "";
    for (const watch of items) {
      const li = createWatchCard(watch, chartTasks);
      if (fragment) {
        fragment.appendChild(li);
      } else {
        listEl.appendChild(li);
      }
    }
    if (fragment) {
      listEl.appendChild(fragment);
    }

    emptyEl.hidden = items.length > 0;
    listEl.hidden = items.length === 0;
    finishInitialLoad();

    if (!preserveStatus && !isChecking) {
      statusEl.textContent = items.length
        ? tPlural("watchedCount", items.length)
        : "";
    }
    scheduleCharts(chartTasks, seq);
  }

  async function render({ preserveStatus = false } = {}) {
    const seq = ++renderSeq;
    const watches = await getWatches();
    if (seq !== renderSeq) return;
    renderWatches(watches, { seq, preserveStatus });
  }

  function hideImportConfirm() {
    pendingImportPayload = null;
    importConfirmEl.hidden = true;
    importConfirmTextEl.textContent = "";
  }

  intervalSelect.addEventListener("change", async () => {
    const hours = Number(intervalSelect.value);
    try {
      const res = await chrome.runtime.sendMessage({
        type: "SET_CHECK_INTERVAL",
        checkIntervalHours: hours,
      });
      if (!res?.ok) throw new Error(res?.error || "Failed");
      setStatusFeedback(
        t("intervalUpdated", [String(res.settings.checkIntervalHours)])
      );
    } catch {
      const saved = await setSettings({ checkIntervalHours: hours });
      setStatusFeedback(
        t("intervalUpdated", [String(saved.checkIntervalHours)])
      );
    }
  });

  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    isChecking = true;
    statusEl.textContent = t("checking");
    try {
      const res = await chrome.runtime.sendMessage({
        type: "CHECK_NOW",
        notify: true,
      });
      if (!res?.ok) throw new Error(res?.error || t("checkFailed"));
      if (res.drops > 0) {
        await clearDropBadge();
      }
      await render({ preserveStatus: true });
      setStatusFeedback(
        res.unavailable > 0
          ? t("checkSummaryWithUnavailable", [
              String(res.checked),
              String(res.drops),
              String(res.unavailable),
            ])
          : t("checkSummary", [String(res.checked), String(res.drops)])
      );
    } catch (err) {
      setStatusFeedback(String(err?.message || err));
    } finally {
      isChecking = false;
      checkBtn.disabled = false;
    }
  });

  exportBtn.addEventListener("click", async () => {
    try {
      const [watches, settings] = await Promise.all([
        getWatches(),
        getSettings(),
      ]);
      const payload = buildExportPayload({ watches, settings });
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = url;
      a.download = `onliner-price-tracker-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatusFeedback(
        t("exportSuccess", [String(Object.keys(watches).length)])
      );
    } catch (err) {
      setStatusFeedback(t("exportFailed", [String(err?.message || err)]));
    }
  });

  importBtn.addEventListener("click", () => {
    importFileInput.value = "";
    importFileInput.click();
  });

  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files?.[0];
    if (!file) return;
    hideImportConfirm();

    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      setStatusFeedback(t("importInvalidJson"));
      importFileInput.value = "";
      return;
    }

    const check = validateImportPayload(parsed);
    if (!check.ok) {
      setStatusFeedback(check.error || t("importInvalidSchema"));
      importFileInput.value = "";
      return;
    }

    pendingImportPayload = parsed;
    const count = Object.keys(check.data.watches).length;
    importConfirmTextEl.textContent = t("importConfirmPrompt", [String(count)]);
    importConfirmEl.hidden = false;
    importFileInput.value = "";
  });

  async function applyPendingImport(mode) {
    if (!pendingImportPayload) return;
    const payload = pendingImportPayload;
    hideImportConfirm();
    try {
      const res = await importBackup(payload, { mode });
      if (!res.ok) {
        statusEl.textContent = res.error || t("importInvalidSchema");
        return;
      }
      if (res.settingsUpdated && res.settings) {
        intervalSelect.value = String(res.settings.checkIntervalHours);
        try {
          await chrome.runtime.sendMessage({
            type: "SET_CHECK_INTERVAL",
            checkIntervalHours: res.settings.checkIntervalHours,
          });
        } catch {
          /* storage listener in background also reschedules */
        }
      }
      setStatusFeedback(
        mode === "replace"
          ? t("importSuccessReplace", [String(res.watchCount)])
          : t("importSuccessMerge", [String(res.watchCount)])
      );
      await render({ preserveStatus: true });
    } catch (err) {
      setStatusFeedback(t("importFailed", [String(err?.message || err)]));
    }
  }

  importMergeBtn.addEventListener("click", () => applyPendingImport("merge"));
  importReplaceBtn.addEventListener("click", () => applyPendingImport("replace"));
  importCancelBtn.addEventListener("click", hideImportConfirm);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.watches) {
      render({
        preserveStatus: isChecking || Date.now() < preserveStatusUntil,
      });
    }
    if (changes[SETTINGS_KEY]) {
      syncSettingsUi();
    }
  });

  async function init() {
    const seq = ++renderSeq;
    try {
      const { watches, settings } = await loadInitialState();
      intervalSelect.value = String(settings.checkIntervalHours);
      if (seq === renderSeq) {
        renderWatches(watches, { seq, preserveStatus: false });
      }
    } catch (err) {
      finishInitialLoad();
      emptyEl.hidden = true;
      listEl.hidden = true;
      setStatusFeedback(String(err?.message || err));
    } finally {
      scheduleAfterPaint(() => clearDropBadge());
    }
  }

  init();
})();
