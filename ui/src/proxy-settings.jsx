import { InlineSelect } from "./inline-select";
import React, { useEffect, useRef, useState } from "react";
import {
  Download,
  Plus,
  Search,
  RefreshCw,
  Check,
  Activity,
  Server,
  Trash2,
  Pencil,
  LoaderCircle,
  Square,
  CircleHelp,
  ArrowRight,
  X,
  Route,
} from "lucide-react";
import { api } from "./api";
import { SafetyMessage } from "./safety-message";
import { ProxyYAMLInput } from "./proxy-yaml-input";
import "./proxy.css";

const bytes = (v) => {
  const n = Math.max(0, Number(v) || 0);
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
};
function usageLabel(raw) {
  const values = Object.fromEntries(
    (raw || "").split(";").map((v) => v.trim().split("=")),
  );
  const used = Number(values.upload || 0) + Number(values.download || 0);
  return [
    values.total ? `${bytes(used)} / ${bytes(values.total)}` : "",
    Number(values.expire) > 0
      ? `До ${new Date(Number(values.expire) * 1000).toLocaleDateString()}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
const emptyForm = {
  name: "",
  url: "",
  content: "",
  interval_hours: 24,
  host_download: false,
};
export function ProxySettings({ status, onApplied, onConfirm, onDirty, initializing = false }) {
  const [proxy, setProxy] = useState(null),
    [tab, setTab] = useState("nodes"),
    [search, setSearch] = useState(""),
    [source, setSource] = useState(""),
    [form, setForm] = useState(null),
    [mode, setMode] = useState("url"),
    [error, setError] = useState(""),
    [pending, setPending] = useState(""),
    [notice, setNotice] = useState(""),
    [delays, setDelays] = useState({}),
    [connections, setConnections] = useState({ connections: [] }),
    [logs, setLogs] = useState([]),
    [port, setPort] = useState("17896"),
    [rates, setRates] = useState({ up: 0, down: 0 });
  const [manual, setManual] = useState({
    name: "",
    type: "socks5",
    server: "",
    port: "1080",
    username: "",
    password: "",
  });
  const [routeDraft, setRouteDraft] = useState(null);
  const [hostRefresh, setHostRefresh] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const alive = useRef(true),
    loading = useRef(false),
    latest = useRef(null),
    measuring = useRef(false),
    portDirty = useRef(false);
  const reload = async () => {
    const value = await api("/proxy");
    if (alive.current) {
      setProxy(value);
      if (!portDirty.current) setPort(String(value.port));
    }
    return value;
  };
  useEffect(() => {
    alive.current = true;
    const tick = async () => {
      if (loading.current) return;
      loading.current = true;
      try {
        await reload();
      } catch (e) {
        if (alive.current) setError(e.message);
      } finally {
        loading.current = false;
      }
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (tab !== "connections" && tab !== "diagnostics") return;
    let cancelled = false;
    const tick = async () => {
      try {
        if (tab === "diagnostics") {
          const result = await api("/proxy/logs");
          if (!cancelled) setLogs(result.lines);
        } else {
          const result = await api("/proxy/connections"),
            now = Date.now();
          if (cancelled) return;
          if (latest.current) {
            const seconds = (now - latest.current.time) / 1000;
            if (seconds > 0)
              setRates({
                up: Math.max(
                  0,
                  (result.uploadTotal - latest.current.uploadTotal) / seconds,
                ),
                down: Math.max(
                  0,
                  (result.downloadTotal - latest.current.downloadTotal) /
                    seconds,
                ),
              });
          }
          latest.current = { ...result, time: now };
          setConnections(result);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      latest.current = null;
    };
  }, [tab]);
  const busy = Boolean(pending) || Boolean(status.job?.running);
  const mutate = async (action, input = {}) => {
    setError("");
    setNotice("");
    setPending(action);
    try {
      const job = await api(`/proxy/${action}`, input);
      let current;
      do {
        await new Promise((resolve) => setTimeout(resolve, 500));
        current = (await api("/status")).job;
        if (current.id !== job.id)
          throw new Error("Операция была заменена другой задачей. Проверьте текущее состояние");
      } while (current.running);
      portDirty.current = false;
      const updated = await reload();
      await onApplied();
      if (current.error) throw new Error(current.error);
      if (alive.current) {
        setForm(null);
        if (action === "route" || action === "select") setRouteDraft(null);
        const importedSource =
          action === "import"
            ? updated.sources.at(-1)
            : action === "refresh"
              ? updated.sources.find((source) => source.id === input.id)
              : null;
        setNotice(
          importedSource
            ? `Импортировано узлов: ${importedSource.nodes.length}, пропущено: ${importedSource.skipped?.length || 0}${importedSource.skipped?.length ? "; причины пропуска указаны у источника" : ""}`
            : current.message || "Готово",
        );
        setDelays({});
      }
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setPending("");
    }
  };
  const applyRoute = async (nodeIDs) => {
    if (
      !proxy.active &&
      status.vm_running &&
      !(await onConfirm({
        title: "Включить встроенный прокси и перезапустить среду?",
        body: "При первом включении или изменении порта прокси требуется перезапуск; текущий терминал завершится. При последующем переключении узлов процессы терминала сохраняются, но сетевые соединения устанавливаются заново.",
        confirm: "Включить и перезапустить",
      }))
    )
      return;
    mutate("route", { node_ids: nodeIDs, port: Number(port) });
  };
  const measure = async (ids) => {
    if (measuring.current) return;
    measuring.current = true;
    setPending("delay");
    setError("");
    try {
      // A small worker pool bounds probes without changing the selected group.
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (index < ids.length && alive.current) {
            const id = ids[index++];
            try {
              const result = await api("/proxy/delay", { node_id: id });
              if (alive.current)
                setDelays((old) => ({ ...old, [id]: `${result.delay} ms` }));
            } catch {
              if (alive.current)
                setDelays((old) => ({ ...old, [id]: "Недоступно / не загружено" }));
            }
          }
        }),
      );
    } finally {
      measuring.current = false;
      if (alive.current) setPending("");
    }
  };
  const submit = () => {
    let value = {
      id: form.id || "",
      name: form.name,
      url: form.url,
      content: form.content,
      interval_hours: form.interval_hours,
      host_download: form.host_download,
    };
    if (mode === "manual" && !form.id) {
      const node = { ...manual, port: Number(manual.port) };
      value = {
        ...form,
        name: form.name || manual.name,
        url: "",
        content: JSON.stringify({ proxies: [node] }),
        interval_hours: 0,
      };
    }
    mutate(form.id ? "edit" : "import", value);
  };
  const savedRoute = proxy?.route?.length
    ? proxy.route
    : proxy?.selected
      ? [proxy.selected]
      : [""];
  const route = routeDraft ?? savedRoute;
  const routeChanged = JSON.stringify(route) !== JSON.stringify(savedRoute);
  useEffect(() => {
    onDirty?.(routeChanged || initializing && Boolean(form));
    return () => onDirty?.(false);
  }, [onDirty, routeChanged, initializing, Boolean(form)]);
  if (!proxy)
    return <div className="proxy-loading" role={error ? "alert" : "status"}>{error || "Чтение конфигурации прокси…"}</div>;
  const allNodes = proxy.sources.flatMap((s) =>
    s.nodes.map((n) => ({ ...n, source: s.name, sourceID: s.id })),
  );
  const selected = allNodes.find((n) => n.id === proxy.selected);
  const routeValid =
    route.every((id) => allNodes.some((n) => n.id === id)) &&
    new Set(route).size === route.length;
  const routeName = (id) => allNodes.find((n) => n.id === id)?.name || "не выбран";
  const updateHop = (index, id) =>
    setRouteDraft(route.map((current, i) => (i === index ? id : current)));
  const nodes = allNodes.filter(
    (n) =>
      (!source || n.sourceID === source) &&
      `${n.name} ${n.source} ${n.type}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className="proxy-manager">
      <div className="section-title">
        <div className="proxy-heading">
          <h3>Встроенный прокси</h3>
          <button
            type="button"
            className="icon-button proxy-help-toggle"
            aria-label="Инструкция по использованию прокси"
            title={helpOpen ? "Свернуть инструкцию по использованию прокси" : "Посмотреть инструкцию по использованию прокси"}
            aria-expanded={helpOpen}
            aria-controls="proxy-help"
            onClick={() => setHelpOpen((open) => !open)}
          >
            <CircleHelp size={17} aria-hidden="true" />
          </button>
        </div>
        <p>Выберите финальный выход и при необходимости добавьте промежуточные узлы — ими будут пользоваться все программы в Cage.</p>
      </div>
      {helpOpen && (
        <section
          id="proxy-help"
          className="proxy-help"
          aria-labelledby="proxy-help-title"
        >
          <h4 id="proxy-help-title">Инструкция по использованию прокси</h4>
          <p className="proxy-help-intro">
            В Cage есть собственное ядро прокси; отдельно устанавливать Clash не
            нужно. Подготовьте свою подписку или данные узлов — Cage не
            предоставляет прокси-узлы.
          </p>
          <ol className="proxy-help-steps">
            <li>
              <strong>Импортируйте свой прокси</strong>
              <p>Откройте «Подписки» → «Добавить источник», укажите название источника и выберите способ:</p>
              <ul>
                <li>
                  <strong>Ссылка на подписку:</strong> скопируйте у провайдера
                  HTTPS-адрес подписки в формате Clash/Mihomo, вставьте его и
                  нажмите «Импортировать и проверить». Если доступных узлов ещё
                  нет, отметьте «Скачать подписку через сеть хоста»; хост должен
                  иметь доступ к этому адресу.
                </li>
                <li>
                  <strong>Локальный YAML:</strong> перетащите или выберите файл
                  конфигурации либо вставьте YAML с узлами и нажмите
                  «Импортировать и проверить». Конфигурацию можно экспортировать
                  из существующего клиента прокси.
                </li>
                <li>
                  <strong>Ручной узел:</strong> подходит для HTTP CONNECT или
                  SOCKS5. Укажите название узла, адрес сервера, порт, а также
                  логин и пароль от провайдера (если есть), затем нажмите
                  «Импортировать и проверить».
                </li>
              </ul>
            </li>
            <li>
              <strong>Выберите узел и включите прокси</strong>
              <p>
                После импорта перейдите на вкладку «Узлы», выберите финальный
                выход и нажмите «Применить прокси». Если к резидентному прокси
                нельзя подключиться из материкового Китая, выберите «Цепочка прокси» и
                добавьте перед ним доступный промежуточный узел; узлы могут быть
                из разных подписок. При первом включении запущенную среду нужно
                перезапустить; последующие переключения только пересоздают
                сетевые соединения.
              </p>
            </li>
            <li>
              <strong>Убедитесь, что сеть доступна</strong>
              <p>
                {initializing ? "Нажмите «Начать установку» и дождитесь завершения установки гостевой системы и проверки сети. Ориентируйтесь на результат проверки на экране инициализации;" : "Вернитесь в рабочую среду, запустите её и дождитесь прохождения проверки сети. Ориентируйтесь на состояние доступа в рабочей среде;"}«Измерить задержку» проверяет только задержку узла. Браузер,
                терминал и инструменты разработки в Cage используют выбранный
                узел совместно; настраивать прокси отдельно не нужно.
              </p>
            </li>
          </ol>
          <div className="proxy-help-notes">
            <strong>Импорт не удался или нет доступа к сети?</strong>
            <p>
              Убедитесь, что скопирован адрес подписки, а не страница входа или
              управления провайдера. Ссылки на отдельные узлы, списки
              узлов в Base64 и конфигурации, которые только ссылаются на
              удалённый список узлов, пока не поддерживаются; запросите у
              провайдера YAML Clash/Mihomo с узлами.
            </p>
            <p>
              Если подписка не скачивается, проверьте доступ хоста к её адресу
              или используйте локальный YAML. Если узел недоступен, выберите
              другой и откройте «Диагностику»; после смены узла всё равно нужно
              пройти проверку IP-адреса и региона выхода.
            </p>
          </div>
        </section>
      )}
      <div className="proxy-summary">
        <Server size={22} />
        <div>
          <strong>
            {selected ? `Финальный выход · ${selected.name}` : "Финальный узел ещё не настроен"}
          </strong>
          {savedRoute.length > 1 && (
            <span className="proxy-current-route">
              Текущая цепочка: {savedRoute.map(routeName).join(" → ")}
            </span>
          )}
          <span>
            {proxy.active
              ? proxy.running
                ? "Встроенное ядро Cage работает"
                : "Ядро не готово"
              : "Выберите узел и примените прокси; без настройки сеть недоступна"}{" "}
            · Отдельный порт {proxy.port}
          </span>
        </div>
        <span className={`proxy-badge ${proxy.network_open ? "online" : ""}`}>
          {proxy.state_label}
        </span>
      </div>
      {proxy.active && status.location && (
        <p className="field-help">
          Последний проверенный выход: {status.location.ip} · {status.location.country}{" "}
          {status.location.city}. Разрешение доступа к сети зависит от состояния
          проверки в рабочей среде.
        </p>
      )}
      {!proxy.core_available && (
        <div role="alert" className="error-message">
          В установочном пакете отсутствует встроенное ядро прокси. Пересоберите
          или установите полное приложение Cage.
        </div>
      )}
      <p className="field-help">
        Разрешены только IPv4 TCP и DNS через узлы; публичные UDP, IPv6 и ICMP
        постоянно блокируются. Переключение закрывает старые сетевые соединения
        и заново проверяет выход.
      </p>
      <div role="tablist" aria-label="Управление прокси" className="proxy-tabs">
        {[
          ["nodes", "Узлы"],
          ["sources", "Подписки"],
          ["connections", "Соединения"],
          ["diagnostics", "Диагностика"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "nodes" && (
        <>
          {allNodes.length > 0 && (
            <section
              className="proxy-route"
              aria-labelledby="proxy-route-title"
            >
              <div className="proxy-route-heading">
                <div>
                  <h4 id="proxy-route-title">Настройка подключения</h4>
                  <p>Используйте один выход напрямую или подключите резидентный прокси через промежуточный узел.</p>
                </div>
                <div
                  className="proxy-route-mode"
                  role="group"
                  aria-label="Способ подключения"
                >
                  <button
                    type="button"
                    aria-pressed={route.length === 1}
                    disabled={busy}
                    onClick={() => setRouteDraft([route.at(-1)])}
                  >
                    Один узел
                  </button>
                  <button
                    type="button"
                    aria-pressed={route.length > 1}
                    disabled={busy}
                    onClick={() => {
                      if (route.length === 1) setRouteDraft(["", route[0]]);
                    }}
                  >
                    Цепочка прокси
                  </button>
                </div>
              </div>
              <ol className="proxy-route-hops">
                {route.map((id, index) => {
                  const final = index === route.length - 1;
                  const label = final
                    ? "Финальный выход"
                    : `Промежуточный узел${route.length > 2 ? ` ${index + 1}` : ""}`;
                  return (
                    <li
                      key={index}
                      className={`proxy-route-hop ${final ? "is-exit" : ""}`}
                    >
                      <span className="proxy-hop-number" aria-hidden="true">
                        {index + 1}
                      </span>
                      <div className="proxy-hop-control">
                        <label htmlFor={`proxy-hop-${index}`}>{label}</label>
                        <InlineSelect
                          id={`proxy-hop-${index}`}
                          aria-label={label}
                          value={id}
                          disabled={busy}
                          onValueChange={(next) => updateHop(index, next)}
                        >
                          <option value="" disabled>
                            Выберите вариант: {label}
                          </option>
                          {Boolean(id) &&
                            !allNodes.some((n) => n.id === id) && (
                              <option value={id} disabled>
                                Узел удалён, выберите другой
                              </option>
                            )}
                          {proxy.sources.map((src) => (
                            <optgroup key={src.id} label={src.name}>
                              {src.nodes.map((n) => (
                                <option
                                  key={n.id}
                                  value={n.id}
                                  disabled={route.some(
                                    (hop, i) => i !== index && hop === n.id,
                                  )}
                                >
                                  {n.name}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </InlineSelect>
                        {final && <small>Целевой сайт увидит IP-адрес выхода этого узла</small>}
                      </div>
                      {!final && (
                        <button
                          className="icon-button proxy-hop-remove"
                          type="button"
                          disabled={busy}
                          aria-label={`Удалить: ${label}`}
                          title={`Удалить: ${label}`}
                          onClick={() =>
                            setRouteDraft(route.filter((_, i) => i !== index))
                          }
                        >
                          <X size={15} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
              {route.length > 1 && route.length < allNodes.length && (
                <button
                  type="button"
                  className="proxy-route-add"
                  disabled={busy || route.length >= allNodes.length}
                  onClick={() =>
                    setRouteDraft([...route.slice(0, -1), "", route.at(-1)])
                  }
                >
                  <Plus size={14} />
                  Добавить промежуточный узел
                </button>
              )}
              <div className="proxy-route-preview" aria-label="Цепочка к применению">
                <Route size={16} aria-hidden="true" />
                <span>Cage</span>
                {route.map((id, index) => (
                  <React.Fragment key={index}>
                    <ArrowRight size={13} aria-hidden="true" />
                    <strong>{routeName(id)}</strong>
                  </React.Fragment>
                ))}
                <ArrowRight size={13} aria-hidden="true" />
                <span>Целевой сайт</span>
              </div>
              <div className="proxy-route-actions">
                <span aria-live="polite">
                  {routeChanged
                    ? "Есть неприменённые изменения прокси"
                    : proxy.active
                      ? "Текущая конфигурация применена"
                      : "Выберите узлы и примените прокси"}
                </span>
                <div>
                  {routeDraft !== null && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setRouteDraft(null)}
                    >
                      Отменить изменения
                    </button>
                  )}
                  <button
                    type="button"
                    className={routeChanged || !proxy.active ? "primary" : ""}
                    disabled={busy || !proxy.core_available || !routeValid}
                    onClick={() => applyRoute(route)}
                  >
                    {pending === "route" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : !routeChanged && proxy.active ? (
                      <RefreshCw size={14} />
                    ) : (
                      <Check size={14} />
                    )}
                    {routeChanged || !proxy.active ? "Применить прокси" : "Применить заново"}
                  </button>
                </div>
              </div>
              {proxy.route_error && (
                <p role="alert" className="proxy-source-error">
                  <SafetyMessage message={proxy.route_error} />
                </p>
              )}
              {error && (
                <div role="alert" className="error-message">
                  <SafetyMessage message={error} />
                </div>
              )}
            </section>
          )}
          {allNodes.length > 0 && (
            <div className="proxy-node-heading">
              <h4>Доступные узлы</h4>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setTab("sources");
                  setForm({ ...emptyForm });
                  setMode("url");
                }}
              >
                <Plus size={14} />
                Добавить источник
              </button>
            </div>
          )}
          <div className="proxy-toolbar">
            <label className="proxy-search">
              <Search size={15} />
              <input
                aria-label="Поиск узлов"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по узлу, источнику или протоколу"
              />
            </label>
            <InlineSelect
              aria-label="Источник узлов"
              value={source}
              onValueChange={(next) => setSource(next)}
            >
              <option value="">Все источники</option>
              {proxy.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </InlineSelect>
            <button
              disabled={busy || !proxy.running || !nodes.length}
              title="Проверка HTTP-задержки; обычно не включает установку соединения и не показывает время первого открытия страницы"
              onClick={() => measure(nodes.map((n) => n.id))}
            >
              <Activity size={14} />
              Измерить задержку
            </button>
          </div>
          {!allNodes.length ? (
            <div className="proxy-empty">
              <Download size={26} />
              <strong>Добавьте первый источник узлов</strong>
              <p>Поддерживаются подписки Clash/Mihomo YAML, локальные конфигурации и ручные узлы.</p>
              <button
                onClick={() => {
                  setTab("sources");
                  setForm({ ...emptyForm });
                  setMode("url");
                }}
              >
                <Plus size={15} />
                Добавить источник
              </button>
            </div>
          ) : (
            <div className="proxy-node-list">
              {nodes.map((n) => (
                <div
                  className={`proxy-node ${n.id === route.at(-1) ? "selected" : ""}`}
                  key={n.id}
                >
                  <button
                    className="proxy-node-choice"
                    disabled={
                      busy ||
                      !proxy.core_available ||
                      route.slice(0, -1).includes(n.id)
                    }
                    title={
                      route.slice(0, -1).includes(n.id)
                        ? "Этот узел уже используется как промежуточный"
                        : "Выбрать финальным выходом; изменения вступят в силу после применения прокси"
                    }
                    onClick={() => updateHop(route.length - 1, n.id)}
                    aria-pressed={n.id === route.at(-1)}
                    aria-label={`Выбрать узел ${n.name}`}
                  >
                    <span className="proxy-radio">
                      {n.id === route.at(-1) && <Check size={12} />}
                    </span>
                    <span>
                      <strong>{n.name}</strong>
                      <small>
                        {n.source} · {n.type.toUpperCase()}
                      </small>
                    </span>
                  </button>
                  {savedRoute.includes(n.id) && (
                    <span className="proxy-node-role">
                      {n.id === proxy.selected ? "Текущий выход" : "Текущий промежуточный узел"}
                    </span>
                  )}
                  <span className="proxy-delay">
                    {delays[n.id] || "Не измерялась"}
                  </span>
                  <button
                    aria-label={`Измерить задержку: ${n.name}`}
                    title="Проверка HTTP-задержки этого узла до www.gstatic.com; обычно не включает установку соединения и не показывает время первого открытия страницы"
                    disabled={busy || !proxy.running}
                    onClick={() => measure([n.id])}
                  >
                    <Activity size={14} />
                  </button>
                </div>
              ))}
              {!nodes.length && (
                <p className="field-help">Нет узлов, соответствующих поиску.</p>
              )}
            </div>
          )}
        </>
      )}
      {tab === "sources" && (
        <>
          <label className="check-line">
            <input
              type="checkbox"
              checked={hostRefresh}
              onChange={(e) => setHostRefresh(e.target.checked)}
            />
            Скачивать подписку через сеть хоста при ручном обновлении
          </label>
          <p className="field-help">
            Автообновление всегда использует настроенный прокси и не переключается
            на загрузку через хост.
          </p>
          <div className="proxy-toolbar">
            <span>
              Источников: {proxy.sources.length} · узлов: {allNodes.length}
            </span>
            <button
              disabled={busy}
              onClick={() => {
                setForm({ ...emptyForm });
                setMode("url");
              }}
            >
              <Plus size={14} />
              Добавить источник
            </button>
          </div>
          {proxy.sources.map((s) => (
            <div className="proxy-source" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <small>
                  {s.remote ? s.host : "Локальный импорт"} · узлов: {s.nodes.length} ·{" "}
                  {s.interval_hours && s.remote
                    ? s.interval_hours === 1
                      ? "обновление каждый час"
                      : `обновление каждые ${s.interval_hours} ч`
                    : "ручное обновление"}
                </small>
                <small>
                  Обновлено {new Date(s.updated_at).toLocaleString()}
                  {usageLabel(s.usage) && ` · ${usageLabel(s.usage)}`}
                </small>
                {s.error && (
                  <span className="proxy-source-error">{s.error}</span>
                )}
                {s.skipped?.length > 0 && (
                  <details className="proxy-source-skipped">
                    <summary>
                      Импортировано узлов: {s.nodes.length}, пропущено: {s.skipped.length}
                      · Причины
                    </summary>
                    <ul>
                      {s.skipped.map((issue) => (
                        <li key={issue.index}>
                          Узел № {issue.index}
                          {issue.name && ` «${issue.name}»`}
                          {issue.type && ` (${issue.type})`}: {issue.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <div className="proxy-source-actions">
                {s.remote && (
                  <button
                    disabled={busy}
                    aria-label={`Обновить ${s.name}`}
                    onClick={() =>
                      mutate("refresh", {
                        id: s.id,
                        host_download: hostRefresh,
                      })
                    }
                  >
                    <RefreshCw size={14} />
                  </button>
                )}
                <button
                  disabled={busy}
                  aria-label={`Изменить ${s.name}`}
                  onClick={() => {
                    setForm({
                      ...emptyForm,
                      id: s.id,
                      name: s.name,
                      interval_hours: s.interval_hours,
                      remote: s.remote,
                    });
                    setMode("url");
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  disabled={busy}
                  aria-label={`Удалить ${s.name}`}
                  onClick={async () => {
                    if (
                      await onConfirm({
                        title: `Удалить источник «${s.name}»?`,
                        body: s.nodes.some((n) => n.id === proxy.selected)
                          ? "Текущий узел взят из этого источника. После удаления Cage останется офлайн, пока вы не выберете другой узел."
                          : "Источник и его узлы будут удалены; локальные файлы проектов не пострадают.",
                        confirm: "Удалить источник",
                      })
                    )
                      mutate("delete", { id: s.id });
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
          {form && (
            <div className="proxy-import">
              <h4>{form.id ? "Изменить источник" : "Добавить источник узлов"}</h4>
              {!form.id && (
                <div className="proxy-tabs">
                  {[
                    ["url", "Ссылка на подписку"],
                    ["file", "Локальный YAML"],
                    ["manual", "Ручной узел"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={mode === id ? "selected" : ""}
                      onClick={() => {
                        setMode(id);
                        setForm((old) => ({ ...old, content: "", url: "" }));
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <label>
                Название источника
                <input
                  value={form.name}
                  maxLength={100}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Например: повседневный прокси"
                />
              </label>
              {mode === "url" && (!form.id || form.remote) && (
                <>
                  <label>
                    {form.id ? "Новая ссылка на подписку (пусто — оставить прежнюю)" : "Ссылка на подписку"}
                    <input
                      value={form.url}
                      type="url"
                      autoComplete="off"
                      onChange={(e) =>
                        setForm({ ...form, url: e.target.value })
                      }
                      placeholder="https://…"
                    />
                  </label>
                  <label>
                    Интервал автообновления
                    <InlineSelect
                      aria-label="Интервал автообновления"
                      value={form.interval_hours}
                      onValueChange={(next) =>
                        setForm({
                          ...form,
                          interval_hours: Number(next),
                        })
                      }
                    >
                      {[
                        [0, "Только вручную"],
                        [1, "Каждый час"],
                        [6, "Каждые 6 часов"],
                        [24, "Каждый день"],
                        [168, "Каждую неделю"],
                      ].map(([v, label]) => (
                        <option value={v} key={v}>
                          {label}
                        </option>
                      ))}
                    </InlineSelect>
                  </label>
                  {!form.id && (
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={form.host_download}
                        onChange={(e) =>
                          setForm({ ...form, host_download: e.target.checked })
                        }
                      />
                      Скачать эту подписку через сеть хоста
                    </label>
                  )}
                  <p className="field-help">
                    По умолчанию подписка скачивается через настроенный прокси.
                    Если доступных узлов ещё нет, можно включить загрузку через
                    хост или импортировать локальный файл; при сбое другой путь
                    автоматически не используется.
                  </p>
                </>
              )}
              {mode === "file" && !form.id && (
                <ProxyYAMLInput
                  content={form.content}
                  disabled={busy}
                  onReadingChange={setReadingFile}
                  onContentChange={(content) =>
                    setForm((old) => ({ ...old, content }))
                  }
                  onFileRead={(value, content) =>
                    setForm((old) => ({
                      ...old,
                      content,
                      name:
                        old.name ||
                        value.name.replace(/\.[^.]+$/, "").slice(0, 100),
                      interval_hours: 0,
                    }))
                  }
                />
              )}
              {mode === "manual" && !form.id && (
                <>
                  <div className="field-row">
                    <label>
                      Название узла
                      <input
                        value={manual.name}
                        onChange={(e) =>
                          setManual({ ...manual, name: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Протокол
                      <InlineSelect
                        aria-label="Протокол"
                        value={manual.type}
                        onValueChange={(next) =>
                          setManual({ ...manual, type: next })
                        }
                      >
                        <option value="socks5">SOCKS5</option>
                        <option value="http">HTTP CONNECT</option>
                      </InlineSelect>
                    </label>
                  </div>
                  <div className="field-row">
                    <label>
                      Сервер
                      <input
                        value={manual.server}
                        onChange={(e) =>
                          setManual({ ...manual, server: e.target.value })
                        }
                        placeholder="Доменное имя или IP"
                      />
                    </label>
                    <label>
                      Порт
                      <input
                        type="number"
                        min="1"
                        max="65535"
                        value={manual.port}
                        onChange={(e) =>
                          setManual({ ...manual, port: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div className="field-row">
                    <label>
                      Имя пользователя
                      <input
                        value={manual.username}
                        autoComplete="off"
                        onChange={(e) =>
                          setManual({ ...manual, username: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Пароль
                      <input
                        type="password"
                        value={manual.password}
                        autoComplete="new-password"
                        onChange={(e) =>
                          setManual({ ...manual, password: e.target.value })
                        }
                      />
                    </label>
                  </div>
                </>
              )}
              <div className="proxy-form-actions">
                <button disabled={busy} onClick={() => setForm(null)}>
                  Отмена
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    readingFile ||
                    (!form.id &&
                      (mode === "url"
                        ? !form.url || !form.name
                        : mode === "file"
                          ? !form.content.trim() || !form.name
                          : !manual.name || !manual.server))
                  }
                  onClick={submit}
                >
                  {form.id ? "Сохранить источник" : "Импортировать и проверить"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {tab === "connections" && (
        <>
          <div className="proxy-metrics">
            <span>
              Загрузка <strong>{bytes(rates.up)}/s</strong>
              <small>Всего {bytes(connections.uploadTotal)}</small>
            </span>
            <span>
              Скачивание <strong>{bytes(rates.down)}/s</strong>
              <small>Всего {bytes(connections.downloadTotal)}</small>
            </span>
          </div>
          <p className="field-help">
            Показаны соединения и трафик текущего ядра, включая собственные
            проверочные запросы Cage; после перезапуска ядра накопленные значения
            сбрасываются.
          </p>
          <div className="proxy-node-list">
            {connections.connections.map((c) => (
              <div className="proxy-connection" key={c.id}>
                <span>
                  {c.host}:{c.port}
                  <small>{c.network}</small>
                </span>
                <small>
                  ↑ {bytes(c.upload)} · ↓ {bytes(c.download)}
                </small>
              </div>
            ))}
            {!connections.connections.length && (
              <p className="proxy-empty">Активных соединений нет</p>
            )}
          </div>
        </>
      )}
      {tab === "diagnostics" && (
        <>
          <p className="field-help">
            Встроенное ядро: {proxy.version || "не запущено"}. Ниже — сводка
            состояния Cage; исходные журналы ядра с риском учётных данных не
            показываются на странице.
          </p>
          <div className="proxy-diagnostics" role="log">
            {logs.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          <label>
            Отдельный порт прокси
            <input
              type="number"
              min="1024"
              max="65535"
              value={port}
              onChange={(e) => {
                portDirty.current = true;
                setPort(e.target.value);
              }}
            />
          </label>
          <div className="proxy-toolbar">
            <button
              disabled={busy || !selected}
              onClick={async () => {
                if (
                  Number(port) !== proxy.port &&
                  status.vm_running &&
                  !(await onConfirm({
                    title: "Сменить порт прокси и перезапустить среду?",
                    body: "Изменение порта требует перезапуска среды; текущий терминал завершится.",
                    confirm: "Сменить и перезапустить",
                  }))
                )
                  return;
                mutate("restart", { port: Number(port) });
              }}
            >
              <RefreshCw size={14} />
              Применить порт и перезапустить ядро
            </button>
            <button
              disabled={busy || !proxy.running}
              onClick={() => mutate("stop")}
            >
              <Square size={14} />
              Остановить ядро
            </button>
          </div>
          <p className="field-help">
            Cage не настраивает системный прокси или TUN на хосте. TUN другого
            прокси на этом компьютере всё ещё может влиять на исходящие соединения
            ядра; проверяйте с учётом фактической маршрутизации.
          </p>
        </>
      )}
      {pending && (
        <p className="proxy-progress" role="status">
          <LoaderCircle size={14} className="spin" />
          {pending === "delay"
            ? "Проверка задержки узлов…"
            : status.job?.message || "Обработка…"}
        </p>
      )}
      {error && !(tab === "nodes" && allNodes.length > 0) && (
        <div role="alert" className="error-message">
          <SafetyMessage message={error} />
        </div>
      )}
      {notice && (
        <p role="status" className="proxy-notice">
          <Check size={14} />
          {notice}
        </p>
      )}
    </div>
  );
}
