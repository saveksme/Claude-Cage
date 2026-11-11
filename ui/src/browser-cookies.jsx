import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api";
import { InlineSelect } from "./inline-select";

export function BrowserCookies({ tab, onClose }) {
  const [scope, setScope] = useState(/^https?:/.test(tab.url) ? "site" : "all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState(null);
  const [value, setValue] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const generation = useRef(0), search = useRef(null), operation = useRef(false);
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => {
    const version = ++generation.current;
    setLoading(true); setData(null); setValue(null); setError(""); setConfirmClear(false);
    api("/browser/cookies", { id: tab.id, url: tab.url, mode: "list", scope, query, page })
      .then(result => { if (version === generation.current) setData(result); })
      .catch(error => { if (version === generation.current) setError(error.message); })
      .finally(() => { if (version === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [tab.id, scope, query, page, revision]);
  const run = async (mode, cookieKey) => {
    if (operation.current || loading) return;
    operation.current = true; setBusy(true); setError("");
    const version = generation.current;
    try {
      const result = await api("/browser/cookies", { id: tab.id, url: tab.url, mode, scope, query, page, cookieKey });
      if (version !== generation.current) return;
      if (mode === "details") setValue({ key: cookieKey, value: result.value });
      else { setData(result); setValue(null); setConfirmClear(false); }
    } catch (error) {
      if (version === generation.current) setError(error.message);
    } finally { operation.current = false; setBusy(false); }
  };
  return <section className="browser-cookies" aria-label="Управление Cookie" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <div className="cookie-heading">
      <button className="icon-button" aria-label="Закрыть управление Cookie" onClick={onClose}><ArrowLeft size={15} /></button>
      <strong>Управление Cookie</strong><span>{tab.incognito ? "Приватный сеанс" : "Обычный сеанс"}</span>
      <button className="icon-button" aria-label="Обновить Cookie" disabled={busy || loading}
        onClick={() => setRevision(revision + 1)}><RefreshCw size={15} /></button>
    </div>
    <div className="cookie-toolbar">
      <InlineSelect aria-label="Область сайтов для Cookie" value={scope} disabled={busy} onValueChange={next => { setScope(next); setPage(0); }}>
        <option value="site" disabled={!/^https?:/.test(tab.url)}>Текущий сайт</option><option value="all">Все сайты</option>
      </InlineSelect>
      <input ref={search} aria-label="Поиск Cookie" placeholder="Поиск сайта или имени Cookie" maxLength={200}
        value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <button disabled={busy || loading || !data} onClick={() => setConfirmClear(!confirmClear)}>
        <Trash2 size={14} />Очистить {scope === "site" ? "текущий сайт" : "все сайты"}
      </button>
    </div>
    {confirmClear && <div className="cookie-confirm" role="alert">
      <span>Очистить Cookie {scope === "site" ? data?.hostname : "всех сайтов этого " + (tab.incognito ? "приватного" : "обычного") + " сеанса"}? Условия поиска не ограничивают область очистки; может потребоваться повторный вход на сайты.</span>
      <button disabled={busy} onClick={() => run("clear")}>Очистить</button>
      <button disabled={busy} onClick={() => setConfirmClear(false)}>Отмена</button>
    </div>}
    {error && <p className="cookie-error" role="alert">{error}</p>}
    <div className="cookie-list" aria-busy={busy || loading}>
      {loading ? <p>Чтение Cookie…</p> : data?.cookies.length === 0 ? <p>Подходящих Cookie нет.</p> : data?.cookies.map(cookie =>
        <article className="cookie-record" key={cookie.key}>
          <div className="cookie-record-heading"><strong>{cookie.name || "(без имени)"}</strong>
            <button disabled={busy} onClick={() => value?.key === cookie.key ? setValue(null) : run("details", cookie.key)}>
              {value?.key === cookie.key ? "Скрыть значение" : "Показать значение"}</button>
            <button disabled={busy || cookie.partitionKeyOpaque} aria-label={`Удалить Cookie ${cookie.name}`}
              title={cookie.partitionKeyOpaque ? "Cookie этого раздела можно удалить только очисткой всех сайтов" : "Удалить этот Cookie"}
              onClick={() => run("delete", cookie.key)}><Trash2 size={14} /></button></div>
          <div className="cookie-metadata">{cookie.domain} · Путь {cookie.path} · {cookie.size} B</div>
          <div className="cookie-metadata">{cookie.session ? "Истекает при завершении сеанса" : `Истекает: ${new Date(cookie.expires * 1000).toLocaleString()}`}
            {cookie.secure && " · Secure"}{cookie.httpOnly && " · HttpOnly"}{cookie.sameSite && ` · SameSite=${cookie.sameSite}`}
            {(cookie.partitionKey || cookie.partitionKeyOpaque) && ` · Раздел: ${cookie.partitionKey?.topLevelSite || "непрозрачный"}`}</div>
          {value?.key === cookie.key && <pre className="cookie-value">{value.value || "(пустое значение)"}</pre>}
        </article>)}
    </div>
    {data && <div className="cookie-pagination"><span>Всего: {data.total} · Страница {data.page + 1}</span>
      <button disabled={busy || loading || data.page === 0} onClick={() => setPage(data.page - 1)}>Назад</button>
      <button disabled={busy || loading || (data.page + 1) * 50 >= data.total} onClick={() => setPage(data.page + 1)}>Вперёд</button>
    </div>}
  </section>;
}
