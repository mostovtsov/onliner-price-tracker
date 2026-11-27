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

function makeMockCanvasCtx(drawLog) {
  return {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "",
    lineCap: "",
    font: "",
    textBaseline: "",
    textAlign: "",
    globalAlpha: 1,
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    arc() {},
    save() {},
    restore() {},
    setLineDash() {},
    fillText() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    _log: drawLog,
  };
}

function createPopupHarness({
  messages = ruMessages,
  storageGetImpl,
  manualRaf = false,
} = {}) {
  const sentMessages = [];
  const storageListeners = new Set();
  const storageGetCalls = [];
  const rafQueue = [];
  const drawnCanvases = [];

  function makeEl(tagOrId, isId = false) {
    const attrs = new Map();
    const el = {
      tagName: isId ? "DIV" : String(tagOrId).toUpperCase(),
      id: isId ? tagOrId : "",
      className: "",
      textContent: "",
      innerHTML: "",
      value: "",
      hidden: false,
      disabled: false,
      clientWidth: 346,
      clientHeight: 92,
      width: 0,
      height: 0,
      children: [],
      classList: {
        add() {},
        remove() {},
      },
      appendChild(child) {
        if (child && child._isFragment) {
          for (const nested of child.children) {
            this.children.push(nested);
          }
          child.children = [];
          return child;
        }
        this.children.push(child);
        return child;
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      addEventListener() {},
    };
    if (el.tagName === "CANVAS") {
      el.getContext = () => {
        drawnCanvases.push(el);
        return makeMockCanvasCtx(drawnCanvases);
      };
    }
    return el;
  }

  const ids = [
    "main",
    "loading",
    "loadingText",
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
  const elMap = new Map(ids.map((id) => [id, makeEl(id, true)]));
  // Mirror initial HTML attributes from src/popup.html
  elMap.get("main").setAttribute("aria-busy", "true");
  elMap.get("loading").hidden = false;
  elMap.get("empty").hidden = true;
  elMap.get("list").hidden = true;
  elMap.get("importConfirm").hidden = true;

  const storage = {
    local: {
      async get(keys) {
        storageGetCalls.push(keys);
        if (storageGetImpl) {
          return storageGetImpl(keys);
        }
        return { watches: {}, settings: { checkIntervalHours: 3 } };
      },
      async set() {},
    },
    onChanged: {
      addListener(fn) {
        storageListeners.add(fn);
      },
    },
  };

  const context = {
    URL,
    Intl,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: manualRaf
      ? (fn) => {
          rafQueue.push(fn);
          return rafQueue.length;
        }
      : (fn) => fn(),
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
    devicePixelRatio: 1,
    document: {
      title: "",
      getElementById: (id) => elMap.get(id) || makeEl(id, true),
      createElement: (tag) => makeEl(tag, false),
      createDocumentFragment: () => ({
        _isFragment: true,
        children: [],
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      }),
    },
    chrome: {
      storage,
      i18n: makeI18n(messages),
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

  return {
    elMap,
    sentMessages,
    storageGetCalls,
    rafQueue,
    drawnCanvases,
    flushOneFrame() {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const fn of batch) fn();
    },
    emitStorageChange(changes) {
      for (const fn of storageListeners) fn(changes, "local");
    },
  };
}

test("popup.html paints an immediate, accessible, MV3-safe loading state before JS loads", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/popup.html"), "utf8");

  // Inline critical CSS present before external stylesheet
  const styleIdx = html.indexOf("<style>");
  const linkIdx = html.indexOf('href="popup.css"');
  assert.ok(styleIdx !== -1, "popup.html must include inline critical <style>");
  assert.ok(styleIdx < linkIdx, "inline critical <style> must precede popup.css");
  assert.match(html, /\.loading-state\b/);
  assert.match(html, /\.loading-spinner\b/);
  assert.match(html, /\.skeleton-card\b/);
  assert.match(html, /prefers-reduced-motion:\s*reduce/);

  // MV3 CSP forbids inline scripts; external scripts use defer
  assert.doesNotMatch(
    html,
    /<script(?![^>]*\bsrc=)[^>]*>/i,
    "popup.html must not contain inline <script>"
  );
  assert.match(html, /<script\s+src="shared\.js"\s+defer><\/script>/);
  assert.match(html, /<script\s+src="popup\.js"\s+defer><\/script>/);

  // Accessibility & initial visibility
  assert.match(html, /<main\s+id="main"\s+aria-busy="true">/);
  assert.match(
    html,
    /<div\s+id="loading"\s+class="loading-state"\s+role="status"\s+aria-live="polite">/
  );
  assert.match(html, /<span\s+id="loadingText"\s+class="loading-text">Загрузка…<\/span>/);
  assert.match(html, /<p\s+id="empty"\s+class="empty"\s+hidden>/);
  assert.match(html, /<ul\s+id="list"\s+class="list"\s+hidden><\/ul>/);
});

test("popup shows localized loading text, keeps loading visible while storage is pending, and defers CLEAR_BADGE until after paint", async () => {
  let resolveStorage;
  const storagePromise = new Promise((resolve) => {
    resolveStorage = resolve;
  });

  const h = createPopupHarness({
    messages: enMessages,
    manualRaf: true,
    storageGetImpl: () => storagePromise,
  });

  // Immediately after script init while storage read is still pending:
  assert.equal(h.elMap.get("loadingText").textContent, "Loading…");
  assert.equal(h.elMap.get("loading").hidden, false);
  assert.equal(h.elMap.get("main").getAttribute("aria-busy"), "true");
  assert.equal(h.elMap.get("empty").hidden, true);
  assert.equal(h.elMap.get("list").hidden, true);
  // Batched initial storage read: single get([watches, settings]) call
  assert.equal(h.storageGetCalls.length, 1);
  assert.deepEqual(Array.from(h.storageGetCalls[0]), ["watches", "settings"]);
  // Badge clearing is deferred until after first paint
  assert.deepEqual(h.sentMessages, []);

  // Resolve storage with one watched product and 6h interval
  resolveStorage({
    watches: {
      iphone16: {
        key: "iphone16",
        title: "Apple iPhone 16",
        url: "https://catalog.onliner.by/mobile/apple/iphone16",
        image: "https://content2.onliner.by/catalog/iphone16.jpg",
        currency: "BYN",
        lastPrice: 2899,
        lastCheckedAt: 1764010800000,
        addedAt: 1764010800000,
        history: [{ price: 2899, at: 1764010800000 }],
      },
    },
    settings: { checkIntervalHours: 6 },
  });
  await new Promise((r) => setTimeout(r, 10));

  // Loading state hidden, real UI visible, settings synced
  assert.equal(h.elMap.get("loading").hidden, true);
  assert.equal(h.elMap.get("main").getAttribute("aria-busy"), "false");
  assert.equal(h.elMap.get("empty").hidden, true);
  assert.equal(h.elMap.get("list").hidden, false);
  assert.equal(h.elMap.get("list").children.length, 1);
  assert.equal(h.elMap.get("intervalSelect").value, "6");

  // Thumbnail uses lazy/async image loading attributes
  const card = h.elMap.get("list").children[0];
  const img = card.children[0].children[0];
  assert.equal(img.tagName, "IMG");
  assert.equal(img.loading, "lazy");
  assert.equal(img.decoding, "async");
  assert.equal(img.width, 48);
  assert.equal(img.height, 48);

  // Before paint frame runs, CLEAR_BADGE has not been sent yet
  assert.deepEqual(h.sentMessages, []);

  // Flush paint frame -> charts draw and post-paint CLEAR_BADGE runs
  h.flushOneFrame();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.drawnCanvases.length, 1);
  assert.deepEqual(h.sentMessages, [{ type: "CLEAR_BADGE" }]);
});

test("popup hides loading and shows empty state when no watches are stored (RU locale)", async () => {
  const h = createPopupHarness({
    messages: ruMessages,
    storageGetImpl: async () => ({ watches: {}, settings: {} }),
  });

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(h.elMap.get("loadingText").textContent, "Загрузка…");
  assert.equal(h.elMap.get("loading").hidden, true);
  assert.equal(h.elMap.get("main").getAttribute("aria-busy"), "false");
  assert.equal(h.elMap.get("empty").hidden, false);
  assert.equal(h.elMap.get("list").hidden, true);
});

test("popup hides loading indicator and shows status feedback if initial storage read fails", async () => {
  const h = createPopupHarness({
    messages: enMessages,
    storageGetImpl: async () => {
      throw new Error("Storage unavailable");
    },
  });

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(h.elMap.get("loading").hidden, true);
  assert.equal(h.elMap.get("main").getAttribute("aria-busy"), "false");
  assert.equal(h.elMap.get("status").textContent, "Storage unavailable");
});

test("popup chunks chart drawing across animation frames for large watch lists", async () => {
  const watches = {};
  for (let i = 1; i <= 10; i++) {
    watches[`item${i}`] = {
      key: `item${i}`,
      title: `Item ${i}`,
      url: `https://catalog.onliner.by/mobile/test/item${i}`,
      currency: "BYN",
      lastPrice: 1000 + i,
      lastCheckedAt: 1764010800000,
      addedAt: 1764010800000 + i,
      history: [{ price: 1000 + i, at: 1764010800000 }],
    };
  }

  const h = createPopupHarness({
    messages: enMessages,
    manualRaf: true,
    storageGetImpl: async () => ({ watches, settings: { checkIntervalHours: 3 } }),
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.elMap.get("list").children.length, 10);
  assert.equal(h.drawnCanvases.length, 0);

  // First frame draws initial visible chunk (6 charts), remaining 4 queued for next frame
  h.flushOneFrame();
  assert.equal(h.drawnCanvases.length, 6);

  // Second frame finishes remaining 4 charts
  h.flushOneFrame();
  assert.equal(h.drawnCanvases.length, 10);
});
