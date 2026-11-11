import React, { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { ArrowDownLeft, ArrowLeft, ArrowRight, BookOpen, Check, CornerDownLeft, Delete, Globe2, Keyboard, LoaderCircle, Maximize, Monitor, RotateCw, ZoomIn, X } from "lucide-react";
import { PhoneFavorites } from "./phone-favorites";
import { connectDisplay, framePoint } from "./browser-session.mjs";
import "./remote-browser.css";

function Tool({icon: Icon, label, ...props}) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}>
    <Icon size={19} aria-hidden="true" />
  </button>;
}

function AddressBar({frame, goToAddress, onNotice}) {
  const [address, setAddress] = useState(null);
  const [invalid, setInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const current = frame?.url === "about:blank" ? "" : frame?.url || "";
  const navigate = async event => {
    event.preventDefault();
    if (submission.current) return;
    const field = event.currentTarget.elements[0];
    const raw = field.value.trim();
    let url;
    try {
      if (!raw) throw new Error();
      url = new URL(raw.includes("://") ? raw : "https://" + raw);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.href.length > 16384) throw new Error();
    } catch {
      setInvalid(true); onNotice("Введите корректный адрес HTTP или HTTPS.");
      return;
    }
    submission.current = true; setSubmitting(true); onNotice("");
    try {
      if (await goToAddress(url.href) && field.value.trim() === raw) {
        field.blur();
        setAddress(null);
      }
    } catch (error) {
      onNotice(error.message);
    } finally {
      submission.current = false; setSubmitting(false);
    }
  };
  return <form className="remote-address" onSubmit={navigate}>
        <Globe2 size={16} aria-hidden="true" />
        <input aria-label="Адрес удалённой страницы" aria-invalid={invalid} inputMode="url" enterKeyHint="go" autoCapitalize="none"
          autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="Введите адрес" disabled={!frame}
          value={address ?? current} onFocus={event => event.target.select()}
          onChange={event => {setAddress(event.target.value); setInvalid(false); onNotice("");}}
          onKeyDown={event => {if (event.key === "Escape") {setAddress(null); setInvalid(false); onNotice(""); event.target.blur();}}} />
        <button type="submit" aria-label="Перейти по адресу" aria-busy={submitting} disabled={!frame || submitting}>{submitting ? <LoaderCircle className="spin" size={17} /> : <ArrowDownLeft size={17} />}</button>
      </form>;
}

function RemoteKeyboard({frame, busy, send, onClose}) {
  const [draft, setDraft] = useState("");
  const insert = async event => {
    event.preventDefault();
    if (!draft || !frame.focus || busy || new TextEncoder().encode(draft).length > 8192) return;
    if (await send({type: "text", focus: frame.focus, text: draft}, frame)) setDraft("");
  };
  const tooLong = new TextEncoder().encode(draft).length > 8192;
  return <form className="remote-keyboard" onSubmit={insert}>
    <input autoFocus type={frame.password ? "password" : "text"} aria-label="Текст для вставки" placeholder={frame.password ? "Введите пароль" : "Ввести текст"}
      autoComplete="off" autoCapitalize="none" spellCheck={false} autoCorrect="off" enterKeyHint="done"
      maxLength={8192} value={draft} onChange={e => setDraft(e.target.value)}
      onKeyDown={e => {if (e.key === "Enter" && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) e.preventDefault();}} />
    <button type="submit" className="icon-button" aria-label="Вставить текст" title="Вставить текст" disabled={busy || !draft || tooLong}><Check size={19} /></button>
    <Tool label="Удалить предыдущий символ" icon={Delete} disabled={busy || !!draft} onClick={() => send({type: "key", key: "Backspace", focus: frame.focus}, frame)} />
    <Tool label="Отправить Enter" icon={CornerDownLeft} disabled={busy || !!draft} onClick={() => send({type: "key", key: "Enter", focus: frame.focus}, frame)} />
    <Tool label="Свернуть поле ввода" icon={X} onClick={onClose} />
    {tooLong && <p role="alert" className="remote-note">За один раз можно ввести не более 8192 байт. Вводите частями.</p>}
  </form>;
}

