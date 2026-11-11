import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, KeyRound, LoaderCircle, Monitor, Network, RefreshCw, Search, Smartphone, Terminal, Trash2 } from "lucide-react";
import { api, writeClipboard } from "./api";
import { Modal } from "./modal";
import "./tailscale.css";

const labels = { Running: "Подключено", NeedsLogin: "Ожидание входа", NeedsMachineAuth: "Ожидание одобрения администратора", Starting: "Подключение", Stopped: "Отключено", NotInstalled: "Не установлен" };
const descriptions = {
  Stopped: "Войдите в Tailscale, чтобы добавить Cage в вашу частную сеть. Другие устройства, подключённые к той же сети, появятся здесь.",
  NeedsLogin: "Завершите вход и авторизуйте это устройство на официальной странице Tailscale, затем вернитесь сюда.",
  NeedsMachineAuth: "Вход выполнен. Попросите администратора этой сети одобрить устройство Cage в консоли управления Tailscale.",
  Starting: "Подключение к Tailscale; список устройств обновится после успешного подключения.",
};
const deviceName = peer => peer.hostname || peer.name?.split(".")[0] || peer.ip;
function DeviceIcon({ os }) { return ["android", "iOS"].includes(os) ? <Smartphone size={20} /> : <Monitor size={20} />; }

