import React, { useEffect, useRef, useState } from "react";
import { KeyRound, Plus, Search, ShieldCheck } from "lucide-react";
import { api, writeClipboard } from "./api";
import "./password-vault.css";

const emptyBrowser = { available: false, entries: [], candidates: [] };
export function usePasswordVault(ready, tab) {
  const [state, setState] = useState(emptyBrowser);
  const refresh = useRef(null), mutation = useRef(0);
  useEffect(() => {
    let cancelled = false, timer, running = false;
    setState(emptyBrowser);
    const poll = async () => {
      if (running || cancelled || !ready) return;
      running = true;
      const revision = mutation.current;
      clearTimeout(timer);
      try {
        const value = await api("/vault/browser", { action: "status", tab });
        if (!cancelled && revision === mutation.current) setState({ ...emptyBrowser, ...value, tab });
      } catch (error) {
        if (!cancelled) setState({ ...emptyBrowser, message: error.message });
      } finally {
        running = false;
        if (!cancelled && ready) timer = setTimeout(poll, 2000);
      }
    };
    refresh.current = poll;
    void poll();
    return () => { cancelled = true; clearTimeout(timer); refresh.current = null; };
  }, [ready, tab]);
  const act = async input => {
    await api("/vault/browser", input);
    mutation.current++;
    if (input.candidate) setState(previous => ({ ...previous, candidates: previous.candidates.filter(value => value.id !== input.candidate) }));
    await refresh.current?.();
  };
  return { state, act };
}

export function BrowserVaultBar({ tab, vault, onManage, ready, menu = false }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const { state, act } = vault;
  const entries = state.tab === tab.id ? state.entries : [];
  const candidate = state.candidates.find(value => value.tab === tab.id);
  useEffect(() => { setOpen(false); setMessage(""); }, [tab.id, tab.url]);
  const run = async (input, success) => {
    setBusy(true); setMessage("");
    try { await act(input); setMessage(success); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  return <div className="vault-browser" onKeyDown={event => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); event.currentTarget.querySelector("button").focus(); }
  }}>
    <div className="vault-browser-heading">
      <button className={menu ? "browser-menu-item" : "text-button"} role={menu ? "menuitem" : undefined}
        aria-expanded={open} onClick={() => setOpen(!open)}>
        <KeyRound size={16} /><span>Пароли{entries.length ? ` · аккаунтов: ${entries.length}` : ""}</span>
      </button>
      {message && <span role="status">{message}</span>}
    </div>
    {candidate && <div className="vault-save" role="region" aria-label="Сохранить пароль сайта">
      <div><strong>{candidate.update ? "Обновить пароль этого аккаунта?" : "Сохранить пароль этого аккаунта?"}</strong>
        <span>{candidate.origin} · {candidate.username || "Имя пользователя не указано"}</span>
        <small>Сохраняйте после успешного входа на сайт.</small></div>
      <div className="vault-actions">
        <button className="primary" disabled={busy} onClick={() => run({ action: "save", candidate: candidate.id }, "Пароль сохранён")}>{candidate.update ? "Обновить пароль" : "Сохранить пароль"}</button>
        <button disabled={busy} onClick={() => run({ action: "dismiss", candidate: candidate.id }, "")}>Не сохранять</button>
        <button className="text-button" disabled={busy} onClick={() => run({ action: "never", candidate: candidate.id }, "Для этого сайта сохранение больше не предлагается")}>Не предлагать для этого сайта</button>
      </div>
    </div>}
    {open && <div className="vault-picker" role="region" aria-label="Пароли текущего сайта">
      <p>{state.origin && state.tab === tab.id ? state.origin : "Выберите аккаунт на странице входа сайта HTTPS"}</p>
      {!ready ? <p>После запуска среды можно подставлять пароли сайтов.</p> : !state.available ? <p>{state.message || "Подключение к функции паролей браузера…"}</p> :
        entries.length ? entries.map(entry => <button className="vault-account-choice" key={entry.id} disabled={busy}
          onClick={() => run({ action: "fill", tab: tab.id, id: entry.id, document: state.document }, "Заполнено; отправьте вход на странице")}>
          <span>{entry.username || "Имя пользователя не указано"}</span><span>Заполнить аккаунт и пароль</span>
        </button>) : <p>Для этого сайта пароли ещё не сохранены.</p>}
      <button className="text-button" onClick={onManage}>Управление хранилищем паролей</button>
    </div>}
  </div>;
}

