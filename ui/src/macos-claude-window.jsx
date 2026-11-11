import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { DesktopToolbar, useDesktopZoom } from "./claude-desktop";
import { MacOSLogin } from "./macos-login";
import { api, native, nativeAvailable } from "./api";
import { BrowserUploads } from "./browser-uploads";
import { sendFiles } from "./file-transfer";
import { prepareClipboardPaste, sendImage } from "./image-transfer";
import { installRemoteInput } from "./remote-input";
import { createMacWindowInput } from "./macos-window-input.mjs";
import { copyGuestText } from "./shared-clipboard.mjs";
import { useWindowVisibility } from "./window-visibility";
import { createMacWindowConnection } from "./macos-window-connection.mjs";
import { createMacFrameConnection } from "./macos-frame-connection.mjs";
import "./macos-claude-window.css";

const messages = {
  requires_gui_login: "Сначала войдите и разблокируйте графический аккаунт виртуального Mac.",
  screen_recording_permission: "Разрешите Cage Guest Window запись экрана в системных разрешениях виртуального Mac.",
  accessibility_permission: "Чтобы управлять окнами, разрешите Cage Guest Window использовать универсальный доступ в виртуальном Mac.",
  not_running: "Откройте Claude Desktop в виртуальном Mac.",
  no_visible_window: "Claude ещё не показывает окно. Откройте приложение заново.",
  identity_error: "Приложение в виртуальном Mac не прошло проверку подписи Anthropic.",
  window_changed: "Активное окно Claude изменилось. Откройте приложение и повторите на новом экране.",
  unknown_action: "Компоненту ввода гостевого окна требуется обновление. Обновите компонент в настройках среды и повторите.",
  input_connection_required: "Вводу в окно требуется переподключение. Восстановите изображение и повторите.",
  input_owned_by_another_view: "Другое соединение управляет этим окном. Дождитесь, пока оно отпустит клавиши или завершит перетаскивание.",
};

async function windowRequest(action, fields = {}, connection) {
  const result = connection ? await connection.request(action, fields) : await api("/macos/claude/window", { action, ...fields });
  if (result.error) {
    const error = new Error(messages[result.error] || "Не удалось прочитать или изменить окно приложения в виртуальном Mac.");
    error.code = result.error;
    throw error;
  }
  return result;
}

// Fixed-size native sign-in sheets stay at their real text size. Extend a
// uniform window background across the pane without scaling those pixels.
function matchWindowBackground(img, pane, canvasRef) {
  if (!pane) return;
  if (img.clientWidth >= pane.clientWidth - 1 && img.clientHeight >= pane.clientHeight - 1) return;
  if (!canvasRef.current) {
    canvasRef.current = document.createElement("canvas");
    canvasRef.current.width = 4;
    canvasRef.current.height = 1;
  }
  const canvas = canvasRef.current;
  const ctx = canvas.getContext("2d", {willReadFrequently:true});
  if (!ctx) return;
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w < 16 || h < 16) return;
  [[8,8],[w-9,8],[8,h-9],[w-9,h-9]].forEach(([x,y],i) =>
    ctx.drawImage(img,x,y,1,1,i,0,1,1));
  const pixels = ctx.getImageData(0,0,4,1).data;
  const uniform = pixels.every((value, index) => Math.abs(value - pixels[index % 4]) <= 4);
  pane.style.backgroundColor = uniform && pixels[3] === 255 ? `rgb(${pixels[0]}, ${pixels[1]}, ${pixels[2]})` : "";
}