export function TailscalePanel({ status, onClose, onOpenBrowser, onInstall, onConfirm }) {
  const [state, setState] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [key, setKey] = useState(""), [notice, setNotice] = useState(""), [query, setQuery] = useState("");
  const [sshOpen, setSSHOpen] = useState(false), [selected, setSelected] = useState(""), [username, setUsername] = useState("");
  const [port, setPort] = useState("80"), [appsOpen, setAppsOpen] = useState(false);
  const mounted = useRef(true), inflight = useRef(false), loginRequested = useRef(false), revision = useRef(0);
  const ready = status.ready && !status.job?.running;
  const connected = ready && state?.backend === "Running";
  const address = state?.ips?.find(ip => !ip.includes(":"));
  const peers = [...(state?.peers || [])].sort((a, b) => Number(b.online) - Number(a.online) || deviceName(a).localeCompare(deviceName(b)));
  const visible = peers.filter(peer => [deviceName(peer), peer.name, peer.ip, peer.os].some(value => value?.toLowerCase().includes(query.trim().toLowerCase())));
  const openLogin = async url => {
    loginRequested.current = false;
    try { if (await onOpenBrowser(url) === false && mounted.current) setError("Не удалось открыть страницу входа. Нажмите «Открыть страницу входа» и повторите попытку."); }
    catch { if (mounted.current) setError("Не удалось открыть страницу входа. Нажмите «Открыть страницу входа» и повторите попытку."); }
  };
  const refresh = async () => {
    if (inflight.current || !ready) return;
    inflight.current = true;
    const current = ++revision.current;
    try {
      const value = await api("/tailscale");
      if (mounted.current && current === revision.current) {
        setState(value); setError("");
        if (loginRequested.current && value.auth_url) await openLogin(value.auth_url);
        if (value.backend === "Running") loginRequested.current = false;
      }
      return value;
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { inflight.current = false; }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { mounted.current = false; revision.current++; clearInterval(timer); };
  }, [ready]);
  const act = async (action, body = {}) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); revision.current++;
    try {
      inflight.current = true;
      const value = await api(`/tailscale/${action}`, body);
      if (mounted.current) { setState(value); if (action === "add-key") setKey(""); }
      return value;
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { inflight.current = false; if (mounted.current) setBusy(false); }
  };
  const login = async () => {
    loginRequested.current = true;
    const result = await act(state?.enabled ? "login" : "connect");
    if (result?.auth_url) await openLogin(result.auth_url);
    else if (!result || result.backend === "Running") loginRequested.current = false;
  };
  const copy = async (text, message = "Скопировано") => {
    try { await writeClipboard(text); setNotice(message); }
    catch { setNotice("Не удалось скопировать. Выделите текст и скопируйте вручную."); }
  };
  const stop = async logout => {
    if (!await onConfirm({ title: logout ? "Выйти из Tailscale?" : "Отключить Tailscale?", body: logout ? "Подключение к частной сети прервётся; для следующего подключения потребуется снова войти. Добавленные открытые ключи SSH сохранятся." : "Используемые подключения к частной сети прервутся; состояние входа и открытые ключи SSH сохранятся.", confirm: logout ? "Выйти" : "Отключить" })) return;
    loginRequested.current = false;
    if (await act(logout ? "logout" : "disconnect")) { setSelected(""); setSSHOpen(false); }
  };
  return <Modal title="Tailscale" onClose={onClose} wide>
    <div className="modal-body tailscale-panel">
      <div className={`tailscale-overview${connected ? " connected" : ""}`}>
        <div className="tailscale-state" role="status">
          <div className="tailscale-network-icon"><Network size={24} /></div>
          <div><strong>{!ready ? "Ожидание готовности среды Cage" : labels[state?.backend] || (state ? "Состояние подключения не подтверждено" : "Чтение состояния…")}</strong>
            <span>{connected ? (state.tailnet || "Частная сеть Tailscale") : "Ваши устройства в одной сети"}</span>
          </div>
          <button className="icon-button" aria-label="Обновить состояние Tailscale" disabled={!ready || busy} onClick={refresh}><RefreshCw size={16} /></button>
        </div>
        <p className="field-help">{!ready ? "После запуска среды Cage можно войти и подключиться к частной сети." : connected ? "Cage подключён к частной сети. Выберите устройство, чтобы увидеть адрес и использовать его службы." : descriptions[state?.backend] || "Чтение состояния Tailscale текущей среды."}</p>
        {state?.account && connected && <p className="tailscale-account">Аккаунт · {state.account}</p>}
        {ready && state && <div className="tailscale-actions">
          {!state.installed ? <button className="primary-button" disabled={busy} onClick={async () => {
            setBusy(true); setError("");
            try { await onInstall(); } catch (e) { setError(e.message); }
            finally { if (mounted.current) setBusy(false); }
          }}>{["macos", "windows-11"].includes(status.guest_system) ? "Обновите компоненты среды, чтобы установить" : "Установить Tailscale"}</button> : <>
            {!connected && !["NeedsMachineAuth", "Starting"].includes(state.backend) && <button className="primary-button" disabled={busy} onClick={login}>{busy ? <LoaderCircle size={15} className="spin" /> : <ExternalLink size={15} />}{state.enabled ? "Начать вход заново" : "Подключиться и войти"}</button>}
            {state.auth_url && !connected && <button className="quiet-button" disabled={busy} onClick={() => openLogin(state.auth_url)}>Открыть страницу входа</button>}
            {state.enabled && <button className="quiet-button" disabled={busy} onClick={() => stop(false)}>Отключить</button>}
            {connected && <button className="quiet-button" disabled={busy} onClick={() => stop(true)}>Выйти</button>}
          </>}
        </div>}
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {connected && state.health?.length > 0 && <div className="tailscale-health" role="status"><strong>Сеть требует внимания</strong>{state.health.map((message, i) => <p key={i}>{message}</p>)}</div>}
      {connected && <section className="tailscale-self" aria-label="Текущее устройство Cage">
        <DeviceIcon os={state.os} />
        <div><strong>{state.hostname || state.name?.split(".")[0] || "Cage"} <span className="tailscale-badge">Текущая среда</span></strong><span className="tailscale-address">{address || "Назначение адреса…"}{state.os ? ` · ${state.os}` : ""}</span></div>
        {address && <button className="quiet-button" onClick={() => copy(address, "Адрес Cage в частной сети скопирован")}><Copy size={14} />Скопировать адрес</button>}
      </section>}
      <section className="tailscale-section tailscale-devices" aria-labelledby="tailscale-devices-title">
        <div className="tailscale-section-heading"><h3 id="tailscale-devices-title">Устройства в сети{connected && <span>{peers.length}</span>}</h3>{connected && peers.length > 0 && <span className="field-help">{peers.filter(peer => peer.online).length} онлайн</span>}</div>
        {connected && peers.length > 0 && <label className="tailscale-search"><Search size={16} /><input aria-label="Поиск устройств" type="search" placeholder="Поиск по имени или адресу устройства" value={query} onChange={e => setQuery(e.target.value)} /></label>}
        {!connected ? <div className="tailscale-empty"><Monitor size={26} /><strong>Устройства появятся после подключения</strong><p>Завершите вход в браузере; список устройств появится автоматически.</p></div>
          : peers.length === 0 ? <div className="tailscale-empty"><Monitor size={26} /><strong>Частная сеть подключена, но других устройств пока нет</strong><p>Установите Tailscale на компьютер или телефон и подключитесь к той же сети. Здесь показываются только устройства, которые эта сеть разрешает обнаруживать Cage.</p></div>
          : visible.length === 0 ? <p className="tailscale-empty">Нет подходящих устройств. Попробуйте другое имя или адрес.</p>
          : <div className="tailscale-peers">{visible.map(peer => <article className="tailscale-peer" key={peer.id || peer.ip}>
            <div className="tailscale-peer-row"><DeviceIcon os={peer.os} /><div className="tailscale-peer-info"><strong>{deviceName(peer)}</strong><span>{peer.ip}{peer.os ? ` · ${peer.os}` : ""}</span></div>
              <span className={`tailscale-presence${peer.online ? " online" : ""}`}><i />{peer.online ? "в сети" : "не в сети"}</span>
              <button className="icon-button" aria-label={`Скопировать адрес ${deviceName(peer)}`} onClick={() => copy(peer.ip, "Адрес устройства в частной сети скопирован")}><Copy size={15} /></button>
              <button className="quiet-button" aria-expanded={selected === peer.ip} aria-controls={`tailnet-device-${peer.ip}`} onClick={() => { setSelected(selected === peer.ip ? "" : peer.ip); setUsername(""); setPort("80"); }}>Использовать устройство<ChevronDown size={14} /></button>
            </div>
            {selected === peer.ip && <div className="tailscale-device-detail" id={`tailnet-device-${peer.ip}`}>
              {peer.name && <p className="field-help tailscale-dns">{peer.name}</p>}
              {!peer.online && <p className="field-help">Устройство сейчас не в сети. Сначала подключите Tailscale на этом устройстве.</p>}
              <label className="field-label" htmlFor="tailnet-service-port">Доступ к службам устройства</label>
              <p className="field-help">Укажите порт службы, чтобы создать локальный адрес подключения для браузера, клиента базы данных или другого приложения в Cage.</p>
              <div className="tailscale-connect-form"><input id="tailnet-service-port" aria-label="Порт службы" type="number" min="1" max="65535" inputMode="numeric" value={port} onChange={e => setPort(e.target.value)} /><button className="quiet-button" disabled={busy || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535} onClick={async () => { if (await act("open-service", { host: peer.ip, port: Number(port) })) setNotice("Локальный адрес подключения готов; используйте его внутри среды Cage."); }}>Создать адрес подключения</button></div>
              {(state.forwards || []).filter(entry => entry.host === peer.ip).map(entry => <div className="tailscale-forward" key={`${entry.host}:${entry.port}`}><span><strong>Порт {entry.port}</strong><code>{entry.address}</code></span><button className="icon-button" aria-label={`Скопировать адрес подключения порта ${entry.port}`} onClick={() => copy(entry.address, "Адрес подключения, доступный в Cage, скопирован")}><Copy size={14} /></button><button className="quiet-button" onClick={async () => { try { if (await onOpenBrowser(`http://${entry.address}`) === false) setError("Не удалось открыть страницу службы. Повторите попытку."); } catch { setError("Не удалось открыть страницу службы. Повторите попытку."); } }}>Открыть HTTP-страницу</button></div>)}
              <label className="field-label" htmlFor="tailnet-ssh-user"><Terminal size={14} />Подключение SSH</label>
              <p className="field-help">Укажите системное имя пользователя этого устройства. На целевом устройстве должен быть включён SSH и разрешён вход текущему аккаунту.</p>
              <div className="tailscale-connect-form"><input id="tailnet-ssh-user" value={username} onChange={e => setUsername(e.target.value)} placeholder="Системное имя пользователя устройства" autoComplete="off" maxLength={128} /><button className="quiet-button" disabled={!username.trim() || !/^[a-zA-Z0-9_.@\\-]+$/.test(username.trim())} onClick={() => copy(`ssh -l '${username.trim()}' ${peer.ip}`, "Команда SSH скопирована; выполните её в терминале Cage")}>Скопировать команду SSH</button></div>
              <p className="field-help">SSH, SFTP и инструменты с поддержкой OpenSSH могут использовать указанный адрес частной сети. Для остальных приложений см. «Доступ приложений к частной сети» ниже.</p>
            </div>}
          </article>)}</div>}
      </section>
      {connected && <section className="tailscale-section">
        <button className="tailscale-disclosure" aria-expanded={sshOpen} aria-controls="tailnet-inbound-ssh" onClick={() => setSSHOpen(!sshOpen)}><span><KeyRound size={16} />SSH с других устройств в Cage</span><ChevronDown size={16} /></button>
        {sshOpen && <div id="tailnet-inbound-ssh" className="tailscale-detail">
          <p className="field-help">Настраивайте только если нужны удалённый терминал, SFTP или подключение редактора. Добавьте сюда открытый ключ SSH подключающегося устройства; закрытый ключ остаётся на нём.</p>
          {address && <div className="tailscale-command"><code>{`ssh ${state.user}@${address}`}</code><button className="icon-button" aria-label="Скопировать команду подключения к Cage" onClick={() => copy(`ssh ${state.user}@${address}`)}><Copy size={15} /></button></div>}
          <label className="field-label" htmlFor="tailscale-key">Открытый ключ SSH подключающегося устройства</label>
          <textarea id="tailscale-key" rows={3} placeholder="ssh-ed25519 AAAA…" value={key} onChange={e => setKey(e.target.value)} maxLength={8192} spellCheck={false} />
          <button className="quiet-button" disabled={busy || !key.trim()} onClick={() => act("add-key", { key: key.trim() })}>Добавить открытый ключ</button>
          <div className="tailscale-keys">{(state.keys || []).map(entry => <div className="tailscale-key" key={entry}><code title={entry}>{entry}</code><button className="icon-button" disabled={busy} aria-label="Удалить открытый ключ SSH" onClick={() => act("remove-key", { key: entry })}><Trash2 size={14} /></button></div>)}</div>
        </div>}
      </section>}
      {connected && state.proxy_url && <section className="tailscale-section">
        <button className="tailscale-disclosure" aria-expanded={appsOpen} aria-controls="tailnet-apps" onClick={() => setAppsOpen(!appsOpen)}><span><Network size={16} />Доступ приложений к частной сети</span><ChevronDown size={16} /></button>
        {appsOpen && <div id="tailnet-apps" className="tailscale-detail"><p className="field-help">Если приложению в Cage нужны доменные имена устройств, HTTPS или несколько портов, настройте HTTP-прокси в приложении. Разрешён доступ только к видимым устройствам этой частной сети; для публичного интернета используется прежний выход.</p><button className="quiet-button" onClick={() => copy(state.proxy_url, "Адрес HTTP-прокси частной сети скопирован (с локальными учётными данными)")}>Скопировать адрес прокси частной сети</button><p className="field-help">Адрес прокси содержит локальные учётные данные; используйте его только в приложениях внутри Cage. Поддерживаются TCP-службы; UDP, системный VPN и маршрутизация подсетей не включены.</p></div>}
      </section>}
      <p className="field-help tailscale-footer">На других устройствах нужно установить Tailscale и подключиться к той же сети. Доступ устройств контролируется правами сети; приостановка доступа Cage к сети или остановка среды прерывает подключение к частной сети.</p>
      {notice && <p className="tailscale-notice" role="status"><Check size={14} />{notice}</p>}
    </div>
  </Modal>;
}