// Login windows accept one printable ASCII key at a time. No form draft,
// clipboard, text insertion or implicit Enter is used for these fields.
function LoginKeyboard({frame, busy, session, onClose}) {
  const keys = useRef([]);
  const sending = useRef(false);
  const [sequence, wake] = useState(0);
  const [notice, setNotice] = useState("");
  useEffect(() => () => { keys.current.length = 0; }, []);
  useEffect(() => {
    if (busy || sending.current || !keys.current.length || !session?.canSend(frame, frame.focus)) return;
    const key = keys.current.shift();
    sending.current = true;
    void session.send({type:"key", key, focus:frame.focus}, frame).then(ok => {
      if (!ok) {
        keys.current.length = 0;
        setNotice("Фокус ввода или соединение изменились. Проверьте поле удалённого ввода.");
      }
      sending.current = false;
      if (keys.current.length) wake(value => value + 1);
    });
  }, [frame, busy, session, sequence]);
  const press = key => {
    if (keys.current.length >= 32) {setNotice("Подождите, предыдущие клавиши ещё отправляются."); return;}
    keys.current.push(key); setNotice(""); wake(value => value + 1);
  };
  return <div className="remote-keyboard">
    <input type="password" autoFocus aria-label="Поочерёдный ввод при входе" placeholder="Вводите по одному символу: латиница или знаки"
      autoComplete="off" autoCapitalize="none" spellCheck={false} autoCorrect="off" enterKeyHint="done"
      onPaste={e => e.preventDefault()} onDrop={e => e.preventDefault()}
      onInput={e => {
        const value = e.currentTarget.value;
        e.currentTarget.value = "";
        if (e.nativeEvent.inputType === "deleteContentBackward") {press("Backspace"); return;}
        if (!e.nativeEvent.isComposing && /^[ -~]$/.test(value)) press(value);
        else if (value) setNotice("Клавиатура входа принимает латинские буквы, цифры и знаки по одному.");
      }}
      onKeyDown={e => {
        if (["Backspace","Tab","Enter"].includes(e.key) && !e.nativeEvent.isComposing) {
          e.preventDefault(); press(e.key);
        }
      }} />
    <Tool label="Удалить предыдущий символ" icon={Delete} onClick={() => press("Backspace")} />
    <Tool label="Отправить Enter" icon={CornerDownLeft} onClick={() => press("Enter")} />
    <Tool label="Свернуть поле ввода" icon={X} onClick={onClose} />
    {notice && <p className="remote-note" role="alert">{notice}</p>}
  </div>;
}