export function MacOSClaudeWindow({ visible, keyboard = "mac", remoteRef, sidebarCollapsed, onExpand, onConfirm, uploads = [], onStatus = () => {}, onFallback = () => {} }) {
  const windowVisible = useWindowVisibility();
  const screenVisible = visible && windowVisible;
  const connection = useRef(null);
  const [inputChannel, setInputChannel] = useState(null);
  const frameConnection = useRef(null);
  const request = (action, fields) => windowRequest(action, fields, connection.current);
  const [zoom, setZoom] = useDesktopZoom();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [revision, refresh] = useState(0);
  const [image, setImage] = useState(null);
  const frame = useRef(null);
  const surface = useRef(null);
  const controls = useRef(null);
  const current = useRef(null);
  current.current = { screenVisible, keyboard, input: state?.input, onStatus, onFallback };
  const pane = useRef(null);
  const backgroundSample = useRef(null);
  const viewport = useRef(null);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!visible || !element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      viewport.current = width > 0 && height > 0 ? {
        width: Math.min(2560, Math.max(320, Math.round(width / zoom))),
        height: Math.min(1600, Math.max(240, Math.round(height / zoom))),
      } : null;
      frameConnection.current?.resize(viewport.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); viewport.current = null; };
  }, [visible, zoom]);
  const picker = useRef(null);
  const pickerTarget = useRef(null);
  const generation = useRef(0);
  const launched = useRef(false);

  useEffect(() => {
    if (!screenVisible) return;
    const epoch = ++generation.current;
    let timer;
    let current, nextStatus = 0, after = "", captureSize = "", checkFrame = true;
    const live = () => generation.current === epoch;
    function receiveFrame(next) {
      if (!live()) return;
      if (frame.current?.window !== next.window || frame.current?.pid !== next.pid || frame.current?.geometry !== next.geometry) frame.current = null;
      setImage({
        src: next.src || `data:${next.mime === "image/jpeg" ? "image/jpeg" : "image/png"};base64,${next.image}`,
        window: next.window, pid: next.pid,
        geometry: next.geometry, width: next.contentWidth, height: next.contentHeight,
        acknowledge: next.acknowledge,
      });
      setError("");
    }
    async function poll() {
      let delay = 2200;
      try {
        if (!current || Date.now() >= nextStatus) {
          current = await request("status");
          checkFrame = true;
          nextStatus = Date.now() + 2200;
          if (live() && current.persistent && !connection.current) {
            connection.current = createMacWindowConnection();
            setInputChannel(connection.current);
          }
        }
        if (!live()) return;
        setState(current);
        // Opening this tab focuses the signed guest application. A background
        // Electron window can still be captured but cannot receive targeted input.
        if (current.installed && !launched.current) {
          launched.current = true;
          await request("launch");
          nextStatus = 0;
          delay = 100;
          return;
        }
        if (current.running && current.screen) {
          if (current.push_frames && viewport.current) {
            if (!frameConnection.current) {
              frameConnection.current = createMacFrameConnection(receiveFrame, reason => {
                if (!live()) return;
                frameConnection.current = null;
                nextStatus = 0;
                frame.current = null;
                setImage(null);
                setError(messages[reason] || "Не удалось получить изображение окна виртуального Mac. Переподключитесь.");
              });
            }
            frameConnection.current.resize(viewport.current);
            return;
          }
          const nextSize = JSON.stringify(viewport.current);
          if (nextSize !== captureSize) { after = ""; captureSize = nextSize; }
          const next = await request("frame", viewport.current ? {
            after, refresh: checkFrame,
            ...viewport.current, scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
          } : {});
          if (!live()) return;
          checkFrame = false;
          delay = current.persistent ? 50 : 350;
          if (next.unchanged) return;
          after = next.sequence || "";
          receiveFrame(next);
        } else { frameConnection.current?.close(); frameConnection.current = null; frame.current = null; setImage(null); }
        setError("");
      } catch (e) {
        if (!live()) return;
        connection.current?.close(); connection.current = null;
        setInputChannel(null);
        frameConnection.current?.close(); frameConnection.current = null;
        current = null; after = "";
        if (live()) { frame.current = null; setImage(null); setError(e.message); }
      } finally { if (live()) timer = setTimeout(poll, delay); }
    }
    poll();
    return () => {
      generation.current++; clearTimeout(timer); frame.current = null;
      connection.current?.close(); connection.current = null;
      setInputChannel(null);
      frameConnection.current?.close(); frameConnection.current = null;
    };
  }, [screenVisible, revision]);

  async function action(name) {
    try { if (name === "stop") launched.current = true; await request(name); setError(""); refresh((n) => n + 1); }
    catch (e) { setError(e.message); }
  }
  useImperativeHandle(remoteRef, () => ({
    focus: () => controls.current?.transport.focus(),
    edit: command => controls.current?.input.focused() ? controls.current.input.edit(command) : false,
    copy: () => controls.current?.input.copy(),
    paste: () => controls.current?.input.readAndPaste(),
    pasteText: text => controls.current?.input.paste(text),
    transfer: () => onFallback("", "Здесь можно использовать локальные копирование и вставку."),
  }));

  useEffect(() => {
    if (!screenVisible || !state?.input || !surface.current || !pane.current || (state.persistent && !inputChannel)) return;
    const inputRequest = (action, fields) => windowRequest(action, fields, inputChannel);
    const transport = createMacWindowInput({
      element: surface.current,
      frame: () => frame.current,
      active: () => Boolean(current.current.screenVisible && current.current.input && frame.current),
      request: inputRequest,
      onError: setError,
    });
    const preparePaste = () => {
      const lease = { target: transport.target(), epoch: generation.current, transport };
      return Object.assign(prepareClipboardPaste("desktop", "", { windowTarget: lease.target, valid: () => transport.valid(lease.target) }), { lease });
    };
    const input = installRemoteInput(transport, pane.current, {
      mode: () => current.current.keyboard,
      guestPlatform: () => "darwin",
      systemClipboard: () => true,
      copyText: (sendCopy, valid) => copyGuestText({ request: value => api("/clipboard/copy", value), sendCopy, valid }),
      surface: () => surface.current,
      inputLabel: "Ввод в Claude Desktop",
      tabId: () => frame.current ? `${frame.current.pid}:${frame.current.window}:${frame.current.geometry}` : "",
      isActive: () => Boolean(current.current.screenVisible && current.current.input && frame.current),
      onStatus: text => current.current.onStatus(text),
      onFallback: (...values) => current.current.onFallback(...values),
      insertText: text => transport.send("text", { text }),
      caretRect: session => inputRequest("ime", { ...frame.current, mode: "status", session }).catch(error => {
        if (error.code === "unknown_action") setError(error.message);
        return { available: false };
      }),
      insertComposition: (_, value) => transport.send("ime", value).then(result => {
        if (value.mode !== "cancel" && !result.available) throw new Error("Позиция ввода изменилась. Введите заново.");
        return result;
      }),
      preparePaste,
      pasteContent: (content, prepared) => receive(content, prepared?.lease || { target: transport.target(), epoch: generation.current, transport }, prepared),
    });
    controls.current = { transport, input };
    return () => {
      input.dispose(); transport.dispose();
      if (controls.current?.transport === transport) controls.current = null;
    };
  }, [screenVisible, state?.input, state?.persistent, inputChannel, image?.geometry, image?.pid, image?.window]);

  function receive(content, lease, prepared) {
    const target = lease?.target || frame.current;
    const epoch = lease?.epoch ?? generation.current;
    const transport = lease?.transport || controls.current?.transport;
    const valid = () => target && epoch === generation.current && transport?.valid(target);
    const ready = Promise.resolve(content).then(value => ({ value }), error => ({ error }));
    if (!transport) { prepared?.dispose(); return Promise.reject(new Error("Окно ещё не подключено. Повторите позже.")); }
    return transport.run(async () => {
      const { value, error } = await ready;
      if (error) throw error;
      if (!valid()) throw new Error("Окно Claude переключилось. Вернитесь в исходное окно и передайте вложение заново.");
      setFileError(""); setTransferring(true);
      if (value.files || value.fileSelection) {
        await sendFiles(value, "desktop", "", { valid, windowTarget: target, onProgress: (loaded, total) => onStatus(total ? `Передача вложения · ${Math.floor(loaded * 100 / total)}%` : "Передача вложения…") });
      } else if (value.png) {
        await sendImage(value, "desktop", "", { prepared });
      } else if (value.text) {
        await request("text", { ...target, text: value.text });
      }
      if (valid()) onStatus(value.text ? "Вставлено" : "Вложение передано Claude Desktop. Подтвердите результат загрузки в приложении.");
    }).finally(() => { prepared?.dispose(); setTransferring(false); });
  }
  const fileFailure = error => { setFileError(error.message); onStatus(error.message); };
  async function chooseFiles() {
    const lease = { target: frame.current, epoch: generation.current, transport: controls.current?.transport };
    if (!nativeAvailable()) { pickerTarget.current = lease; picker.current?.click(); return; }
    try {
      const selected = await native("chooseUploadFiles", { multiple: true });
      if (!selected.canceled) await receive({ fileSelection: selected.fileSelection, kind: "paste" }, lease);
    } catch (error) { fileFailure(error); }
  }
  if (!visible) return null;
  return <section className="claude-desktop-view mac-claude" aria-label="Claude Desktop в виртуальном Mac">
    <BrowserUploads requests={uploads} onStatus={onStatus} />
    <DesktopToolbar desktop={state} platform="macOS" zoom={zoom} setZoom={setZoom} onConfirm={onConfirm}
      onStop={() => action("stop")} refresh={() => refresh(n => n+1)} sidebarCollapsed={sidebarCollapsed} onExpand={onExpand}>
      <MacOSLogin />
      <button disabled={!state?.input || !image || transferring} onClick={() => void chooseFiles()}>Добавить вложение</button>
      <input ref={picker} type="file" multiple hidden aria-label="Выбрать вложение для Claude" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void receive({ files, kind: "paste" }, pickerTarget.current || undefined).catch(fileFailure); }} />
      {(!state?.running || error) && <button onClick={() => action("launch")} disabled={!state?.installed}>{state?.running ? "Переподключить приложение" : "Открыть приложение"}</button>}
      {state?.installed && !state.screen && <button onClick={() => action("request-screen")}>Разрешить запись экрана</button>}
      {state?.installed && !state.input && <button onClick={() => action("request-input")}>Разрешить ввод с клавиатуры и мыши</button>}
    </DesktopToolbar>
    {error && <p role="alert">{error}</p>}
    {fileError && <p role="alert">{fileError}</p>}
    {state && !state.installed && <p>В этом виртуальном Mac не установлен официальный Claude Desktop.</p>}
    {state?.running && !state.screen && <p>{messages.screen_recording_permission}</p>}
    {state?.running && state.screen && !state.input && <p>{messages.accessibility_permission}</p>}
    <div ref={pane} className="mac-claude-frame" style={{ "--desktop-zoom": zoom }}>
      {image && <img ref={surface} key={image.geometry || `${image.pid}-${image.window}`} alt="Окно гостевой системы Claude Desktop" src={image.src} draggable={false}
        onLoad={e => {
          const img = e.currentTarget;
          const width = image.width || img.naturalWidth;
          const height = image.height || img.naturalHeight;
          img.style.setProperty("--frame-width", width + "px");
          img.style.setProperty("--frame-aspect", width / height);
          frame.current = { window: image.window, pid: image.pid, geometry: image.geometry };
          matchWindowBackground(img, pane.current, backgroundSample);
          image.acknowledge?.();
        }}
        onError={() => { frameConnection.current?.close(); frameConnection.current = null; frame.current = null; setImage(null); setError("Не удалось декодировать изображение окна. Переподключитесь."); }}
        />}
    </div>
  </section>;
}