const newEntry = () => ({ origin: "", username: "", password: "" });
export function PasswordVaultSettings({ onConfirm, onDirty }) {
  const [store, setStore] = useState({ entries: [], blocked: [] });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(""), [draft, setDraft] = useState(null);
  const [verify, setVerify] = useState(null), [accountPassword, setAccountPassword] = useState("");
  const [revealed, setRevealed] = useState(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const alive = useRef(true);
  const refresh = async () => {
    const data = await api("/vault");
    if (alive.current) setStore(data);
  };
  useEffect(() => {
    alive.current = true;
    refresh().catch(error => { if (alive.current) setError(error.message); }).finally(() => { if (alive.current) setLoading(false); });
    const clear = () => { setRevealed(null); setAccountPassword(""); };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => { alive.current = false; window.removeEventListener("blur", clear); document.removeEventListener("visibilitychange", clear); };
  }, []);
  useEffect(() => { onDirty(Boolean(draft)); return () => onDirty(false); }, [draft, onDirty]);
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(null), 30000);
    return () => clearTimeout(timer);
  }, [revealed]);
  const run = async (input, success) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api("/vault", input);
      if (!alive.current) return;
      if (input.action === "reveal") {
        if (verify.mode === "copy") { await writeClipboard(result.password); setMessage("Пароль скопирован в буфер обмена этого компьютера"); }
        else setRevealed({ id: input.id, password: result.password });
        setVerify(null);
      } else { setDraft(null); setRevealed(null); await refresh(); setMessage(success); }
    } catch (error) { if (alive.current) setError(error.message); }
    finally { if (alive.current) { setBusy(false); setAccountPassword(""); } }
  };
  const askReveal = (entry, mode) => { setRevealed(null); setAccountPassword(""); setVerify({ entry, mode }); setError(""); };
  const entries = store.entries.filter(entry => `${entry.origin} ${entry.username}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="vault-settings">
    <div className="section-title"><h3>Хранилище паролей</h3><p>Пароли аккаунтов хранятся на этом устройстве в зашифрованном виде и разблокируются вместе с Cage.</p></div>
    <div className="vault-note"><ShieldCheck size={17} /><span>Для просмотра или копирования пароля требуется повторно подтвердить пароль аккаунта Cage. После заполнения вход отправляете вы.</span></div>
    {error && <p className="account-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <div className="vault-toolbar"><label className="vault-search"><span><Search size={14} />Поиск сайта или аккаунта</span>
      <input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <button disabled={busy || Boolean(draft) || loading || Boolean(error && !store.entries.length)} onClick={() => { setDraft(newEntry()); setVerify(null); setRevealed(null); }}><Plus size={15} />Добавить пароль</button></div>
    {draft && <form className="vault-editor" onSubmit={event => { event.preventDefault(); void run({ action: "save", entry: draft }, "Запись пароля сохранена"); }}>
      <h4>{draft.id ? "Изменить пароль" : "Добавить пароль"}</h4>
      <fieldset disabled={busy}>
        <label>Адрес сайта<input type="url" required autoFocus placeholder="https://mail.example.com" value={draft.origin} onChange={event => setDraft({ ...draft, origin: event.target.value })} /></label>
        <label>Аккаунт или эл. почта<input autoComplete="off" maxLength={1024} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })} /></label>
        <label>{draft.id ? "Новый пароль (оставьте пустым, чтобы сохранить прежний)" : "Пароль сайта"}<input type="password" autoComplete="new-password" required={!draft.id} maxLength={8192} value={draft.password || ""} onChange={event => setDraft({ ...draft, password: event.target.value })} /></label>
        <div className="vault-actions"><button className="primary" type="submit">Сохранить запись</button><button type="button" onClick={() => setDraft(null)}>Отмена</button></div>
      </fieldset>
    </form>}
    {verify && <form className="vault-editor" onSubmit={event => { event.preventDefault(); void run({ action: "reveal", id: verify.entry.id, account_password: accountPassword }); }}>
      <h4>{verify.mode === "copy" ? "Скопировать пароль после подтверждения" : "Показать пароль после подтверждения"}</h4><p>{verify.entry.origin} · {verify.entry.username}</p>
      <label>Пароль аккаунта Cage<input type="password" autoComplete="off" autoFocus required maxLength={1024} value={accountPassword} onChange={event => setAccountPassword(event.target.value)} /></label>
      <div className="vault-actions"><button className="primary" disabled={busy} type="submit">Подтвердить и {verify.mode === "copy" ? "скопировать" : "показать"}</button>
        <button type="button" disabled={busy} onClick={() => { setVerify(null); setAccountPassword(""); }}>Отменить подтверждение</button></div>
    </form>}
    {loading ? <p>Чтение хранилища паролей…</p> : !entries.length ? <div className="vault-empty"><KeyRound size={24} /><p>{search ? "Подходящие аккаунты не найдены" : "Пароли ещё не сохранены"}</p><small>После входа на сайт можно подтвердить сохранение или добавить пароль вручную.</small></div> :
      <div className="vault-list">{entries.map(entry => <article className="vault-entry" key={entry.id}>
        <div><strong>{entry.origin}</strong><span>{entry.username || "Имя пользователя не указано"}</span></div>
        {revealed?.id === entry.id && <div className="vault-revealed"><output aria-label="Сохранённый пароль сайта">{revealed.password}</output><button onClick={() => setRevealed(null)}>Скрыть пароль</button></div>}
        <div className="vault-actions">
          <button disabled={busy || Boolean(draft)} onClick={() => askReveal(entry, "view")}>Показать пароль</button>
          <button disabled={busy || Boolean(draft)} onClick={() => askReveal(entry, "copy")}>Скопировать пароль</button>
          <button disabled={busy || Boolean(draft)} onClick={() => { setDraft({ ...entry, password: "" }); setVerify(null); setRevealed(null); }}>Изменить</button>
          <button disabled={busy || Boolean(draft)} onClick={async () => { if (await onConfirm({ title: "Удалить этот пароль?", body: `${entry.origin} · ${entry.username || "Имя пользователя не указано"}. После удаления восстановить его нельзя.`, confirm: "Удалить пароль" })) await run({ action: "delete", id: entry.id }, "Запись пароля удалена"); }}>Удалить</button>
        </div>
      </article>)}</div>}
    {store.blocked.length > 0 && <section className="vault-blocked"><h4>Сайты без предложения сохранения</h4>{store.blocked.map(origin => <div key={origin}><span>{origin}</span><button disabled={busy} onClick={() => run({ action: "unblock", origin }, "Предложение сохранения для этого сайта восстановлено")}>Восстановить предложение</button></div>)}</section>}
    <p className="footnote">Сейчас поддерживаются распространённые формы входа на страницах HTTPS верхнего уровня. Пароли не синхронизируются на другие устройства; при резервном копировании сохраняйте и локальные файлы аккаунта, и хранилище паролей.</p>
  </section>;
}