function remoteHost(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

export function RemoteDisplay({visible, onBack, onReopen, id, tool, start, initialURL, controls, addressSlot}) {
  const desktop = tool === "desktop";
  const name = desktop ? "Claude Desktop" : tool === "claude" ? "Claude.ai" : "Удалённый браузер";
  const [reading, setReading] = useState(false);
  const [showAddress, setShowAddress] = useState(tool === "browser");
  const [addressNotice, setAddressNotice] = useState("");
  const [favorites, setFavorites] = useState(false);
  const surface = useRef(null);
  const stage = useRef(null);
  const gesture = useRef(null);
  const [state, setState] = useState({});
  const [keyboard, setKeyboard] = useState("");
  const preview = location.protocol === "cage-preview:";
  const frame = visible ? state.frame : null;
  // The guest identifies each editable element within its document. The
  // separate frame token changes on resize and protects input coordinates.
  const login = desktop && frame?.window === "login";
  const focus = desktop && frame?.password && !login ? "" : frame?.focus || "";
  const typing = !!focus && keyboard === focus;
  const hostname = tool === "claude" && frame ? remoteHost(frame.url) : "";
  useEffect(() => {
    if (reading && stage.current) stage.current.scrollLeft = (stage.current.scrollWidth - stage.current.clientWidth) / 2;
  }, [reading]);
  useEffect(() => {
    if (preview) return;
    const session = connectDisplay(stage.current, next => {
      if (!next.frame) {gesture.current = null; setKeyboard(""); setFavorites(false);}
      setState(next);
    }, id, start, tool, initialURL);
    controls.current = session;
    const visibility = () => {
      gesture.current = null; setKeyboard("");
      session.visibility(!document.hidden);
    };
    const pageHide = () => {gesture.current = null; setKeyboard(""); session.visibility(false);};
    document.addEventListener("visibilitychange", visibility);
    const offline = () => {gesture.current = null; session.offline();};
    window.addEventListener("offline", offline);
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", visibility);
    visibility();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", offline);
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", visibility);
      session.close();
      controls.current = null;
    };
  }, [id, start, tool, initialURL, preview, controls]);

  const send = (payload, expected) => controls.current?.send(payload, expected);
  const point = event => framePoint(surface.current.getBoundingClientRect(), frame, event.clientX, event.clientY);
  const down = event => {
    if (favorites || !frame || (desktop && state.busy) || !event.isPrimary || event.button !== 0) return;
    const location = point(event);
    if (!location) return;
    if (!desktop) controls.current.cancelScroll();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {pointer: event.pointerId, location, frame, x:event.clientX, y:event.clientY,
      lastX:0, lastY:0, dragged:false, left:stage.current.scrollLeft, top:stage.current.scrollTop};
  };
  const drag = (start, event) => {
    const dx = start.x - event.clientX, dy = start.y - event.clientY;
    if (!start.dragged && Math.hypot(dx, dy) < 6) return;
    start.dragged = true;
    if (reading) {
      stage.current.scrollLeft = start.left + dx;
      stage.current.scrollTop = start.top + dy;
    } else if (!desktop) {
      const {x, y, scale} = start.location;
      const totalX = Math.round(dx / scale), totalY = Math.round(dy / scale);
      controls.current.scroll(start.frame, {x, y, dx:totalX - start.lastX, dy:totalY - start.lastY});
      start.lastX = totalX; start.lastY = totalY;
    }
  };
  const move = event => {
    const start = gesture.current;
    if (start?.pointer === event.pointerId) drag(start, event);
  };
  const up = event => {
    const start = gesture.current;
    if (start?.pointer !== event.pointerId) return;
    gesture.current = null;
    drag(start, event);
    const {x, y, scale} = start.location;
    if (!start.dragged) void send({type:"tap", x, y}, start.frame);
    else if (desktop && !reading) {
      const delta = value => Math.max(-3200, Math.min(3200, Math.round(value / scale)));
      void send({type:"scroll", x, y, dx:delta(start.x - event.clientX), dy:delta(start.y - event.clientY)}, start.frame);
    }
  };
  const wheel = event => {
    if (favorites || !frame || (desktop && state.busy)) return;
    if (reading) {
      stage.current.scrollBy(event.deltaX, event.deltaY); return;
    }
    const location = point(event);
    if (!location) return;
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1;
    const delta = value => Math.max(-3200, Math.min(3200, Math.round(value * units / location.scale)));
    const input = {x:location.x, y:location.y, dx:delta(event.deltaX), dy:delta(event.deltaY)};
    if (desktop) void send({type:"scroll", ...input}, frame);
    else controls.current.scroll(frame, input);
  };
  return <section className="remote-browser" aria-label={name}>
    {!desktop && addressSlot && frame && (showAddress
      ? createPortal(<AddressBar frame={frame} goToAddress={async url => {const opened = await controls.current.navigate(url); if (opened) setFavorites(false); return opened;}} onNotice={setAddressNotice} />, addressSlot)
      : hostname && hostname !== "claude.ai" && createPortal(<span className="remote-domain" title={hostname}><Globe2 size={14} />{hostname}</span>, addressSlot))}
    {frame && state.homeNotice && <p className="remote-home-note" role="status">{state.homeNotice}</p>}
    {frame && showAddress && addressNotice && <p className="remote-note" role="alert">{addressNotice}</p>}
    <div ref={stage} className="remote-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={() => {gesture.current = null; controls.current?.cancelScroll();}} onWheel={wheel} onContextMenu={e => {if (!favorites) e.preventDefault();}}>
      {frame && favorites ? <PhoneFavorites frame={frame} navigate={url => controls.current.navigate(url)} onClose={() => setFavorites(false)}/> :
       frame ? <div className={reading ? "display-surface reading" : "display-surface"} ref={surface}>
        <img className="remote-screen" alt={desktop ? "Изображение удалённого Desktop" : "Изображение удалённого браузера"} src={frame.image} draggable={false} />
      </div> :
        <div className="remote-empty" role={state.error ? "alert" : "status"}>
          {preview ? <><Globe2 aria-hidden="true" /><p>Подключитесь к настоящему компьютеру, чтобы использовать {name}.</p></> :
            state.error ? <><p>{state.error}</p>
              {state.uncertain && <p className="note">Результат ввода ещё не подтверждён. Сначала посмотрите последнее изображение.</p>}
              <button className="action secondary" onClick={() => {
                setKeyboard(""); setState({});
                if (state.reopen) onReopen();
                else controls.current.refresh();
              }}>{state.reopen ? "Открыть заново" : "Прочитать изображение заново"}</button></> :
              <><LoaderCircle className="spin" aria-hidden="true" /><p>{state.waiting ? `Запуск удалённого ${desktop ? "Claude Desktop" : "браузера"}…` : "Чтение удалённого изображения…"}</p></>}
        </div>}
    </div>
    {typing ? (login
      ? <LoginKeyboard key={focus} frame={frame} busy={state.busy} session={controls.current} onClose={() => setKeyboard("")} />
      : <RemoteKeyboard key={focus} frame={frame} busy={state.busy} send={send} onClose={() => setKeyboard("")} />) :
    <nav className="remote-tools" aria-label={desktop ? "Удалённые действия рабочего стола" : "Удалённые действия со страницей"}>
      {desktop ? <>
        <Tool label="Отключить удалённый рабочий стол" icon={X} onClick={onBack} />
        <button type="button" className="action" disabled={!frame} aria-pressed={reading} onClick={() => setReading(!reading)}>
          {reading ? <Maximize size={17} /> : <ZoomIn size={17} />}{reading ? "Во всю ширину" : "Увеличить для чтения"}
        </button>
        {!frame?.shared && frame?.login_supported !== false && <button type="button" className="action" disabled={!frame || state.busy}
          onClick={() => send({type:login ? "desktop" : "login"}, frame)}>
          {login ? <Monitor size={17} /> : <Globe2 size={17} />}{login ? "Вернуться в Desktop" : "Окно входа"}
        </button>}
      </> : <>
        <Tool label="Закрыть удалённый браузер" icon={X} onClick={onBack} />
        <Tool label="Назад" icon={ArrowLeft} disabled={!frame || state.busy || favorites} onClick={() => send({type:"back"}, frame)} />
        <Tool label="Вперёд" icon={ArrowRight} disabled={!frame || state.busy || favorites} onClick={() => send({type:"forward"}, frame)} />
        {tool === "claude" && <Tool label="Адрес страницы" aria-pressed={showAddress} icon={Globe2} disabled={!frame} onClick={() => {setAddressNotice(""); setShowAddress(!showAddress);}} />}
        {tool === "browser" && <Tool label="Закладки" icon={BookOpen} disabled={!frame} aria-expanded={favorites}
          onClick={() => {gesture.current = null; controls.current.cancelScroll(); setFavorites(!favorites);}} />}
        <Tool label="Перезагрузить страницу" icon={RotateCw} disabled={!frame || state.busy || favorites} onClick={() => send({type:"reload"}, frame)} />
      </>}
      <Tool label="Ввести текст" icon={Keyboard} disabled={!focus || state.busy || favorites}
        onClick={() => flushSync(() => setKeyboard(focus))} />
    </nav>}
    {desktop && frame?.login_supported === false && <p className="remote-home-note" role="status">Если требуется вход, выполните его в Claude Desktop через Cage на компьютере — телефон продолжит использовать тот же сеанс.</p>}
  </section>;
}
