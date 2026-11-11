import { createTailnetClient } from "./tailnet-client.mjs";
// The GUI-session broker owns this process. Playwright uses inherited DevTools
// pipes; neither the controller nor DevTools opens a guest network listener.
import { randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { extractWindowsExtensionArchive, nativeExtensionIDForPath } from "./windows-browser-extensions.mjs";

const token = () => randomBytes(16).toString("hex");
const tokenPattern = /^[a-f0-9]{32}$/;
const uuidPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const chunkSize = 64 << 10;
const fileLimit = 2 * 1024 * 1024 * 1024;
const imageLimit = 20 << 20;
const textLimit = 2 << 20;
const lineLimit = 128 << 10;
function jpegFrameSize(value) {
  if (typeof value !== "string" || value.length > 12 << 20) return null;
  const bytes = Buffer.from(value.slice(0, 128 << 10), "base64");
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8)
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    offset += length;
  }
  return null;
}
// Playwright appends <-loopback> unless already present. Put it first so the
// following exact loopback rules can reach authorized local project services.
const proxyBypass = "<-loopback>,127.0.0.1,localhost,*.cage-editor.localhost";
const editorHost = value => value === "127.0.0.1" || /^(?:[a-f0-9]{16}|[a-f0-9]{24})\.cage-editor\.localhost$/.test(value);
const keys = new Set(["Tab", "Enter", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);
const specialKeys = new Map([
  [0xff08, ["Backspace", "Backspace", 8]], [0xff09, ["Tab", "Tab", 9]], [0xff0d, ["Enter", "Enter", 13]], [0xff1b, ["Escape", "Escape", 27]],
  [0xff50, ["Home", "Home", 36]], [0xff51, ["ArrowLeft", "ArrowLeft", 37]], [0xff52, ["ArrowUp", "ArrowUp", 38]], [0xff53, ["ArrowRight", "ArrowRight", 39]], [0xff54, ["ArrowDown", "ArrowDown", 40]],
  [0xff55, ["PageUp", "PageUp", 33]], [0xff56, ["PageDown", "PageDown", 34]], [0xff57, ["End", "End", 35]], [0xff63, ["Insert", "Insert", 45]], [0xffff, ["Delete", "Delete", 46]],
  [0xffe1, ["Shift", "ShiftLeft", 16]], [0xffe2, ["Shift", "ShiftRight", 16]], [0xffe3, ["Control", "ControlLeft", 17]], [0xffe4, ["Control", "ControlRight", 17]],
  [0xffe7, ["Meta", "MetaLeft", 91]], [0xffe8, ["Meta", "MetaRight", 92]], [0xffe9, ["Alt", "AltLeft", 18]], [0xffea, ["Alt", "AltRight", 18]], [0xffeb, ["Meta", "MetaLeft", 91]], [0xffec, ["Meta", "MetaRight", 92]],
]);
for (let i = 0; i < 12; i++) specialKeys.set(0xffbe + i, ["F" + (i + 1), "F" + (i + 1), 112 + i]);
function rfbKey(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x11ffffff) throw failure("invalid_input", "Недопустимая клавиша");
  if (specialKeys.has(value)) { const [key, code, windowsVirtualKeyCode] = specialKeys.get(value); return { key, code, windowsVirtualKeyCode }; }
  const cp = (value & 0xff000000) === 0x01000000 ? value & 0xffffff : value;
  if (cp < 32 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (value >= 0xff00 && value < 0x01000000)) throw failure("invalid_input", "Эта клавиша не поддерживается");
  const key = String.fromCodePoint(cp), letter = /^[a-z]$/i.test(key), digit = /^\d$/.test(key);
  return { key, code: letter ? "Key" + key.toUpperCase() : digit ? "Digit" + key : key === " " ? "Space" : "", windowsVirtualKeyCode: letter ? key.toUpperCase().charCodeAt(0) : digit ? key.charCodeAt(0) : key === " " ? 32 : 0, printable: true };
}

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  error.safe = true;
  return error;
}
export function checkedBrowserURL(value) {
  if (typeof value !== "string" || value.length > 4096) throw failure("invalid_url", "Недопустимый адрес браузера");
  if (value === "about:blank") return value;
  let url;
  try { url = new URL(value); } catch { throw failure("invalid_url", "Недопустимый адрес браузера"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw failure("invalid_url", "Only HTTP(S) URLs without credentials are accepted");
  return url.href;
}
export function checkedLoopbackProxy(value) {
  let url;
  try { url = new URL(value); } catch { throw failure("network_unavailable", "Управляемый сетевой прокси гостевой Windows не настроен"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw failure("network_unavailable", "Управляемый сетевой прокси гостевой Windows не настроен");
  return url.origin;
}
export function validWindowsBrowserFileName(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 255 &&
    !/[\\/:<>"|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) && ![".", ".."].includes(value);
}
export function applyWindowsEditorHTMLDefault(html, trustDefault) {
  if (typeof trustDefault !== "boolean") return html;
  const meta = /<meta\b[^>]*\bid="vscode-workbench-web-configuration"[^>]*>/i;
  const tag = html.match(meta)?.[0];
  const attribute = tag?.match(/\bdata-settings="([^"]*)"/i);
  if (!attribute) throw failure("editor_unavailable", "Точка входа настроек редактора не соответствует установленной версии");
  const entities = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };
  const decoded = attribute[1].replace(/&(?:quot|amp|lt|gt|apos|#\d+|#x[0-9a-f]+);/gi, value => {
    const name = value.slice(1, -1).toLowerCase();
    return name[0] === "#" ? String.fromCodePoint(Number.parseInt(name.slice(name[1] === "x" ? 2 : 1), name[1] === "x" ? 16 : 10)) : entities[name];
  });
  const settings = JSON.parse(decoded);
  if (!settings || Array.isArray(settings) || typeof settings !== "object") throw failure("editor_unavailable", "Недопустимая точка входа настроек редактора");
  const previous = settings.configurationDefaults;
  settings.configurationDefaults = { ...(previous && !Array.isArray(previous) && typeof previous === "object" ? previous : {}), "security.workspace.trust.enabled": trustDefault };
  const encoded = JSON.stringify(settings).replace(/[&"<>']/g, value => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;", "'": "&#39;" })[value]);
  return html.replace(meta, tag.replace(attribute[0], `data-settings="${encoded}"`));
}
export function browserExecutable() {
  const owned = path.join(path.dirname(fileURLToPath(import.meta.url)), "chrome", "chrome.exe");
  if (existsSync(owned)) return owned;
  const roots = [process.env.ProgramFiles || "C:\\Program Files", process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"];
  for (const root of roots) for (const relative of ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"]) {
    const executable = path.join(root, ...relative.split("/"));
    if (existsSync(executable)) return executable;
  }
  throw failure("browser_unavailable", "Сначала установите поддерживаемые Chrome или Edge в гостевой Windows");
}

// Tests provide their dependencies explicitly. Production uses the selected
// guest's browser mode, fixed executable, and Cage-owned profile.
export function createNativeBrowserService(options = {}) {
  const mac = options.platform === "darwin";
  const continuousFrames = !mac && options.continuousFrames !== false;
  // The dedicated Windows controller streams the live viewport even when a
  // site hasn't finished downloading fonts. Playwright otherwise waits on
  // document.fonts.ready for every screenshot, blocking the input queue too.
  if (!mac) process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
  const directory = options.directory ?? path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "Cage", "Browser");
  const selectionFile = path.join(directory, "tabs.json");
  const uploadDirectory = path.join(directory, "Uploads");
  const destination = options.downloadDirectory ?? path.join(homedir(), "Downloads", "Cage");
  let context, owner, browserCDP, initialized, closing, proxy, networkMode = "proxy", configured = false;
  let active = "", home = options.homepage ?? "https://www.bing.com/", displayScale = options.displayScale ?? 2;
  let timezone, language;
  let viewport = { width: 1140, height: 700 }, persistQueue = Promise.resolve();
  const tabs = new Map(), byPage = new WeakMap(), sessions = new Map(), frameSessions = new WeakMap(), internalPages = new WeakSet();
  const captures = new Map(), stoppingCaptures = new Map();
  let activeRequests = 0;
  const events = [], transfers = new Map(), privateContexts = new Set(), editorConnections = new Map(), logins = new Map();
  const clipboardCopies = new Map();
  let clipboardHelper, copyVersion = 0, pendingCopy, copying;
  let eventSequence = 0, uploads, downloads, clipboard, pointer, composition, clipboardAvailable = false, cookieActions, extensions, controller, internalCreation, vault;
  let stateVersion = 0, snapshotVersion = -1, snapshotAt = 0, snapshotCache;
  let rfbTarget = "", rfbMask = 0, lastClick, rfbPointer;
  let split, rfbPane;
  const captureMetrics = { screenshots: 0, total_ms: 0, damage_frames: 0, streamed_frames: 0, encoded_bytes: 0, invalid_frames: 0, fallbacks: 0 };
  const heldKeys = new Map();
  let inputOwner, keyTarget;

  function emit(type, value) {
    events.push({ sequence: ++eventSequence, type, value });
    while (events.length > 64 || JSON.stringify(events).length > 350000) events.shift();
  }

  function invalidateCopies() {
    copyVersion++;
    pendingCopy = undefined;
    for (const copy of clipboardCopies.values()) void rm(copy.file, { force: true }).catch(() => {});
    clipboardCopies.clear();
  }

  function copyTarget(proof) {
    const tab = target(proof);
    if (closing || tab.copyContext !== proof.context || proof.version !== copyVersion)
      throw failure("copy_changed", "Источник копирования изменился; скопируйте заново");
    return tab;
  }

  async function privateClipboardPage() {
    if (closing) throw failure("copy_unavailable", "Браузер закрыт");
    if (!clipboardHelper) {
      clipboardHelper = (async () => {
        const isolated = await owner.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
        privateContexts.add(isolated);
        isolated.on("close", () => { privateContexts.delete(isolated); clipboardHelper = undefined; });
        try {
          const page = await isolated.newPage();
          await page.route("http://cage-clipboard.localhost/", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Cage clipboard</title>" }));
          await page.goto("http://cage-clipboard.localhost/", { waitUntil: "domcontentloaded" });
          return page;
        } catch (error) { await isolated.close(); throw error; }
      })();
    }
    return clipboardHelper;
  }

  async function readPrivateClipboard() {
    const helper = await privateClipboardPage();
    const value = await helper.evaluate(async ({ imageLimit, textLimit }) => {
      const items = await navigator.clipboard.read();
      const mime = items.some(item => item.types.includes("image/png")) ? "image/png" : "text/plain";
      const item = items.find(item => item.types.includes(mime));
      if (!item) throw new Error("Clipboard format unavailable");
      const blob = await item.getType(mime);
      if (blob.size > (mime === "image/png" ? imageLimit : textLimit)) throw new Error("Clipboard size exceeded");
      if (mime === "text/plain") return { text: await blob.text() };
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => resolve({ png: reader.result.slice(reader.result.indexOf(",") + 1) });
        reader.readAsDataURL(blob);
      });
    }, { imageLimit, textLimit });
    return value;
  }

  async function copiedPayload(proof, value) {
    copyTarget(proof);
    const payload = { id: proof.id, context: proof.context, document: proof.document };
    if (typeof value.text === "string" && Buffer.byteLength(value.text) <= textLimit && Buffer.byteLength(JSON.stringify(value.text)) <= chunkSize)
      return { ...payload, text: value.text };
    const mime = typeof value.text === "string" ? "text/plain" : "image/png";
    const bytes = Buffer.from(mime === "text/plain" ? value.text : value.png, mime === "text/plain" ? "utf8" : "base64");
    if (bytes.length > (mime === "text/plain" ? textLimit : imageLimit)) throw failure("copy_limit", "Скопированное содержимое превышает ограничение размера");
    if (mime === "image/png" && (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii", 12, 16) !== "IHDR" ||
        !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 40_000_000))
      throw failure("copy_image_invalid", "Скопированное изображение PNG недопустимо");
    const id = randomUUID(), file = path.join(uploadDirectory, "clipboard", id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    try { copyTarget(proof); }
    catch (error) { await rm(file, { force: true }); throw error; }
    clipboardCopies.set(id, { ...proof, reference: id, file, mime, size: bytes.length, created: Date.now() });
    return { ...payload, clipboard: { id, mime, size: bytes.length } };
  }

  function observeCopy(value) {
    if (closing) return;
    const tab = tabs.get(value.id);
    if (value.id !== active || tab?.copyContext !== value.context) return;
    if (!mac) { emit("clipboard", { ...value, document: tab.document }); return; }
    if (tab.explicitCopyContext === value.context) { tab.copyCompletion?.(value); return; }
    invalidateCopies();
    pendingCopy = { value, proof: { id: tab.id, context: value.context, document: tab.document, version: copyVersion } };
    if (copying) return;
    copying = (async () => {
      while (pendingCopy) {
        const current = pendingCopy;
        pendingCopy = undefined;
        try {
          const value = current.value.changed ? await readPrivateClipboard() : current.value;
          emit("clipboard", await copiedPayload(current.proof, value));
        } catch {
          try { copyTarget(current.proof); emit("clipboard", { id: current.proof.id, context: current.proof.context, document: current.proof.document, error: "copy_failed" }); }
          catch {}
        }
      }
    })().finally(() => { copying = undefined; });
  }

  async function copyAction(tab, input, action, signal) {
    if (!tokenPattern.test(input.context || "")) throw failure("invalid_input", "Недопустимый контекст копирования");
    const document = tab.document;
    await privateClipboardPage();
    await tab.page.bringToFront();
    target({ id: tab.id, document });
    invalidateCopies();
    tab.copyContext = input.context;
    tab.explicitCopyContext = input.context;
    await clipboard.setContext(tab.id, input.context);
    const proof = { id: tab.id, context: input.context, document, version: copyVersion };
    let timeout;
    const completed = new Promise((resolve, reject) => {
      tab.copyCompletion = resolve;
      timeout = setTimeout(() => reject(failure("copy_unavailable", "Новое скопированное содержимое не получено; выберите и скопируйте заново")), 5000);
    });
    completed.catch(() => {});
    try {
      signal?.throwIfAborted();
      await tab.page.keyboard.press(action === "cut" ? "Meta+X" : "Meta+C");
      await completed;
      signal?.throwIfAborted();
      copyTarget(proof);
      const value = await readPrivateClipboard();
      signal?.throwIfAborted();
      return await copiedPayload(proof, value);
    } finally { clearTimeout(timeout); tab.copyCompletion = undefined; }
  }
  function remember() {
    if (!context || closing) return;
    const value = [...tabs.values()].filter(t => !t.incognito && !t.login && t.kind !== "editor").map(t => ({ id: t.id, url: t.page.url(), ...(t.kind === "browser-settings" ? { kind: t.kind, publicURL: t.publicURL } : {}) }));
    const data = JSON.stringify({ active, tabs: value });
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      const temporary = selectionFile + "." + token() + ".tmp";
      try { await writeFile(temporary, data, { mode: 0o600, flag: "wx" }); await rename(temporary, selectionFile); }
      finally { await rm(temporary, { force: true }); }
    });
  }
  function changed() { stateVersion++; emit("state", { active }); remember(); }

  async function restoreCaptureMetrics(tab) {
    if (!tab?.restoreCaptureMetrics || tab.page.isClosed()) return;
    const session = sessions.get(tab.session);
    await session.send("Emulation.setDeviceMetricsOverride", {
      ...tab.page.viewportSize(), deviceScaleFactor: displayScale, mobile: false,
      scale: 1, dontSetVisibleSize: false,
    });
    await session.send("Emulation.setVisibleSize", tab.page.viewportSize());
    tab.inputScale = 1;
    tab.restoreCaptureMetrics = false;
  }

  async function stopCapture(page) {
    if (stoppingCaptures.has(page)) return stoppingCaptures.get(page);
    const capture = captures.get(page);
    if (!capture) return;
    captures.delete(page);
    clearTimeout(capture.expiry);
    capture.connection.off("Page.screencastFrame", capture.receive);
    const stopping = (async () => {
      await capture.connection.send("Page.stopScreencast").catch(() => {});
      try {
        if (capture.metrics && !page.isClosed()) {
          const tab = byPage.get(page);
          // A failed restore remains pending: subsequent input must retry it,
          // never proceed with a silently stale coordinate mapping.
          tab.restoreCaptureMetrics = true;
          await restoreCaptureMetrics(tab);
        }
      } finally {
        await capture.connection.detach().catch(() => {});
      }
    })();
    stoppingCaptures.set(page, stopping);
    try { await stopping; } finally { stoppingCaptures.delete(page); }
  }

  function expireCapture(tab, capture) {
    clearTimeout(capture.expiry);
    capture.expiry = setTimeout(() => {
      if (captures.get(tab.page) !== capture) return;
      // Never change the input coordinate mapping halfway through a request.
      if (activeRequests) { expireCapture(tab, capture); return; }
      void stopCapture(tab.page).catch(() => { tab.captureFallback = true; });
    }, 1500);
    capture.expiry.unref?.();
  }

  async function captureFrame(tab) {
    await stoppingCaptures.get(tab.page);
    const size = tab.page.viewportSize();
    // HiDPI surface scaling also affects native menus. Keep the established
    // screenshot path by default until the native popup comparison is verified.
    const streaming = continuousFrames && !tab.captureFallback &&
      (displayScale === 1 || options.continuousFrames === true);
    const key = `${tab.document}:${tab.geometry}:${size.width}:${size.height}:${displayScale}`;
    let capture = captures.get(tab.page);
    if (capture && capture.key !== key) { await stopCapture(tab.page); capture = undefined; }
    if (!capture) {
      const connection = await tab.page.context().newCDPSession(tab.page);
      capture = { key, connection, latest: null, acks: new Set(), expiry: null, metrics: false };
      captures.set(tab.page, capture);
      let received;
      const first = new Promise(resolve => { received = resolve; });
      capture.receive = frame => {
        if (captures.get(tab.page) !== capture) return;
        if (!mac) captureMetrics.damage_frames++;
        capture.acks.add(frame.sessionId);
        captureMetrics.encoded_bytes += Buffer.byteLength(frame.data, "base64");
        if (streaming) {
          capture.resizeDeadline ??= performance.now() + 250;
          const dimensions = jpegFrameSize(frame.data);
          if (!dimensions || dimensions.width !== Math.round(size.width * displayScale) || dimensions.height !== Math.round(size.height * displayScale)) {
            captureMetrics.invalid_frames++;
            // Resizing can emit several valid old surfaces within one render
            // tick. Give their geometry a short, bounded settling window;
            // malformed JPEGs still get at most two startup retries.
            let warmup = false;
            if (dimensions) {
              warmup = performance.now() < capture.resizeDeadline && (capture.resizeFrames || 0) < 16;
              capture.resizeFrames = (capture.resizeFrames || 0) + 1;
            } else if (!capture.latest) {
              warmup = (capture.warmupFrames || 0) < 2;
              capture.warmupFrames = (capture.warmupFrames || 0) + 1;
            }
            if (warmup) {
              capture.acks.delete(frame.sessionId);
              const acknowledge = () => connection.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
              if (dimensions && !capture.resizeRetried) {
                // A pending native-window resize can overwrite the visible
                // surface after setup. Reassert it once after observing that
                // resize; waiting alone cannot repair a persistent old size.
                capture.resizeRetried = true;
                void sessions.get(tab.session).send("Emulation.setVisibleSize", {
                  width: Math.round(size.width * displayScale), height: Math.round(size.height * displayScale),
                }).then(acknowledge).catch(() => { capture.invalid = true; received(); });
              } else void acknowledge().catch(() => {});
              return;
            }
            capture.invalid = true;
            received();
            return;
          }
          captureMetrics.streamed_frames++;
        }
        // Screenshot capture can itself schedule another compositor frame.
        // An identical damage bitmap must not trigger a screenshot feedback
        // loop or invalidate the viewer's existing static-frame receipt.
        if (mac || capture.signal !== frame.data) {
          capture.signal = frame.data;
          capture.latest = { jpeg: mac || streaming ? frame.data : undefined, sequence: token() };
        }
        received();
      };
      connection.on("Page.screencastFrame", capture.receive);
      try {
        if (streaming) {
          // Scale the live compositor surface, not a document-anchored clip.
          // The latter goes blank when the page scrolls beyond that clip.
          // Own the metrics on the tab's long-lived session and restore them
          // between requests when this capture ends.
          const nativeSession = sessions.get(tab.session);
          capture.metrics = true;
          await nativeSession.send("Emulation.setDeviceMetricsOverride", {
            ...size, deviceScaleFactor: displayScale, mobile: false,
            dontSetVisibleSize: true, scale: displayScale,
          });
          await nativeSession.send("Emulation.setVisibleSize", {
            width: Math.round(size.width * displayScale), height: Math.round(size.height * displayScale),
          });
          tab.inputScale = displayScale;
        }
        // Screencast otherwise downscales HiDPI output to CSS pixels. This clip
        // preserves the logical viewport and input coordinates at native density.
        if (mac) await connection.send("Emulation.setDeviceMetricsOverride", {
          ...size, deviceScaleFactor: displayScale, mobile: false,
          viewport: { x: 0, y: 0, ...size, scale: displayScale },
        });
        await connection.send("Page.startScreencast", {
          format: "jpeg", quality: 85,
          maxWidth: Math.round(size.width * displayScale), maxHeight: Math.round(size.height * displayScale),
        });
        if (!mac && !(options.testing && options.headless !== false)) {
          await connection.send("Emulation.setFocusEmulationEnabled", { enabled: false });
        }
        let timeout;
        try {
          await Promise.race([first, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(failure("frame_unavailable", "Поток изображения браузера ещё не готов")), 5000);
          })]);
        } finally { clearTimeout(timeout); }
      } catch (error) {
        await stopCapture(tab.page);
        if (!streaming) throw error;
        tab.captureFallback = true;
        captureMetrics.fallbacks++;
        return captureFrame(tab);
      }
    }
    clearTimeout(capture.expiry);
    if (capture.invalid) {
      await stopCapture(tab.page);
      tab.captureFallback = true;
      captureMetrics.fallbacks++;
      return captureFrame(tab);
    }
    try {
      const frame = capture.latest;
      // Windows screencast preserves a damage stream at CSS resolution, but a
      // viewport scale changes its native input surface. Capture only new damage
      // at the context's actual device density and reuse it for static frames.
      if (!mac && !frame.jpeg) {
        const started = performance.now();
        frame.jpeg = (await tab.page.screenshot({ type: "jpeg", quality: 85, caret: "initial" })).toString("base64");
        captureMetrics.screenshots++;
        captureMetrics.total_ms += performance.now() - started;
      }
      // Return credit only when the viewer consumes a frame. Chromium's bounded
      // in-flight window supplies backpressure even during continuous animation.
      const acknowledgements = [...capture.acks];
      capture.acks.clear();
      for (const sessionId of acknowledgements)
        await capture.connection.send("Page.screencastFrameAck", { sessionId });
      return frame;
    } finally {
      // Only time spent between requests counts as viewer inactivity.
      if (captures.get(tab.page) === capture) {
        expireCapture(tab, capture);
      }
    }
  }
  async function cdp(method, params = {}, sessionID) {
    if (!sessionID) return browserCDP.send(method, params);
    const session = sessions.get(sessionID);
    if (!session) throw failure("target_changed", "Input target changed");
    // Playwright owns out-of-process-frame discovery. It does not expose raw
    // flattened child session transports, so each Frame gets its own CDPSession.
    if (method === "Target.setAutoAttach") return {};
    if (method === "Input.dispatchMouseEvent") {
      const tab = [...tabs.values()].find(tab => tab.session === sessionID);
      const scale = tab?.inputScale ?? 1;
      params = { ...params, x: params.x * scale, y: params.y * scale };
    }
    return session.send(method, params);
  }
  function detachFrame(tab, frame, expected) {
    const id = tab.frameSessions.get(frame);
    if (!id || expected && expected !== id) return;
    tab.frameSessions.delete(frame);
    frameSessions.delete(frame);
    const connection = sessions.get(id);
    sessions.delete(id);
    clipboard.detachSession(id);
    // Explicit detach also releases Playwright's transport and event listeners.
    void connection?.detach().catch(() => {});
  }

  async function attachFrame(tab, frame) {
    if (frameSessions.has(frame) || frame.isDetached()) return;
    const id = token();
    // Navigation and frameattached can race while newCDPSession is pending.
    frameSessions.set(frame, id);
    tab.frameSessions.set(frame, id);
    try {
      const connection = await tab.page.context().newCDPSession(frame);
      if (tab.page.isClosed() || frame.isDetached() || frameSessions.get(frame) !== id) {
        detachFrame(tab, frame, id);
        await connection.detach().catch(() => {});
        return;
      }
      sessions.set(id, connection);
      for (const method of ["Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Runtime.bindingCalled", "Page.frameDetached", "Page.frameNavigated"]) {
        connection.on(method, params => clipboard.event({ sessionId: id, method, params }));
      }
      await clipboard.attach(id, tab.id);
      if (tab.copyContext) await clipboard.setContext(tab.id, tab.copyContext);
    } catch { detachFrame(tab, frame, id); }
  }
  async function addPage(page, { id = token(), incognito = false, login = false, kind = "web", workspace, blocked = false } = {}) {
    if (byPage.has(page)) { const existing = byPage.get(page); await existing.ready; return existing; }
    if (tabs.size >= 100) { await page.close(); throw failure("tab_limit", "Открыто слишком много вкладок; сначала закройте часть вкладок"); }
    const tab = { id, page, incognito, login, kind, workspace, blocked, document: token(), geometry: token(), title: "", copyContext: "", frameSessions: new Map() };
    tabs.set(id, tab); byPage.set(page, tab);
    page.on("close", () => {
      void stopCapture(page);
      for (const frame of tab.frameSessions.keys()) detachFrame(tab, frame);
      tabs.delete(id); clipboard?.detachTab(id); uploads?.cancelTab(id);
      if (active === id) invalidateCopies();
      if (vault) for (const [sid, entry] of vault.sessions) if (entry.tab === id) vault.sessions.delete(sid);
      if (active === id) active = [...tabs.keys()].at(-1) || "";
      if (pointer?.id === id) pointer = undefined;
      if (composition?.id === id) composition = undefined;
      if (split && [split.left, split.right].includes(id)) { split = undefined; void applyViewport(); }
      if (incognito && ![...tabs.values()].some(t => t.page.context() === page.context() && !t.page.isClosed())) { privateContexts.delete(page.context()); void page.context().close().catch(() => {}); }
      changed();
    });
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) {
        if (active === id) invalidateCopies();
        if (tab.kind !== "editor") {
          try {
            const address = new URL(page.url()), project = /^([a-f0-9]{16}(?:[a-f0-9]{8})?)\.cage-editor\.localhost$/.exec(address.hostname)?.[1];
            if (project) {
              const connection = editorConnections.get(project);
              tab.kind = "editor"; tab.workspace = project; tab.visibleWorkspace = connection?.folder ?? project; tab.editorConnection = connection?.id; tab.blocked = !connection;
            }
          } catch {}
        }
        tab.document = token(); tab.geometry = token(); tab.copyContext = ""; tab.caret = undefined;
        uploads?.cancelTab(id); if (pointer?.id === id) pointer = undefined;
        if (composition?.id === id) composition = undefined;
        if (split && [split.left, split.right].includes(id)) split.generation = token();
        changed();
      }
      void attachFrame(tab, frame);
    });
    page.on("frameattached", frame => { void attachFrame(tab, frame); });
    page.on("domcontentloaded", changed);
    page.on("framedetached", frame => detachFrame(tab, frame));
    tab.ready = (async () => {
    // A persistent context keeps its launch viewport for newly opened pages.
    // Each tab must join the workbench's current viewport before capture starts.
    await page.setViewportSize(viewport);
    const connection = await page.context().newCDPSession(page), sid = token();
    if (page.isClosed()) { await connection.detach().catch(() => {}); return; }
    tab.session = sid; sessions.set(sid, connection); frameSessions.set(page.mainFrame(), sid);
    tab.frameSessions.set(page.mainFrame(), sid);
    // Playwright enables focus emulation for every page. Native input proofs
    // must observe the real selected document and native Chrome UI focus.
    if (!mac && !(options.testing === true && options.headless !== false)) await connection.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    tab.browserContextId = (await connection.send("Target.getTargetInfo")).targetInfo.browserContextId;
    tab.nativeTarget = (await connection.send("Target.getTargetInfo")).targetInfo.targetId;
    for (const method of ["Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Runtime.bindingCalled", "Page.frameDetached", "Page.frameNavigated"]) {
      connection.on(method, params => { clipboard.event({ sessionId: sid, method, params }); vault?.event({ sessionId: sid, method, params }); });
    }
    connection.on("Page.fileChooserOpened", params => {
      if (active === id) void uploads.opened(id, sid, params).catch(() => {});
    });
    await connection.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await clipboard.attach(sid, id);
    await vault?.attach(id, sid);
    for (const frame of page.frames()) if (frame !== page.mainFrame()) await attachFrame(tab, frame);
    if (incognito) {
      await browserCDP.send("Browser.setDownloadBehavior", { behavior: "allowAndName", browserContextId: tab.browserContextId, downloadPath: path.join(directory, "Downloads"), eventsEnabled: true });
    }
    })();
    await tab.ready;
    if (!active) active = id;
    changed(); return tab;
  }
  async function saveDownload(id, name) {
    if (!validWindowsBrowserFileName(name)) throw failure("file_invalid", "Имя загружаемого файла недопустимо для Windows; выберите другое имя на веб-странице");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    let file, output, savedName;
    for (let attempt = 0; attempt < 100; attempt++) {
      savedName = attempt ? `${path.parse(name).name} (${attempt})${path.extname(name)}` : name;
      output = path.join(destination, savedName);
      try { file = await open(output, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    if (!file) throw failure("download_unavailable", "В Downloads слишком много файлов с тем же именем; упорядочьте их и повторите попытку");
    try {
      await pipeline(createReadStream(path.join(directory, "Downloads", id)), file.createWriteStream());
      return { ok: true, path: "Downloads/" + savedName, name: savedName, bytes: (await stat(output)).size };
    } catch { await rm(output, { force: true }); throw failure("download_unavailable", "Сохранение загрузки не завершено; проверьте свободное место в гостевой системе"); }
  }
  async function initialize() {
    if (initialized) return initialized;
    initialized = (async () => {
      if (!options.testing && process.platform !== (mac ? "darwin" : "win32")) throw failure("platform_unavailable", "Браузер необходимо запустить в выбранной гостевой системе");
      if (!configured) throw failure("network_unavailable", "Управляемый сетевой прокси гостевой Windows не настроен");
      let chromium, modules;
      try {
        chromium = options.chromium ?? (await import(new URL("./playwright/index.mjs", import.meta.url))).chromium;
        modules = options.modules ?? Object.assign({},
          await import(new URL("./modules/browser-clipboard.mjs", import.meta.url)),
          await import(new URL("./modules/browser-uploads.mjs", import.meta.url)),
          await import(new URL("./modules/browser-downloads.mjs", import.meta.url)),
          await import(new URL("./modules/browser-cookies.mjs", import.meta.url)),
          await import(new URL("./modules/browser-extensions.mjs", import.meta.url)),
          await import(new URL("./modules/browser-vault.mjs", import.meta.url)));
      } catch { throw failure("browser_unavailable", "Компоненты браузера гостевой Windows установлены не полностью"); }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Remove only this controller's scratch uploads. Profiles, downloads and
      // editor buffers are persistent and are never initialized away.
      await rm(uploadDirectory, { recursive: true, force: true });
      const splitDirectory = options.splitDirectory ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "split-extension");
      const extensionTools = typeof modules.BrowserExtensions === "function" && existsSync(path.join(splitDirectory, "manifest.json"));
      try {
        context = await chromium.launchPersistentContext(options.profileDirectory ?? path.join(directory, "Profile"), {
          executablePath: options.executablePath ?? browserExecutable(), headless: mac || (options.testing === true && options.headless !== false),
          chromiumSandbox: true, viewport, deviceScaleFactor: displayScale, acceptDownloads: true,
          ...(timezone ? { timezoneId: timezone } : {}), ...(language ? { locale: language } : {}),
          ...(networkMode === "proxy" ? { proxy: { server: proxy, bypass: proxyBypass } } : {}),
          // CDP transports the user's input. Preserve the native browser identity
          // in every context, including private pages that cannot load extensions.
          args: ["--disable-blink-features=AutomationControlled", "--disable-quic", "--no-first-run", "--no-default-browser-check", "--restore-last-session", "--disable-session-crashed-bubble", "--host-resolver-rules=MAP *.cage-editor.localhost 127.0.0.1", ...(networkMode === "packet" ? ["--no-proxy-server"] : []), ...(extensionTools ? ["--enable-unsafe-extension-debugging", `--load-extension=${splitDirectory}`] : [])],
          ignoreDefaultArgs: ["--enable-automation", ...(extensionTools ? ["--disable-extensions"] : []), ...(mac ? ["--mute-audio"] : [])], timeout: 20000,
        });
      } catch (error) { if (error.code) throw error; throw failure("browser_unavailable", "Графический браузер гостевой Windows не запустился; проверьте сеанс GUI и установленные компоненты"); }
      context.setDefaultTimeout(7000); owner = context.browser();
      if (!owner) throw failure("browser_unavailable", "Соединение управления браузером гостевой Windows не готово");
      browserCDP = await owner.newBrowserCDPSession();
      clipboard = new modules.BrowserClipboard(cdp, observeCopy, { includeChanges: mac });
      clipboardAvailable = true;
      if (modules.BrowserVault) vault = new modules.BrowserVault({ cdp, active: () => active, tab: id => { const tab = tabs.get(id); return tab ? { ...tab, url: tab.page.url() } : undefined; } });
      cookieActions = modules.browserCookies;
      uploads = new modules.UploadManager({ directory: uploadDirectory, cdp, changed });
      downloads = new modules.DownloadManager({ directory, save: saveDownload, changed, cancel: id => browserCDP.send("Browser.cancelDownload", { guid: id }) });
      browserCDP.on("Browser.downloadWillBegin", data => downloads.begin(data.guid, data.suggestedFilename));
      browserCDP.on("Browser.downloadProgress", data => downloads.progress(data));
      await browserCDP.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: path.join(directory, "Downloads"), eventsEnabled: true });
      let saved;
      try { const bytes = await readFile(selectionFile); if (bytes.length <= 1 << 20) saved = JSON.parse(bytes); } catch {}
      const existing = context.pages(), restoredIDs = new Set();
      for (const page of existing) {
        const controlURL = extensionTools ? `chrome-extension://${nativeExtensionIDForPath(splitDirectory)}/control.html` : "";
        if (controlURL && page.url() === controlURL) { internalPages.add(page); continue; }
        let editorProject;
        try { editorProject = /^([a-f0-9]{16}(?:[a-f0-9]{8})?)\.cage-editor\.localhost$/.exec(new URL(page.url()).hostname)?.[1]; } catch {}
        if (editorProject) { await addPage(page, { kind: "editor", workspace: editorProject, blocked: true }); continue; }
        const match = Array.isArray(saved?.tabs) ? saved.tabs.find(t => tokenPattern.test(t.id || "") && !restoredIDs.has(t.id) && t.url === page.url()) : undefined;
        const tab = await addPage(page, match ? { id: match.id, kind: match.kind === "browser-settings" ? "browser-settings" : "web" } : {});
        if (match?.kind === "browser-settings" && /^cage:\/\/settings#(general|appearance|privacy|extensions|about)$/.test(match.publicURL || "")) tab.publicURL = match.publicURL;
        if (match) restoredIDs.add(match.id);
      }
      const used = new Set();
      if (Array.isArray(saved?.tabs) && saved.tabs.length <= 100) for (const entry of saved.tabs) {
        try {
          const url = checkedBrowserURL(entry.url); if (!tokenPattern.test(entry.id)) continue;
          let tab = [...tabs.values()].find(t => !used.has(t) && t.page.url() === url);
          if (!tab) {
            const page = await context.newPage(); tab = await addPage(page, { id: entry.id, kind: entry.kind === "browser-settings" ? "browser-settings" : "web" });
            if (entry.kind === "browser-settings" && /^cage:\/\/settings#(general|appearance|privacy|extensions|about)$/.test(entry.publicURL || "")) tab.publicURL = entry.publicURL;
            if (url !== "about:blank") await page.goto(url, { waitUntil: "commit", timeout: 8000 });
          }
          used.add(tab);
        } catch { /* Restore other tabs even if one saved page is unavailable. */ }
      }
      context.on("page", page => { void (async () => {
        if (internalCreation) await internalCreation;
        if (!internalPages.has(page)) await addPage(page).then(tab => activate(tab.id));
      })().catch(() => {}); });
      if (tabs.has(saved?.active)) active = saved.active;
      if (!active) await addPage(await context.newPage());
      await activate(active);
      if (extensionTools) {
        try {
          const loaded = await browserCDP.send("Extensions.getExtensions").catch(() => ({ extensions: [] }));
          let own = loaded.extensions.find(e => path.resolve(e.path) === path.resolve(splitDirectory));
          if (!own) own = await browserCDP.send("Extensions.loadUnpacked", { path: splitDirectory });
          const protectedID = own.id;
          const control = async repair => {
            if (repair && controller) { await controller.page.close().catch(() => {}); sessions.delete(controller.session); controller = undefined; }
            if (controller?.page.isClosed()) controller = undefined;
            if (!controller) {
              let complete;
              internalCreation = new Promise(resolve => { complete = resolve; });
              try {
                const page = context.pages().find(page => internalPages.has(page) && page.url() === `chrome-extension://${protectedID}/control.html`) ?? await context.newPage(); internalPages.add(page);
                await page.goto(`chrome-extension://${protectedID}/control.html`, { waitUntil: "load", timeout: 7000 });
                const connection = await context.newCDPSession(page), session = token(); sessions.set(session, connection);
                controller = { page, session };
                if (!await page.evaluate(() => typeof globalThis.manageCageExtensions === "function")) throw failure("extensions_unavailable", "Компонент управления расширениями не готов");
              } finally { complete(); internalCreation = undefined; }
              await tabs.get(active)?.page.bringToFront();
            }
            return controller.session;
          };
          extensions = new modules.BrowserExtensions({ directory, cdp, control, protectedID, extractArchive: extractWindowsExtensionArchive, idForPath: nativeExtensionIDForPath });
          await control(); await extensions.restore();
        } catch { extensions = undefined; }
      }
      context.on("close", () => { context = undefined; initialized = undefined; tabs.clear(); sessions.clear(); active = ""; });
      changed();
    })().catch(async error => { initialized = undefined; await context?.close().catch(() => {}); context = undefined; throw error; });
    return initialized;
  }
  async function configure(input) {
    if (configured) return { ok: true };
    if (input.networkMode === "packet") { networkMode = "packet"; proxy = undefined; }
    else { proxy = checkedLoopbackProxy(input.proxy); networkMode = "proxy"; }
    if (input.displayScale !== undefined) {
      if (![1, 1.5, 2].includes(input.displayScale)) throw failure("invalid_input", "Недопустимая плотность пикселей");
      displayScale = input.displayScale;
    }
    if (input.timezone !== undefined) {
      try { timezone = new Intl.DateTimeFormat("en", { timeZone: input.timezone }).resolvedOptions().timeZone; }
      catch { throw failure("invalid_configuration", "Недопустимая настройка часового пояса браузера гостевой системы"); }
    }
    if (input.language !== undefined) {
      if (typeof input.language !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(input.language)) throw failure("invalid_configuration", "Недопустимая настройка языка браузера гостевой системы");
      language = input.language;
    }
    configured = true;
    return { ok: true };
  }
  async function activate(id) {
    const tab = tabs.get(id); if (!tab) throw failure("target_changed", "Tab no longer exists");
    if (active !== id) { invalidateCopies(); pointer = undefined; composition = undefined; tab.geometry = token(); }
    if (split && ![split.left, split.right].includes(id)) { split = undefined; await applyViewport(); }
    active = id; await tab.page.bringToFront(); changed(); return { ok: true };
  }
  function target(input, requireActive = true, allowBlocked = false) {
    const id = input.id || active, tab = tabs.get(id);
    if (!tab || tab.page.isClosed()) throw failure("target_changed", "Tab no longer exists");
    if (tab.blocked && !allowBlocked) throw failure("project_grant_unavailable", "Авторизация проекта разорвана; подключите этот проект заново");
    if ((requireActive && id !== active) || (input.document && input.document !== tab.document)) throw failure("target_changed", "Input target changed");
    return tab;
  }
  async function snapshot() {
    if (snapshotCache && snapshotVersion === stateVersion && Date.now() - snapshotAt < 5000) return snapshotCache;
    const version = stateVersion;
    const list = [];
    for (const tab of tabs.values()) {
      try { tab.title = (await tab.page.title()).slice(0, 160); } catch {}
      let url = tab.publicURL || (tab.kind === "editor" ? "cage://editor" : tab.page.url().slice(0, 4096));
      if (tab.login) { try { url = new URL(tab.page.url()).origin; } catch { url = "about:blank"; } }
      list.push({ id: tab.id, url, title: tab.login ? "Авторизация аккаунта" : tab.kind === "browser-settings" ? "Настройки" : tab.title || (tab.page.url() === "about:blank" ? "Новая вкладка" : "Веб-страница"), document: tab.document, incognito: tab.incognito, login: tab.login, favicon: "", kind: tab.kind, blocked: Boolean(tab.blocked), ...(tab.workspace ? { workspace: tab.visibleWorkspace ?? tab.workspace } : {}) });
    }
    let back = false, forward = false;
    if (tabs.has(active)) try { const h = await cdp("Page.getNavigationHistory", {}, tabs.get(active).session); back = h.currentIndex > 0; forward = h.currentIndex < h.entries.length - 1; } catch {}
    let panes = null;
    if (split) {
      const history = {};
      for (const id of [split.left, split.right]) try { const h = await cdp("Page.getNavigationHistory", {}, tabs.get(id).session); history[id] = { back: h.currentIndex > 0, forward: h.currentIndex < h.entries.length - 1 }; } catch {}
      panes = { left: split.left, right: split.right, fraction: split.fraction, history };
    }
    const result = { active, split: panes, back, forward, tabs: list, uploads: uploads.snapshot(), downloads: downloads.snapshot(), capabilities: { nativeClipboard: true, systemClipboard: !mac, copyObserver: clipboardAvailable, files: true, frames: true, cookies: typeof cookieActions === "function", vault: Boolean(vault), login: true, editor: typeof options.editor === "function" || editorConnections.size > 0, split: true, extensions: Boolean(extensions) } };
    snapshotVersion = version; snapshotAt = Date.now(); snapshotCache = result;
    return result;
  }
  async function applyViewport() {
    const left = Math.max(80, Math.min(viewport.width - 80, Math.floor(viewport.width * (split?.fraction || 0.5))));
    for (const tab of tabs.values()) {
      const width = split?.left === tab.id ? left : split?.right === tab.id ? viewport.width - left : viewport.width;
      await stopCapture(tab.page);
      await tab.page.setViewportSize({ width, height: viewport.height }); tab.inputScale = 1; tab.geometry = token();
    }
    if (split) split.generation = token();
  }
  async function setSplit(input) {
    if (!input.left) { split = undefined; await applyViewport(); if (input.id) await activate(input.id); changed(); return { split: null }; }
    const left = target({ id: input.left }, false), right = target({ id: input.right }, false);
    if (left === right || ![left.id, right.id].includes(input.id) || left.page.context() !== right.page.context() || left.incognito || right.incognito || left.kind === "browser-settings" || right.kind === "browser-settings") throw failure("invalid_split", "Разные сеансы браузера нельзя разделить на экраны");
    const fraction = input.fraction ?? 0.5;
    if (!Number.isFinite(fraction) || fraction < 0.15 || fraction > 0.85 || viewport.width < 160) throw failure("invalid_split", "Недопустимая пропорция или размер разделения экрана");
    split = { left: left.id, right: right.id, fraction, generation: token() };
    await applyViewport(); await activate(input.id); changed(); return { split: (await snapshot()).split };
  }
  async function nativeDocumentFocused(tab) {
    const tree = await cdp("Page.getFrameTree", {}, tab.session);
    const isolated = await cdp("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "cage-native-window-proof" }, tab.session);
    const focus = await cdp("Runtime.evaluate", { expression: "Document.prototype.hasFocus.call(document)", contextId: isolated.executionContextId, returnByValue: true }, tab.session);
    return focus.result?.value === true;
  }
  async function syncNativeFrontTab() {
    const old = tabs.get(active);
    if (old && !old.page.isClosed() && await nativeDocumentFocused(old).catch(() => false)) return false;
    const focused = [];
    for (const tab of tabs.values()) if (tab !== old && !tab.page.isClosed() && await nativeDocumentFocused(tab).catch(() => false)) focused.push(tab);
    if (focused.length === 1) { active = focused[0].id; changed(); }
    return focused.length > 1;
  }
  async function nativeFrameProof() {
    const focusAmbiguous = await syncNativeFrontTab();
    const tab = target({ id: active });
    const native = await browserCDP.send("Browser.getWindowForTarget", { targetId: tab.nativeTarget });
    const documentFocused = await nativeDocumentFocused(tab);
    const size = tab.page.viewportSize();
    return { target: split?.generation ?? tab.geometry, document: tab.document, id: tab.id, window: native, documentFocused, focusAmbiguous, blankDocument: tab.page.url() === "about:blank",
      x: split?.right === tab.id ? Math.round(tabs.get(split.left).page.viewportSize().width * displayScale) : 0, y: 0,
      width: Math.round(size.width * displayScale), height: Math.round(size.height * displayScale), scale: displayScale };
  }
  async function nativeFocusProof() {
    await syncNativeFrontTab();
    const tab = target({ id: active });
    const tree = await cdp("Page.getFrameTree", {}, tab.session);
    const roots = new Map([[tree.frameTree.frame.id, tab.session]]);
    for (const session of new Set(tab.page.frames().map(frame => frameSessions.get(frame)))) {
      if (!session || session === tab.session) continue;
      const child = await cdp("Page.getFrameTree", {}, session).catch(() => null);
      if (child) roots.set(child.frameTree.frame.id, session);
    }
    const nodes = [], visited = new Set();
    let frameId = tree.frameTree.frame.id, session = tab.session;
    while (frameId) {
      if (visited.has(frameId)) throw failure("target_changed", "Input target changed");
      visited.add(frameId);
      session = roots.get(frameId) || session;
      const isolated = await cdp("Page.createIsolatedWorld", { frameId, worldName: "cage-native-paste-proof" }, session);
      try {
        const result = await cdp("Runtime.evaluate", { expression: `(() => { let e=Object.getOwnPropertyDescriptor(Document.prototype,'activeElement').get.call(document); while(e){const root=Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot').get.call(e); if(!root)break; const next=Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'activeElement').get.call(root);if(!next)break;e=next;}return e; })()`, contextId: isolated.executionContextId, objectGroup: "cage-paste-proof" }, session);
        if (!result.result?.objectId) throw failure("target_changed", "Input target changed");
        const { node } = await cdp("DOM.describeNode", { objectId: result.result.objectId }, session);
        nodes.push(`${frameId}:${isolated.executionContextId}:${node.backendNodeId}`);
        frameId = node.frameId;
      } finally { await cdp("Runtime.releaseObjectGroup", { objectGroup: "cage-paste-proof" }, session); }
    }
    return { focus: `${tab.document}:${nodes.join("/")}` };
  }
  function point(input, size = viewport) {
    if (![input.x, input.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw failure("invalid_input", "Недопустимое положение указателя");
    return { x: Math.min(size.width - 1, input.x * size.width), y: Math.min(size.height - 1, input.y * size.height) };
  }
  async function caret(tab) {
    for (const frame of tab.page.frames()) {
      if (frame.isDetached()) continue;
      await attachFrame(tab, frame);
      const sid = frameSessions.get(frame); if (!sid) continue;
      const result = await cdp("Runtime.evaluate", { expression: "document.hasFocus() && document.activeElement", objectGroup: "cage-caret" }, sid);
      if (!result.result?.objectId) continue;
      try {
        const details = await cdp("DOM.describeNode", { objectId: result.result.objectId }, sid);
        const value = await cdp("Runtime.callFunctionOn", { objectId: result.result.objectId, returnByValue: true, functionDeclaration: `function() {
          const e=this, editable=e.isContentEditable || e.tagName==='TEXTAREA' || (e.tagName==='INPUT' && !['button','checkbox','radio','submit','reset','file','hidden'].includes(e.type));
          if (!editable) return null;
          const r=e.getBoundingClientRect(), selection=document.getSelection(); let x=r.left, y=r.top, height=r.height;
          if (e.isContentEditable && selection?.rangeCount) { const a=selection.getRangeAt(0).cloneRange(); a.collapse(false); const q=a.getBoundingClientRect(); if(q.height){x=q.left;y=q.top;height=q.height;} }
          else if(typeof e.selectionEnd==='number') { const s=getComputedStyle(e), c=document.createElement('canvas').getContext('2d'); c.font=s.font; x+=parseFloat(s.paddingLeft)||0; x+=c.measureText(e.value.slice(0,e.selectionEnd).split('\\n').at(-1)).width-e.scrollLeft; height=parseFloat(s.lineHeight)||parseFloat(s.fontSize)||16; }
          return {rect:[Math.max(r.left,Math.min(r.right,x)),y,0,height]};
        }` }, sid);
        if (!value.result?.value) continue;
        const node = details.node.backendNodeId;
        if (!tab.caret || tab.caret.node !== node || tab.caret.session !== sid) tab.caret = { node, session: sid, context: token() };
        return { available: true, context: tab.caret.context, rect: value.result.value.rect.map(v => v * displayScale) };
      } finally { await cdp("Runtime.releaseObjectGroup", { objectGroup: "cage-caret" }, sid).catch(() => {}); }
    }
    tab.caret = undefined; return { available: false };
  }
  async function ime(input) {
    const tab = target(input);
    if (input.target !== "browser") throw failure("input_unavailable", "Ввод IME на рабочем столе гостевой Windows должен выполняться через нативный оконный канал");
    if (input.mode === "status") {
      const state = await caret(tab);
      if (rfbPointer?.tab === tab && rfbPointer.document === tab.document) {
        const { x, y } = rfbPointer;
        const result = await cdp("Runtime.evaluate", {
          expression: `(() => {
            let element = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
            while (element?.shadowRoot) {
              const child = element.shadowRoot.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
              if (!child || child === element) break;
              element = child;
            }
            if (!element) return 'default';
            const cursor = getComputedStyle(element).cursor;
            if (cursor !== 'auto') return cursor;
            const editable = element.isContentEditable || element.tagName === 'TEXTAREA' ||
              (element.tagName === 'INPUT' && ['text','search','url','tel','email','password','number'].includes(element.type));
            return editable ? 'text' : 'default';
          })()`,
          returnByValue: true,
        }, tab.session);
        const cursor = result.result?.value;
        state.cursor = ["text", "pointer", "default"].includes(cursor) ? cursor : "default";
      }
      return state;
    }
    input = { text: "", selectionStart: 0, selectionEnd: 0, ...input };
    if (!tokenPattern.test(input.session || "") || !Number.isSafeInteger(input.sequence) || input.sequence < 0 || typeof input.text !== "string" || Buffer.byteLength(input.text) > 8192)
      throw failure("invalid_input", "Недопустимое состояние композиции IME");
    if (input.mode === "begin") {
      const status = await caret(tab);
      if (!status.available || input.context !== status.context) throw failure("target_changed", "Input target changed");
      composition = { id: tab.id, document: tab.document, context: status.context, session: input.session, sequence: input.sequence };
      return { ...status, ok: true };
    }
    if (!composition || composition.id !== tab.id || composition.document !== tab.document || composition.session !== input.session || input.sequence <= composition.sequence)
      throw failure("target_changed", "Input target changed");
    const status = await caret(tab);
    if (!status.available || status.context !== composition.context) { composition = undefined; throw failure("target_changed", "Input target changed"); }
    composition.sequence = input.sequence;
    if (input.mode === "update") {
      if (!Number.isInteger(input.selectionStart) || !Number.isInteger(input.selectionEnd) || input.selectionStart < 0 || input.selectionEnd < input.selectionStart || input.selectionEnd > input.text.length)
        throw failure("invalid_input", "Недопустимый диапазон выбора IME");
      await cdp("Input.imeSetComposition", { text: input.text, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd }, tab.session);
    } else if (input.mode === "commit") {
      await cdp("Input.insertText", { text: input.text }, tab.session); composition = undefined;
    } else if (input.mode === "cancel") {
      await cdp("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 }, tab.session); composition = undefined;
    } else throw failure("invalid_input", "Недопустимое состояние композиции IME");
    return { ...status, ok: true };
  }
  function checkTransfer(input) {
    const transfer = transfers.get(input.transfer);
    if (!transfer || !Number.isSafeInteger(input.sequence) || input.sequence !== transfer.sequence) throw failure("transfer_changed", "Передача файла закрыта или порядок недопустим");
    transfer.used = Date.now();
    if (transfer.direction === "upload") {
      const request = uploads.request(transfer.id), tab = tabs.get(request.tabId);
      if (request !== transfer.request || active !== request.tabId || tab?.document !== transfer.document) throw failure("target_changed", "Страница получения файла изменилась; вернитесь на исходную страницу и повторите");
    }
    if (transfer.copy) {
      copyTarget(transfer.copy);
      if (clipboardCopies.get(transfer.copy.reference) !== transfer.copy) throw failure("copy_changed", "Скопированное содержимое устарело; скопируйте заново");
    }
    return transfer;
  }
  async function closeTransfer(id) {
    const transfer = transfers.get(id); if (!transfer) return;
    transfers.delete(id); transfer.stream?.destroy(failure("transfer_closed", "Передача файла отменена"));
    if (transfer.direction === "upload") uploads?.cancel(transfer.id);
    await transfer.file?.close().catch(() => {});
  }
  async function pasteAction(action, input, signal) {
    signal?.throwIfAborted();
    if (action === "paste-cancel") { await closeTransfer(input.transfer); return { ok: true }; }
    if (action === "paste-start") {
      const tab = target(input), length = input.length ?? 0;
      if (transfers.size >= 8 || !Number.isSafeInteger(length) || length < 0 || length > (input.mime === "text/plain" ? textLimit : imageLimit) ||
          input.mime && !["image/png", "text/plain"].includes(input.mime))
        throw failure("image_target_invalid", "Недопустимая цель или размер изображения");
      const document = tab.document, geometry = tab.geometry;
      if (mac) {
        invalidateCopies(); tab.copyContext = "";
        await clipboard.setContext(tab.id, "");
      }
      const focus = await nativeFocusProof();
      signal?.throwIfAborted();
      if (target(input) !== tab || tab.document !== document || tab.geometry !== geometry) throw failure("image_target_changed", "Image target changed");
      const id = token();
      transfers.set(id, { direction: "paste", id: tab.id, document, geometry, focus: focus.focus, mime: input.mime, length, received: 0, sequence: 0, used: Date.now(), chunks: [] });
      return { transfer: id };
    }
    let transfer;
    try {
      transfer = checkTransfer(input);
      if (transfer.direction !== "paste") throw failure("image_transfer_changed", "Передача вставки закрыта");
      const tab = target({ id: transfer.id, document: transfer.document });
      if (tab.geometry !== transfer.geometry || (await nativeFocusProof()).focus !== transfer.focus)
        throw failure("image_target_changed", "Image target changed");
      if (action === "paste-chunk") {
        if (transfer.sequence === 0 && !transfer.mime) transfer.mime = input.mime;
        if (!["image/png", "text/plain"].includes(transfer.mime) || input.mime && input.mime !== transfer.mime)
          throw failure("invalid_input", "Недопустимый тип вставляемого содержимого");
        if (!transfer.length && transfer.sequence === 0) {
          if (!Number.isSafeInteger(input.length) || input.length < 1 || input.length > (transfer.mime === "text/plain" ? textLimit : imageLimit)) throw failure("image_limit", "Недопустимый размер вставляемого содержимого");
          transfer.length = input.length;
        }
        if (transfer.length > (transfer.mime === "text/plain" ? textLimit : imageLimit)) throw failure("image_limit", "Вставляемое содержимое превышает ограничение размера");
        if (typeof input.data !== "string" || input.data.length > Math.ceil(chunkSize / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data))
          throw failure("image_chunk_invalid", "Недопустимый блок данных изображения");
        const bytes = Buffer.from(input.data, "base64");
        if (!bytes.length || bytes.length > chunkSize || transfer.received + bytes.length > transfer.length) throw failure("image_chunk_invalid", "Блок данных изображения превышает заявленный размер");
        transfer.chunks.push(bytes); transfer.received += bytes.length; transfer.sequence++;
        return { ack: transfer.sequence };
      }
      if (action !== "paste-finish" || transfer.received !== transfer.length || transfer.length < 1) throw failure("image_incomplete", "Вставляемое содержимое получено не полностью");
      const bytes = Buffer.concat(transfer.chunks, transfer.received);
      let text;
      if (transfer.mime === "text/plain") {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (mac) {
          const helper = await privateClipboardPage();
          signal?.throwIfAborted();
          await helper.evaluate(text => navigator.clipboard.writeText(text), text);
        }
      } else {
        if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii", 12, 16) !== "IHDR" ||
            !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 40_000_000)
          throw failure("image_invalid", "Недопустимое изображение PNG");
        // A private, local helper origin writes Chromium's clipboard. The site
        // receives an ordinary paste event without gaining clipboard permissions.
        const helper = await privateClipboardPage();
        signal?.throwIfAborted();
        await helper.evaluate(async encoded => {
          const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
          await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
        }, bytes.toString("base64"));
      }
      await tab.page.bringToFront();
      if (target({ id: transfer.id, document: transfer.document }) !== tab || tab.geometry !== transfer.geometry || (await nativeFocusProof()).focus !== transfer.focus)
        throw failure("image_target_changed", "Image target changed");
      signal?.throwIfAborted();
      if (text !== undefined && !mac) await tab.page.keyboard.insertText(text);
      else await tab.page.keyboard.press(mac ? "Meta+V" : "Control+V");
      transfers.delete(input.transfer);
      return { ok: true };
    } catch (error) { await closeTransfer(input.transfer); throw error; }
  }
  async function fileAction(action, input) {
    if (action === "file-open") {
      if (transfers.size >= 8 || input.direction !== "extension" && !uuidPattern.test(input.id || "")) throw failure("invalid_input", "Недопустимый идентификатор передачи файла или слишком много одновременных передач");
      const transferID = token();
      if (input.direction === "extension") {
        if (!extensions || !Number.isSafeInteger(input.length) || input.length < -1 || input.length > 32 << 20) throw failure("extensions_unavailable", "Компонент расширений недоступен или ZIP-архив превышает 32 МБ");
        const stream = new PassThrough({ highWaterMark: chunkSize });
        const transfer = { direction: "extension", stream, length: input.length < 0 ? 32 << 20 : input.length, declared: input.length >= 0, received: 0, sequence: 0, used: Date.now() };
        transfer.result = extensions.upload(stream); transfer.result.catch(() => {});
        transfers.set(transferID, transfer); return { transfer: transferID };
      }
      if (input.direction === "upload") {
        if (!validWindowsBrowserFileName(input.name) || !Number.isSafeInteger(input.length) || input.length < -1 || input.length > fileLimit) throw failure("invalid_input", "Недопустимое имя или размер загружаемого файла");
        const request = uploads.request(input.id), tab = target({ id: request.tabId });
        const stream = new PassThrough({ highWaterMark: chunkSize });
        const transfer = { direction: "upload", id: input.id, request, document: tab.document, stream, length: input.length < 0 ? fileLimit : input.length, declared: input.length >= 0, received: 0, sequence: 0, used: Date.now() };
        transfer.result = uploads.receive(input.id, input.name, stream); transfer.result.catch(() => {});
        transfers.set(transferID, transfer); return { transfer: transferID };
      }
      if (input.direction === "download") {
        const copy = clipboardCopies.get(input.id);
        if (copy || input.context || input.document || input.tab) {
          if (!copy || input.tab !== copy.id || input.context !== copy.context || input.document !== copy.document) throw failure("copy_changed", "Источник копирования изменился; скопируйте заново");
          copyTarget(copy);
        }
        const source = copy ? copy.file : downloads.sourceFile(input.id), file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const info = await file.stat();
        if (!info.isFile()) { await file.close(); throw failure("download_unavailable", "Загруженный файл недоступен"); }
        if (copy) {
          try { copyTarget(copy); if (info.size !== copy.size) throw failure("copy_changed", "Скопированное содержимое изменилось"); }
          catch (error) { await file.close(); throw error; }
        }
        const name = copy ? "clipboard." + (copy.mime === "image/png" ? "png" : "txt") : downloads.snapshot().find(d => d.id === input.id).name;
        transfers.set(transferID, { direction: "download", id: input.id, copy, file, length: info.size, received: 0, sequence: 0, used: Date.now() });
        return { transfer: transferID, size: info.size, name, ...(copy ? { mime: copy.mime } : {}) };
      }
      throw failure("invalid_input", "Недопустимое направление передачи файла");
    }
    if (action === "file-close") { await closeTransfer(input.transfer); return { ok: true }; }
    let transfer;
    try {
      transfer = checkTransfer(input);
      if (action === "file-chunk" && ["upload", "extension"].includes(transfer.direction)) {
        if (typeof input.data !== "string" || input.data.length > Math.ceil(chunkSize / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw failure("invalid_input", "Недопустимый блок данных файла");
        const data = Buffer.from(input.data, "base64");
        if (!data.length || data.length > chunkSize || transfer.received + data.length > transfer.length) throw failure("invalid_input", "Блок данных файла превышает заявленный размер");
        await new Promise((resolve, reject) => transfer.stream.write(data, error => error ? reject(error) : resolve()));
        transfer.received += data.length; transfer.sequence++; return { ack: transfer.sequence };
      }
      if (action === "file-finish" && ["upload", "extension"].includes(transfer.direction)) {
        if (transfer.declared && transfer.received !== transfer.length) throw failure("invalid_input", "Файл получен не полностью");
        transfer.stream.end(); const result = await transfer.result; transfers.delete(input.transfer); return result;
      }
      if (action === "file-read" && transfer.direction === "download") {
        const data = Buffer.alloc(chunkSize), { bytesRead } = await transfer.file.read(data, 0, data.length, transfer.received);
        if (transfer.copy) checkTransfer(input);
        transfer.received += bytesRead; transfer.sequence++;
        const eof = transfer.received === transfer.length;
        if (!bytesRead && !eof) throw failure("download_unavailable", "Загруженный файл возвращён не полностью");
        const result = { data: data.subarray(0, bytesRead).toString("base64"), sequence: transfer.sequence, eof };
        if (eof) await closeTransfer(input.transfer); return result;
      }
      throw failure("invalid_input", "Недопустимая операция передачи файла");
    } catch (error) { await closeTransfer(input.transfer); throw error; }
  }
  async function remoteInput(input, signal) {
    let tab = tabs.get(active), xOffset = 0;
    const expected = split?.generation ?? tab?.geometry;
    if (!tab || tab.blocked || typeof input.target !== "string" || input.target !== expected) throw failure("target_changed", "Input target changed");
    if (signal && inputOwner && inputOwner !== signal && (rfbMask || heldKeys.size)) throw failure("target_changed", "Input target changed");
    if (signal) inputOwner = signal;
    if (rfbTarget !== input.target) { rfbMask = 0; heldKeys.clear(); rfbTarget = input.target; lastClick = undefined; rfbPane = undefined; }
    if (input.kind === "pointer" && split) {
      const leftWidth = tabs.get(split.left).page.viewportSize().width * displayScale;
      const id = rfbMask && rfbPane ? rfbPane : input.x < leftWidth ? split.left : split.right;
      tab = tabs.get(id); if (tab?.blocked) throw failure("project_grant_unavailable", "Авторизация проекта разорвана");
      xOffset = id === split.right ? leftWidth : 0;
      if ((input.mask & 7) && !rfbMask) { rfbPane = id; await activate(id); }
    }
    if (input.kind === "key") await tab.page.bringToFront();
    if (input.target !== (split?.generation ?? tab.geometry)) throw failure("target_changed", "Input target changed");
    if (input.kind === "pointer") {
      if (!Number.isInteger(input.mask) || input.mask < 0 || input.mask > 127 || ![input.x, input.y].every(Number.isFinite) || input.x < 0 || input.y < 0 || input.x >= viewport.width * displayScale || input.y >= viewport.height * displayScale) throw failure("invalid_input", "Недопустимое положение указателя");
      // Frames announce pixelWheel; a viewer may then send the scrolled
      // distance in pixels in place of one fixed step per event.
      const pixelWheel = input.deltaX !== undefined || input.deltaY !== undefined;
      if (pixelWheel && (![input.deltaX, input.deltaY].every(v => Number.isInteger(v) && Math.abs(v) <= 2048) || (input.mask & 7) || !(input.mask & 120))) throw failure("invalid_input", "Недопустимое расстояние прокрутки");
      const x = Math.max(0, Math.min(tab.page.viewportSize().width - 1, (input.x - xOffset) / displayScale)), y = input.y / displayScale, mask = input.mask & 7;
      const modifiers = Number.isInteger(input.modifiers) && input.modifiers >= 0 && input.modifiers <= 15 ? input.modifiers : 0;
      const buttons = ((mask & 1) ? 1 : 0) | ((mask & 2) ? 4 : 0) | ((mask & 4) ? 2 : 0);
      rfbPointer = { tab, document: tab.document, x, y, modifiers };
      for (const [bit, button] of [[1, "left"], [2, "middle"], [4, "right"]]) if ((mask & bit) !== (rfbMask & bit)) {
        const down = Boolean(mask & bit), now = Date.now();
        const count = down && lastClick?.button === button && now - lastClick.time < 400 && Math.abs(lastClick.x - x) < 4 && Math.abs(lastClick.y - y) < 4 ? Math.min(2, lastClick.count + 1) : 1;
        signal?.throwIfAborted();
        await cdp("Input.dispatchMouseEvent", { type: down ? "mousePressed" : "mouseReleased", x, y, button, buttons, modifiers, clickCount: down ? count : lastClick?.count || 1 }, tab.session);
        rfbMask = down ? rfbMask | bit : rfbMask & ~bit;
        if (down) lastClick = { button, x, y, count, time: now };
      }
      signal?.throwIfAborted();
      if (!pixelWheel) await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons, modifiers }, tab.session);
      const deltaY = pixelWheel ? input.deltaY : (input.mask & 8 ? -80 : 0) + (input.mask & 16 ? 80 : 0), deltaX = pixelWheel ? input.deltaX : (input.mask & 32 ? -80 : 0) + (input.mask & 64 ? 80 : 0);
      if (deltaX || deltaY) await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, buttons, modifiers }, tab.session);
      rfbMask = mask; if (!mask) rfbPane = undefined; return { ok: true, active };
    }
    if (input.kind === "key") {
      if (typeof input.down !== "boolean") throw failure("invalid_input", "Недопустимое состояние клавиши");
      const spec = rfbKey(input.keysym), repeat = heldKeys.has(input.keysym);
      if (!heldKeys.size) keyTarget = { tab, document: tab.document };
      if (input.down) heldKeys.set(input.keysym, spec); else heldKeys.delete(input.keysym);
      let modifiers = 0;
      for (const key of heldKeys.values()) modifiers |= ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 })[key.key] || 0;
      const text = input.down && spec.printable && !(modifiers & 6) ? spec.key : undefined;
      signal?.throwIfAborted();
      await cdp("Input.dispatchKeyEvent", { type: input.down ? "keyDown" : "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, modifiers, autoRepeat: repeat && input.down, ...(text ? { text, unmodifiedText: spec.key } : {}) }, tab.session);
      return { ok: true, active };
    }
    throw failure("invalid_input", "Недопустимая операция ввода браузера");
  }
  async function releaseInput(signal) {
    if (inputOwner !== signal) return;
    inputOwner = undefined;
    const target = keyTarget, keys = [...heldKeys.values()];
    heldKeys.clear(); keyTarget = undefined;
    await request({ operation: "input-release-pointer" }).catch(() => {});
    if (target && !target.tab.page.isClosed() && target.tab.document === target.document) {
      for (const key of keys) {
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode, modifiers: 0 }, target.tab.session).catch(() => {});
      }
    }
  }
  const tailnet = createTailnetClient();
  if (!options.testing) void tailnet.restore().catch(() => {});
  async function request({ method, path: route, input = {}, operation } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (method === "POST" && route === "/tailnet") return tailnet.request(input);
    if (operation === "configure") return configure(input);
    if (operation === "input-release-pointer") {
      const held = rfbPointer, mask = rfbMask;
      rfbMask = 0; rfbPane = undefined; rfbPointer = undefined;
      if (held && !held.tab.blocked && !held.tab.page.isClosed() && held.tab.document === held.document) {
        for (const [bit, button] of [[1, "left"], [2, "middle"], [4, "right"]]) if (mask & bit)
          await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: held.x, y: held.y, button, buttons: 0, modifiers: held.modifiers, clickCount: lastClick?.count || 1 }, held.tab.session);
      }
      return { ok: true };
    }
    if (operation === "input-reset") { rfbMask = 0; heldKeys.clear(); rfbPane = undefined; rfbPointer = undefined; pointer = undefined; return { ok: true }; }
    if (operation === "input-select-pane") {
      const tab = tabs.get(active);
      if (input.target !== (split?.generation ?? tab?.geometry) || !Number.isFinite(input.x) || input.x < 0 || input.x >= viewport.width * displayScale) throw failure("target_changed", "Input target changed");
      if (split) { const leftWidth = tabs.get(split.left).page.viewportSize().width * displayScale; await activate(input.x < leftWidth ? split.left : split.right); }
      return { ok: true };
    }
    if (operation === "editor-connect") {
      await initialize();
      if (!/^[a-f0-9]{16}$/.test(input.workspace || "") || !tokenPattern.test(input.connection || "") || typeof input.folder !== "string" || input.folder.length > 8192) throw failure("project_grant_unavailable", "Недопустимая авторизация проекта");
      const url = new URL(input.url);
      if (url.protocol !== "http:" || !editorHost(url.hostname) || !url.port || url.username || url.password || url.href.length > 8192 || url.hostname !== "127.0.0.1" && url.hostname !== input.workspace + ".cage-editor.localhost") throw failure("editor_unavailable", "Недопустимый локальный сеанс редактора");
      if (input.trust_default !== undefined && input.trust_default !== null && typeof input.trust_default !== "boolean") throw failure("editor_unavailable", "Недопустимая политика редактора по умолчанию");
      editorConnections.set(input.workspace, { id: input.connection, url: url.href, folder: input.folder, trustDefault: input.trust_default ?? undefined }); return { ok: true };
    }
    if (operation === "editor-revoke") {
      if (!input.connection || editorConnections.get(input.workspace)?.id === input.connection) editorConnections.delete(input.workspace);
      for (const tab of tabs.values()) if (tab.kind === "editor" && tab.workspace === input.workspace && (!input.connection || tab.editorConnection === input.connection)) { tab.blocked = true; tab.geometry = token(); uploads?.cancelTab(tab.id); }
      changed(); return { ok: true };
    }
    if (!["GET", "POST"].includes(method) || typeof route !== "string" || !/^\/[a-z-]+$/.test(route) || !input || typeof input !== "object" || Array.isArray(input)) throw failure("invalid_input", "Недопустимая операция браузера");
    if (method === "POST" && ["/paste-cancel", "/image-cancel", "/file-close"].includes(route)) {
      await closeTransfer(input.transfer);
      return { ok: true };
    }
    await initialize();
    signal?.throwIfAborted();
    const action = route.slice(1);
    if (method === "GET") {
      if (action === "frame-proof") return nativeFrameProof();
      if (action === "focus-proof") return nativeFocusProof();
      if (action === "health") return {
        ready: true, native: !options.testing, capabilities: (await snapshot()).capabilities,
        resources: { tabs: tabs.size, sessions: sessions.size, clipboard_sessions: clipboard.sessions.size, captures: captures.size },
        ...(!mac ? { capture: { ...captureMetrics } } : {}),
      };
      if (action === "tabs") return snapshot();
      if (action === "events") {
        const after = Number.isSafeInteger(input.after) && input.after >= 0 ? input.after : 0;
        if (input.onlyChanges && after === eventSequence && snapshotVersion === stateVersion && Date.now() - snapshotAt < 5000) {
          return { sequence: eventSequence, events: [] };
        }
        return { sequence: eventSequence, events: events.filter(e => e.sequence > after), state: await snapshot() };
      }
      if (action !== "frame") throw failure("invalid_input", "Недопустимая операция браузера");
    }
    if (action.startsWith("file-")) return fileAction(action, input);
    if (action.startsWith("image-")) return pasteAction(action.replace("image-", "paste-"), action === "image-start" ? { ...input, mime: "image/png" } : input, signal);
    if (action.startsWith("paste-")) return pasteAction(action, input, signal);
    if (action === "input") return remoteInput(input, signal);
    if (action === "split") return setSplit(input);
    if (action === "vault") {
      if (!vault) return { vaultError: "Компонент паролей браузера Windows ещё не установлен" };
      try { return await vault.request(input); } catch { return { vaultError: "Операция с паролем не завершена; разблокируйте заново и проверьте текущую страницу" }; }
    }
    if (action === "login-finish" || action === "login-open") {
      if (!/^[a-f0-9-]{16,64}$/.test(input.login || "")) throw failure("invalid_input", "Недопустимая задача входа");
      let url;
      if (action === "login-open") {
        url = new URL(input.url);
        if (url.protocol !== "https:" || url.username || url.password || !["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com", "platform.anthropic.com"].includes(url.hostname)) throw failure("invalid_input", "Можно открывать только официальные адреса входа");
      }
      const old = logins.get(input.login);
      if (old) { clearTimeout(old.expiry); logins.delete(input.login); privateContexts.delete(old.context); await old.context.close(); }
      if (action === "login-finish") return { ok: true };
      const context = await owner.newContext({ viewport, deviceScaleFactor: displayScale, ...(timezone ? { timezoneId: timezone } : {}), ...(language ? { locale: language } : {}), ...(networkMode === "proxy" ? { proxy: { server: proxy, bypass: proxyBypass } } : {}) });
      privateContexts.add(context);
      const entry = { context, expiry: setTimeout(() => { logins.delete(input.login); privateContexts.delete(context); void context.close().catch(() => {}); }, 15 * 60000) }; entry.expiry.unref(); logins.set(input.login, entry);
      context.on("page", page => { void addPage(page, { login: true }).then(tab => activate(tab.id)).catch(() => {}); });
      const page = await context.newPage(), tab = await addPage(page, { login: true });
      await page.goto(url.href, { waitUntil: "commit", timeout: 8000 }); await activate(tab.id); return { id: tab.id };
    }
    if (action === "audit") {
      if (options.audit) return options.audit(context, input);
      if (typeof input.timezone !== "string" || input.timezone.length > 128) throw failure("invalid_input", "Недопустимый часовой пояс диагностики");
      let expected;
      try { expected = new Intl.DateTimeFormat("en", { timeZone: input.timezone }).resolvedOptions().timeZone; } catch { throw failure("invalid_input", "Недопустимый часовой пояс диагностики"); }
      const isolated = await owner.newContext({ serviceWorkers: "block", ...(timezone ? { timezoneId: timezone } : {}), ...(language ? { locale: language } : {}), ...(networkMode === "proxy" ? { proxy: { server: proxy, bypass: proxyBypass } } : {}) });
      try {
        const auditPage = await isolated.newPage();
        const result = await auditPage.evaluate(() => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language, platform: navigator.platform }));
        result.expected_timezone = expected;
        if (input.network === true) {
          try {
            const response = await auditPage.goto("http://198.18.0.254/egress", { waitUntil: "domcontentloaded", timeout: 12000 });
            const status = response?.status() || 0;
            let ip;
            try { const json = JSON.parse(await response.text()); if (typeof json.ip === "string" && json.ip.length <= 128) ip = json.ip; } catch {}
            result.network = { status, ...(ip ? { ip } : {}) };
          } catch { result.network = { status: 0 }; }
        }
        return result;
      } finally { await isolated.close(); await tabs.get(active)?.page.bringToFront(); }
    }
    if (action === "new") {
      const url = checkedBrowserURL(input.url || home); let page;
      if (input.incognito) {
        const privateContext = await owner.newContext({ viewport, deviceScaleFactor: displayScale, acceptDownloads: true, ...(timezone ? { timezoneId: timezone } : {}), ...(language ? { locale: language } : {}), ...(networkMode === "proxy" ? { proxy: { server: proxy, bypass: proxyBypass } } : {}) });
        privateContexts.add(privateContext);
        privateContext.on("page", page => { void addPage(page, { incognito: true }).then(tab => activate(tab.id)).catch(() => {}); });
        page = await privateContext.newPage();
        const tab = await addPage(page, { incognito: true }); await activate(tab.id);
        if (url !== "about:blank") await page.goto(url, { waitUntil: "commit", timeout: 8000 });
        return { id: tab.id };
      }
      page = await context.newPage(); const tab = await addPage(page); await activate(tab.id);
      if (url !== "about:blank") await page.goto(url, { waitUntil: "commit", timeout: 8000 });
      remember(); return { id: tab.id };
    }
    if (action === "homepage") { home = checkedBrowserURL(input.url); return { ok: true }; }
    if (action === "resize") {
      if (![input.width, input.height].every(Number.isInteger) || input.width < 320 || input.height < 240 || input.width > 8192 || input.height > 8192 || input.width * input.height > 16000000) throw failure("invalid_input", "Invalid display size");
      viewport = { width: Math.ceil(input.width / displayScale), height: Math.ceil(input.height / displayScale) };
      await applyViewport();
      return { ok: true };
    }
    if (action === "editor" || action === "editor-restart") {
      if (!/^[a-f0-9]{16}(?:[a-f0-9]{8})?$/.test(input.workspace || "") || (!editorConnections.has(input.workspace) && typeof options.editor !== "function")) throw failure("editor_unavailable", "Редактор гостевой Windows или авторизация проекта ещё не подключены");
      const existing = [...tabs.values()].find(t => t.kind === "editor" && t.workspace === input.workspace);
      const current = editorConnections.get(input.workspace);
      if (existing && !existing.blocked && action === "editor" && (!current || existing.editorConnection === current.id)) { await activate(existing.id); return { id: existing.id }; }
      const connection = current ?? await options.editor(input.workspace, action === "editor-restart");
      const url = new URL(connection.url);
      if (url.protocol !== "http:" || !editorHost(url.hostname) || !url.port || url.username || url.password) throw failure("editor_unavailable", "Редактор гостевой системы не вернул допустимый локальный сеанс");
      const page = existing?.page ?? await context.newPage();
      if (connection.cookies) await context.addCookies(connection.cookies);
      const tab = existing ?? await addPage(page, { kind: "editor", workspace: input.workspace });
      // Retain each project's tab and server. Switching projects never reloads
      // or kills an existing editor, including its unsaved buffers.
      tab.kind = "editor"; tab.workspace = input.workspace; tab.visibleWorkspace = connection.folder ?? input.workspace; tab.editorConnection = current?.id; tab.blocked = false;
      if (!mac && typeof connection.trustDefault === "boolean" && !tab.editorDefaultsRoute) {
        await page.route(url => {
          const current = editorConnections.get(tab.workspace);
          return Boolean(current && url.pathname === "/" && url.origin === new URL(current.url).origin);
        }, async route => {
          const current = editorConnections.get(tab.workspace);
          if (!current || tab.blocked || current.id !== tab.editorConnection) { await route.abort(); return; }
          if (!route.request().isNavigationRequest() || route.request().frame() !== page.mainFrame()) { await route.continue(); return; }
          // Chromium's host-resolver rule is private to the browser; Node's
          // APIRequestContext does not resolve our per-project alias. Fetch
          // the already issued local connection URL without redirects and
          // preserve its Host authority for VS Code's web configuration.
          const issued = new URL(current.url), loopback = new URL(current.url);
          loopback.hostname = "127.0.0.1";
          const response = await route.fetch({ url: loopback.href, headers: { ...route.request().headers(), host: issued.host }, maxRedirects: 0 });
          if (response.status() !== 200 || typeof current.trustDefault !== "boolean") { await route.fulfill({ response }); return; }
          const body = await response.body();
          if (body.length > 1 << 20) { await route.abort(); return; }
          if (editorConnections.get(tab.workspace) !== current || tab.blocked || tab.editorConnection !== current.id) { await route.abort(); return; }
          await route.fulfill({ response, body: applyWindowsEditorHTMLDefault(body.toString("utf8"), current.trustDefault) });
        });
        tab.editorDefaultsRoute = true;
      }
      await page.goto(url.href, { waitUntil: "commit", timeout: 8000 }); await activate(tab.id); return { id: tab.id };
    }
    if (action === "upload-start") { const tab = target(input); return uploads.start(tab.id, tab.session, input); }
    if (action === "upload-finish") { const upload = uploads.request(input.id); target({ id: upload.tabId }); return uploads.finish(input.id); }
    if (action === "upload-cancel") { uploads.cancel(input.id); return { ok: true }; }
    if (action === "download-retry") return downloads.retry(input.id);
    if (action === "settings") {
      const mode = input.mode || "general";
      if (!["general", "appearance", "privacy", "extensions", "about"].includes(mode)) throw failure("invalid_input", "Недопустимая категория настроек");
      let tab = [...tabs.values()].find(t => t.kind === "browser-settings");
      if (!tab) tab = await addPage(await context.newPage(), { kind: "browser-settings" });
      tab.kind = "browser-settings"; tab.publicURL = "cage://settings#" + mode;
      await activate(tab.id); return { id: tab.id, kind: tab.kind, url: tab.publicURL, title: "Настройки" };
    }
    if (action === "internal-page") {
      const pages = { extensions: "chrome://extensions/", permissions: "chrome://settings/content", clear: "chrome://settings/clearBrowserData" };
      let url = pages[input.mode]; if (!url || input.id && !/^[a-p]{32}$/.test(input.id)) throw failure("invalid_input", "Недопустимая внутренняя страница");
      if (input.mode === "extensions" && input.id) url += "?id=" + input.id;
      const tab = await addPage(await context.newPage()); await tab.page.goto(url, { waitUntil: "commit", timeout: 7000 }); await activate(tab.id); return { id: tab.id, url, kind: "web", title: "Настройки браузера" };
    }
    if (action === "extensions") {
      if (!extensions) throw failure("extensions_unavailable", "Компонент управления расширениями Windows не готов; проверьте версию браузера и установленные компоненты");
      const result = await extensions.request(input);
      if (input.mode === "options" && result.url) {
        if (!result.url.startsWith(`chrome-extension://${input.id}/`)) throw failure("invalid_input", "Недопустимый адрес настроек расширения");
        const tab = await addPage(await context.newPage()); await tab.page.goto(result.url, { waitUntil: "commit", timeout: 7000 }); await activate(tab.id); return { id: tab.id, url: result.url, kind: "web", title: "Параметры расширения" };
      }
      return result;
    }
    if (action === "info") return browserCDP.send("Browser.getVersion");
    if (action === "cookies") {
      const tab = target(input, false);
      if (typeof cookieActions !== "function") throw failure("action_unavailable", "Компонент Cookie Windows установлен не полностью");
      return cookieActions(cdp, async id => tabs.get(id)?.session, { targetId: tab.id, url: tab.page.url(), browserContextId: tab.browserContextId, incognito: tab.incognito, login: tab.login }, input);
    }
    if (action === "ime") return ime(input);
    if (action === "frame") await syncNativeFrontTab();
    const tab = target(input, !["activate", "close", "navigate", "reload", "back", "forward"].includes(action), action === "close"), page = tab.page;
    if (action === "frame") {
      if (split) {
        const pair = split, generation = pair.generation, panes = []; let x = 0, bytes = 0;
        const captured = await Promise.all([pair.left, pair.right].map(id => captureFrame(target({ id }, false))));
        const sequence = generation + captured.map(frame => frame.sequence).join("");
        if (input.after === sequence) return { unchanged: true, sequence, ...(input.nativeProof ? { native: await nativeFrameProof() } : {}) };
        let index = 0;
        for (const id of [pair.left, pair.right]) {
          const pane = target({ id }, false), document = pane.document;
          const jpeg = captured[index++].jpeg;
          bytes += Buffer.byteLength(jpeg, "base64");
          if (split !== pair || pair.generation !== generation || pane.document !== document) throw failure("target_changed", "Input target changed");
          const size = pane.page.viewportSize(), width = Math.round(size.width * displayScale), height = Math.round(size.height * displayScale);
          panes.push({ jpeg, x, y: 0, width, height, id, document }); x += width;
        }
        if (bytes > 8 << 20) throw failure("frame_limit", "Изображение браузера слишком велико; уменьшите окно и повторите попытку");
        return { sequence, target: generation, width: x, height: Math.round(viewport.height * displayScale), scale: displayScale, panes, active, pixelWheel: true, native: await nativeFrameProof() };
      }
      const geometry = tab.geometry, document = tab.document;
      const captured = await captureFrame(tab);
      const sequence = geometry + document + captured.sequence;
      if (tab.id !== active || tab.geometry !== geometry || tab.document !== document) throw failure("target_changed", "Input target changed");
      if (input.after === sequence) return { unchanged: true, sequence, ...(input.nativeProof ? { native: await nativeFrameProof() } : {}) };
      if (Buffer.byteLength(captured.jpeg, "base64") > 8 << 20) throw failure("frame_limit", "Изображение браузера слишком велико; уменьшите окно и повторите попытку");
      return { ...(mac ? {url: page.url(), title: await page.title()} : {}), sequence, id: tab.id, document, jpeg: captured.jpeg, target: geometry, width: Math.round(viewport.width * displayScale), height: Math.round(viewport.height * displayScale), cssWidth: viewport.width, cssHeight: viewport.height, scale: displayScale, pixelWheel: true, native: await nativeFrameProof() };
    }
    if (action === "activate") return activate(tab.id);
    if (action === "close") { await page.close(); if (!tabs.size) await addPage(await context.newPage()); if (active) await activate(active); return { ok: true }; }
    if (action === "navigate") { await page.goto(checkedBrowserURL(input.url), { waitUntil: "commit", timeout: 8000 }); remember(); return { ok: true }; }
    if (action === "reload") { await page.reload({ waitUntil: "commit", timeout: 8000 }); return { ok: true }; }
    if (action === "back") { await page.goBack({ waitUntil: "commit", timeout: 8000 }); return { ok: true }; }
    if (action === "forward") { await page.goForward({ waitUntil: "commit", timeout: 8000 }); return { ok: true }; }
    if (action === "copy-context") {
      if (!tokenPattern.test(input.context || "")) throw failure("invalid_input", "Copy target changed");
      if (tab.copyContext !== input.context) { invalidateCopies(); tab.explicitCopyContext = undefined; }
      tab.copyContext = input.context; await clipboard.setContext(tab.id, input.context); return { ok: true };
    }
    if (mac && (action === "copy" || action === "cut")) return copyAction(tab, input, action, signal);
    if (action === "insert-text") {
      if (typeof input.text !== "string" || !input.text || Buffer.byteLength(input.text) > 8192) throw failure("invalid_input", "Input target or text is invalid");
      await page.bringToFront(); signal?.throwIfAborted(); await page.keyboard.insertText(input.text); return { ok: true };
    }
    if (["paste", "copy", "cut", "select-all"].includes(action)) {
      await page.bringToFront(); signal?.throwIfAborted(); await page.keyboard.press((mac ? "Meta+" : "Control+") + ({ paste: "V", copy: "C", cut: "X", "select-all": "A" })[action]);
      return { ok: true };
    }
    if (action === "key") {
      if (!(keys.has(input.key) || /^[a-z0-9]$/i.test(input.key))) throw failure("invalid_input", "Эта клавиша не поддерживается");
      await page.bringToFront();
      await page.keyboard.press([input.ctrl && "Control", input.meta && "Meta", input.alt && "Alt", input.shift && "Shift", input.key].filter(Boolean).join("+"));
      return { ok: true };
    }
    if (["click", "pointer", "wheel"].includes(action)) {
      const p = point(input, page.viewportSize()), scale = tab.inputScale ?? 1; await page.bringToFront(); await page.mouse.move(p.x * scale, p.y * scale);
      if (action === "click") await page.mouse.click(p.x * scale, p.y * scale, { clickCount: input.double ? 2 : 1 });
      if (action === "wheel") {
        if (![input.dx, input.dy].every(v => Number.isFinite(v) && Math.abs(v) <= 2000)) throw failure("invalid_input", "Недопустимое положение прокрутки");
        await page.mouse.wheel(input.dx, input.dy);
      }
      if (action === "pointer") {
        if (input.mode === "down") { pointer = { id: tab.id, document: tab.document }; await page.mouse.down(); }
        else if (["move", "up"].includes(input.mode)) {
          if (!pointer || pointer.id !== tab.id || pointer.document !== tab.document) throw failure("target_changed", "Input target changed");
          if (input.mode === "up") { await page.mouse.up(); pointer = undefined; }
        } else throw failure("invalid_input", "Недопустимая операция указателя");
      }
      return { ok: true };
    }
    throw failure("action_unavailable", "Браузер гостевой Windows пока не поддерживает эту операцию");
  }
  async function close() {
    if (closing) return closing;
    remember();
    closing = (async () => {
      invalidateCopies();
      for (const id of transfers.keys()) await closeTransfer(id);
      await copying;
      for (const privateContext of privateContexts) await privateContext.close().catch(() => {});
      for (const login of logins.values()) clearTimeout(login.expiry);
      await persistQueue.catch(() => {}); await context?.close().catch(() => {});
    })(); return closing;
  }
  const expiry = setInterval(() => {
    for (const [id, t] of transfers) if (Date.now() - t.used > 120000) void closeTransfer(id);
    for (const [id, copy] of clipboardCopies) if (Date.now() - copy.created > 120000) {
      clipboardCopies.delete(id); void rm(copy.file, { force: true }).catch(() => {});
    }
  }, 10000);
  expiry.unref();
  return { request: async (...args) => {
    activeRequests++;
    try {
      await Promise.all(stoppingCaptures.values());
      for (const tab of tabs.values()) await restoreCaptureMetrics(tab);
      return await request(...args);
    }
    finally { activeRequests--; }
  }, releaseInput, close: async () => { tailnet.close(); clearInterval(expiry); await close(); } };
}

export async function* lines(input, limit = lineLimit) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      if (end > limit) throw failure("message_limit", "Запрос браузера слишком велик");
      yield buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1);
    }
    if (buffer.length > limit) throw failure("message_limit", "Запрос браузера слишком велик");
  }
  if (buffer.length) throw failure("message_invalid", "Запрос браузера получен не полностью");
}
export const createWindowsBrowserService = createNativeBrowserService;

export async function runWindowsBrowser(input = process.stdin, output = process.stdout, options) {
  const service = createWindowsBrowserService(options);
  try {
    for await (const line of lines(input)) {
      let result;
      try { result = await service.request(JSON.parse(line)); }
      catch (error) { result = { error: error.safe ? error.message : "Операция браузера гостевой Windows не завершена; восстановите соединение и проверьте результат", code: error.safe ? error.code : "browser_operation_failed" }; }
      await new Promise((resolve, reject) => output.write(JSON.stringify(result) + "\n", error => error ? reject(error) : resolve()));
    }
  } finally { await service.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.once("SIGTERM", () => process.exit(0));
  await runWindowsBrowser().catch(() => { process.exitCode = 1; });
}
