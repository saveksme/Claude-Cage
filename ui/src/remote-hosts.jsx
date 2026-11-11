import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  Computer,
  LoaderCircle,
  Plus,
  Server,
  ShieldCheck,
} from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { setClientContext } from "./client-context.mjs";
import { Modal } from "./modal";
import { HostForm } from "./remote-host-form";
import logo from "./logo.png";
import "./remote-hosts.css";

const Navigation = createContext(null);
export const useSSHNavigation = () => useContext(Navigation);
const identity = (context) =>
  `${context.mode}:${context.connection_id || "disconnected"}`;
const occupied = (status) =>
  Boolean(status?.running || status?.busy || status?.live_terminals);
const unknown = () => ({ known: false, message: "Состояние этого компьютера не подтверждено" });
const recentKey = "cage-recent-environment";
function recent() {
  try {
    return localStorage.getItem(recentKey) || "";
  } catch {
    return "";
  }
}
function remember(value) {
  try {
    localStorage.setItem(recentKey, value);
  } catch {
    /* Optional preference. */
  }
}
function localSummary(status) {
  if (!status?.known) return "Состояние этого компьютера не подтверждено";
  if (status.busy) return "На этом компьютере выполняется операция со средой";
  if (status.live_terminals)
    return `Активных терминалов на этом компьютере: ${status.live_terminals}`;
  if (status.running) return "Среда на этом компьютере запущена";
  return status.service_running
    ? "Служба управления этого компьютера запущена"
    : "Среда на этом компьютере остановлена";
}

export function ClientRoot({ children }) {
  const [context, setContext] = useState(null);
  const [error, setError] = useState("");
  const currentIdentity = useRef(null);
  const mounted = useRef(false);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const query = ++serial.current;
    const value = await api("/client/context");
    if (!mounted.current || query !== serial.current) return value;
    if (!["none", "local", "remote"].includes(value.mode))
      throw new Error("Клиент не вернул допустимую рабочую среду. Обновите Cage.");
    const next = identity(value);
    if (currentIdentity.current && currentIdentity.current !== next) {
      // Destroy callbacks, local files in flight and input handlers from the previous generation.
      location.reload();
      return value;
    }
    currentIdentity.current = next;
    setClientContext(value);
    setContext(value);
    setError("");
    return value;
  }, []);
  useEffect(() => {
    mounted.current = true;
    let timer;
    async function poll() {
      try {
        await refresh();
      } catch (e) {
        if (mounted.current) setError(e.message);
      }
      if (mounted.current) timer = setTimeout(poll, 2000);
    }
    (async () => {
      if (location.hash) {
        await api("/session", { token: location.hash.slice(1) });
        history.replaceState(null, "", location.pathname);
      }
      window.dispatchEvent(new Event("cage-session-ready"));
      await poll();
    })().catch((e) => setError(e.message));
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  return (
    <div className="client-shell">
      {error && (
        <div className="client-error error-message" role="alert">
          {error}
          <button onClick={() => location.reload()}>Переподключиться</button>
        </div>
      )}
      {context ? (
        <Environment context={context} refresh={refresh}>
          {children}
        </Environment>
      ) : (
        !error && (
          <div className="client-loading">
            <LoaderCircle className="spin" size={18} />
            Подключение к Cage…
          </div>
        )
      )}
    </div>
  );
}

function Environment({ context, refresh, children }) {
  const gateway = Boolean(context.desktop_gateway);
  const local = context.mode === "local" && !context.client_only;
  const remote = context.mode === "remote";
  const active = context.connection?.state === "connected" && remote;
  const localLost =
    gateway && local && context.connection?.state !== "connected";
  const ready = (local && !localLost) || active;
  const [expanded, setExpanded] = useState(false);
  const [hosts, setHosts] = useState([]);
  const [selected, setSelected] = useState(context.host_id || recent());
  const [form, setForm] = useState(null);
  const [remove, setRemove] = useState(null);
  const [stop, setStop] = useState(null);
  const [decision, setDecision] = useState(null);
  const [localLocked, setLocalLocked] = useState(false);
  const [localStatus, setLocalStatus] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const runningAction = useRef(false);
  const serial = useRef(0);
  const secretForTrust = useRef(null);
  const shellPresent = useRef(true);
  const acknowledged = useRef(false);
  const awaitingTarget =
    !ready && gateway && !context.client_only && context.mode === "none";
  const [stayInSSH, setStayInSSH] = useState(() =>
    sessionStorage.getItem("cage-disconnected-generation") === context.connection_id
  );
  const defaultLocal = awaitingTarget && !stayInSSH && context.candidate?.mode !== "remote";
  const showHosts = expanded || (!ready && !defaultLocal);
  const candidate = gateway ? context.candidate : null;
  const verifying = candidate?.connection?.state === "connecting";
  const connection =
    candidate?.connection || (!gateway ? context.connection : null);
  const host = hosts.find((item) => item.id === selected);
  const hostConnected = Boolean(active && host?.id === context.host_id);
  const connectionHostID = connection?.host_id || candidate?.host_id;
  const pinnedFailure =
    connectionHostID === selected &&
    connection?.host_key &&
    ["host_key_unknown", "host_key_changed"].includes(connection.error_code);
  const needsDeploy = connectionHostID === selected && connection?.error_code === "deployment_required";
  const phase = connection?.phase || "";
  const connectingLabel = phase.startsWith("cloud_upload_")
    ? `Загрузка пакета развёртывания ${phase.slice("cloud_upload_".length)}%`
    : { cloud_install: "Установка облачной среды…", cloud_detect: "Проверка сервера…", cloud_start: "Запуск службы…" }[phase] || "Проверка…";
  const hostName = remote
    ? context.name || "Удалённый хост"
    : local
      ? "Локальная среда"
      : "Выбор рабочей среды";
  const route = () => ({ connection_id: context.connection_id || "" });
  const load = useCallback(async () => {
    const { hosts = [] } = await api("/client/hosts");
    setHosts(hosts);
    setSelected((id) =>
      hosts.some((item) => item.id === id) ? id : hosts[0]?.id || "",
    );
  }, []);
  const statusSerial = useRef(0);
  const readLocal = useCallback(async () => {
    const id = ++statusSerial.current;
    let result;
    try {
      result = await api("/client/local-status");
    } catch {
      result = unknown();
    }
    if (shellPresent.current && id === statusSerial.current)
      setLocalStatus(result);
    return result;
  }, []);
  useEffect(() => {
    shellPresent.current = true;
    load().catch((e) => setError(e.message));
    return () => {
      shellPresent.current = false;
      ++serial.current;
    };
  }, [load]);
  useEffect(() => {
    if (!gateway || (local && !showHosts && !decision)) return;
    let live = true,
      timer;
    async function poll() {
      if (document.visibilityState !== "hidden") await readLocal();
      if (live) timer = setTimeout(poll, 4500);
    }
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [gateway, local, showHosts, decision, readLocal]);
  useEffect(() => {
    if (!ready && !defaultLocal && !acknowledged.current && nativeAvailable()) {
      native("workbenchReady")
        .then((ok) => {
          if (ok === true) acknowledged.current = true;
        })
        .catch(() => {});
    }
  }, [ready, defaultLocal]);
  const act = async (name, operation) => {
    if (runningAction.current) return;
    runningAction.current = true;
    setBusy(name);
    setError("");
    setLocalLocked(false);
    try {
      await operation();
    } catch (e) {
      setLocalLocked(e.status === 423);
      setError(
        e.status === 423
          ? "Локальная среда заблокирована. Вернитесь на этот компьютер, разблокируйте его, затем остановите локальную среду."
          : e.message,
      );
    } finally {
      runningAction.current = false;
      setBusy("");
    }
  };
  const closeSidebar = () => {
    secretForTrust.current = null;
    setExpanded(false);
    setPassword("");
    setError("");
  };
  const openSidebar = () => {
    setExpanded(true);
    setError("");
  };
  const cancel = async (pending = candidate) => {
    ++serial.current;
    if (pending) {
      try {
        await api("/client/cancel", { ...route(), candidate_id: pending.id });
      } catch (e) {
        // Another window may already have cancelled this candidate. Never
        // dismiss a newer one, and keep retry available for a real failure.
        if (e.status !== 409 || (await refresh()).candidate?.id === pending.id)
          throw e;
      }
    }
    secretForTrust.current = null;
    setDecision(null);
    setPassword("");
    await refresh();
  };
  async function commit(pending, action, status) {
    try {
      await api("/client/commit", {
        ...route(),
        candidate_id: pending.id,
        local_action: action,
        ...(action === "stop"
          ? { local_controller_id: status?.controller_id }
          : {}),
      });
    } catch (e) {
      if (action === "auto" && e.status === 409 && pending.mode === "remote") {
        const result = await readLocal();
        if (occupied(result) || !result.known) {
          setDecision({ pending, status: result });
          return;
        }
      }
      if (action === "stop" && e.status !== 423) {
        const actual = await readLocal();
        if (actual.known && !actual.service_running && !occupied(actual)) {
          setDecision(null);
          throw new Error(
            "Среда на этом компьютере остановлена. Целевое подключение не завершено; подключитесь к SSH-хосту заново.",
          );
        }
      }
      throw e;
    }
    remember(
      pending.mode === "local"
        ? "local"
        : pending.connection?.host_id || pending.host_id || selected,
    );
    setDecision(null);
    setPassword("");
    await refresh();
  }
  async function verified(pending) {
    if (pending.mode === "remote") {
      const status = await readLocal();
      if (!status.known || occupied(status)) {
        setDecision({ pending, status });
        return;
      }
    }
    await commit(pending, "auto");
  }
  // Advance only the candidate this window requested. An interrupted window can
  // explicitly resume a verified candidate without applying another window's choice.
  async function requestTarget(
    mode,
    item = null,
    secret = "",
    cancelled = false,
    deploy = false,
  ) {
    setPassword("");
    if (!gateway) {
      const old = context.connection;
      if (mode === "local")
        await api("/client/local", { connection_id: old?.connection_id || "" });
      else {
        if (old?.connection_id)
          await api("/client/disconnect", { connection_id: old.connection_id });
        await api("/client/connect", { host_id: item.id, passphrase: secret, deploy });
      }
      await refresh();
      return;
    }
    if (candidate && !cancelled) await cancel(candidate);
    secretForTrust.current = null;
    const pending = await api("/client/candidate", {
      ...route(),
      mode,
      ...(item ? { host_id: item.id, passphrase: secret, deploy } : {}),
    });
    const request = ++serial.current;

    let progress = pending;
    while (shellPresent.current && serial.current === request) {
      if (progress.connection?.state === "connected") {
        await verified(progress);
        return;
      }
      if (
        progress.connection?.state === "failed" ||
        progress.connection?.state === "disconnected"
      ) {
        if (item && secret && (progress.connection?.host_key || progress.connection?.error_code === "deployment_required"))
          secretForTrust.current = { id: item.id, secret };
        await refresh();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (!shellPresent.current || request !== serial.current) return;
      const value = await refresh();
      if (
        value.connection_id !== context.connection_id ||
        value.candidate?.id !== pending.id
      )
        return;
      progress = value.candidate;
    }
  }
  const trust = async () => {
    const saved = hosts.find((h) => h.id === connectionHostID);
    if (!saved || !connection.host_key)
      throw new Error("Конфигурация хоста изменилась. Подключитесь заново.");
    const secret =
      password ||
      (secretForTrust.current?.id === saved.id
        ? secretForTrust.current.secret
        : "");
    if (candidate) await cancel(candidate);
    await api(
      `/client/hosts/${saved.id}`,
      { ...saved, host_key: connection.host_key },
      "PUT",
    );
    await load();
    setSelected(saved.id);
    await requestTarget("remote", saved, secret, true);
  };
  const disconnect = async () => {
    const next = await api(
      "/client/disconnect",
      gateway
        ? route()
        : { connection_id: context.connection?.connection_id || "" },
    );
    remember(context.host_id || selected);
    setPassword("");
    setExpanded(true);
    if (gateway) {
      sessionStorage.setItem("cage-disconnected-generation", next.connection_id);
      setStayInSSH(true);
    }
    await refresh();
  };
  const choose = (item) => {
    secretForTrust.current = null;
    setSelected(item.id);
    setPassword("");
    setError("");
    openSidebar();
  };
  // Enter the ordinary local account/workbench on a fresh desktop launch.
  // Connecting this control service never invokes /start (the VM stays manual).
  const attemptedDefault = useRef(false);
  useEffect(() => {
    if (!defaultLocal || attemptedDefault.current) return;
    attemptedDefault.current = true;
    void act("local", () => requestTarget("local"));
  }, [defaultLocal]);
  const localButton = (label) => (
    <button
      disabled={
        Boolean(busy) ||
        (localStatus?.available === false &&
          localStatus?.known &&
          !localStatus.service_running)
      }
      onClick={() => act("local", () => requestTarget("local"))}
    >
      <Computer size={16} />
      {label}
    </button>
  );
  const modalOpen = Boolean(form || remove || stop || decision);
  const decisionBusy = busy === "commit" || busy === "cancel";
  const cancelDecision = () => act("cancel", () => cancel(decision.pending));
  const unlockButton = localLocked && (
    <button
      disabled={Boolean(busy)}
      onClick={() =>
        act("unlock-local", async () => {
          const pending = decision?.pending || candidate;
          if (pending) await cancel(pending);
          setStop(null);
          setDecision(null);
          if (local && !localLost) {
            location.reload();
            return;
          }
          setExpanded(true);
          await requestTarget("local", null, "", true);
        })
      }
    >
      Вернуться на этот компьютер и разблокировать
    </button>
  );
  const access = { expanded: showHosts, open: openSidebar };
  const showBackground =
    gateway &&
    !local &&
    localStatus &&
    (!localStatus.known ||
      occupied(localStatus) ||
      localStatus.service_running);
  return (
    <Navigation.Provider value={access}>
      {!local && !defaultLocal && <header className="client-toolbar">
        {local ? (
          <Computer size={16} />
        ) : remote ? (
          <Server size={16} />
        ) : (
          <img className="brand-logo" src={logo} alt="" />
        )}
        <strong>{ready ? hostName : "Cage"}</strong>
        {ready && (
          <span className="client-toolbar-hint">
            {remote ? "SSH · работа в облаке" : "Текущая рабочая среда"}
          </span>
        )}
        {ready && !showHosts && (
          <button className="ssh-fallback" onClick={openSidebar}>
            <Server size={15} />
            SSH-хосты
          </button>
        )}
      </header>}
      {showBackground && (
        <div className="local-background" role="status">
          <Computer size={16} />
          <div>
            <strong>
              {occupied(localStatus)
                ? "На этом компьютере тоже идёт работа"
                : localSummary(localStatus)}
            </strong>
            {occupied(localStatus) && (
              <span>
                {localStatus.live_terminals
                  ? `Активных терминалов: ${localStatus.live_terminals}`
                  : localStatus.busy
                    ? "Выполняется операция"
                    : "Ресурсы этого компьютера заняты"}
              </span>
            )}
          </div>
          {localStatus.known && localStatus.controller_id && (
            <button
              disabled={Boolean(busy)}
              onClick={() => {
                setError("");
                setStop(localStatus);
              }}
            >
              Остановить локальную среду
            </button>
          )}
        </div>
      )}
      <div
        className="client-stage"
        inert={modalOpen || undefined}
        data-environment-dialog={modalOpen || undefined}
      >
        {showHosts && (
          <aside
            className="workspace-sidebar ssh-sidebar"
            aria-label="SSH-хосты"
          >
            <div className="sidebar-top">
              <span className="sidebar-brand">
                <Server size={18} />
                SSH-хосты
              </span>
              {ready && (
                <button
                  className="icon-button"
                  disabled={Boolean(busy) || verifying}
                  onClick={closeSidebar}
                  aria-label="Вернуться к боковой панели рабочей среды"
                >
                  <ArrowLeft size={16} />
                </button>
              )}
            </div>
            <div className="ssh-sidebar-body">
              <div className="ssh-list-heading">
                <span>Сохранённые хосты</span>
                <button
                  className="icon-button"
                  aria-label="Добавить удалённый хост"
                  title="Добавить удалённый хост"
                  disabled={Boolean(busy)}
                  onClick={() => setForm({ host: null })}
                >
                  <Plus size={16} />
                </button>
              </div>
              {hosts.map((item) => (
                <button
                  className={`ssh-host-row ${selected === item.id ? "selected" : ""}`}
                  key={item.id}
                  aria-pressed={selected === item.id}
                  disabled={Boolean(busy) || verifying}
                  onClick={() => choose(item)}
                >
                  <Server size={15} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.user}@{item.host}:{item.port}
                    </small>
                  </span>
                  {context.host_id === item.id && active && (
                    <Check size={15} aria-label="Подключено" />
                  )}
                </button>
              ))}
              {!hosts.length && (
                <div className="ssh-empty">
                  <p>Удалённых хостов пока нет</p>
                  <button onClick={() => setForm({ host: null })}>
                    <Plus size={14} />
                    Добавить хост
                  </button>
                </div>
              )}
              {host && (
                <section className="ssh-host-actions" aria-label="Действия с выбранным хостом">
                  {host.auth.kind === "key_file" && !hostConnected && (
                    <label>
                      Парольная фраза ключа (если задана)
                      <input
                        type="password"
                        autoComplete="off"
                        disabled={Boolean(busy)}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </label>
                  )}
                  {hostConnected ? (
                    <button
                      disabled={Boolean(busy)}
                      onClick={() => act("disconnect", disconnect)}
                    >
                      Отключиться
                    </button>
                  ) : (
                    !pinnedFailure && (
                      <button
                        className="primary"
                        disabled={
                          Boolean(busy) || verifying || Boolean(decision)
                        }
                        onClick={() =>
                          act("verify", () =>
                            requestTarget("remote", host, password || (needsDeploy && secretForTrust.current?.id === host.id ? secretForTrust.current.secret : ""), false, needsDeploy),
                          )
                        }
                      >
                        {busy === "verify" || verifying
                          ? connectingLabel
                          : needsDeploy ? "Развернуть и подключиться" : "Подключиться к этому хосту"}
                      </button>
                    )
                  )}
                  <div className="remote-button-row">
                    <button
                      disabled={Boolean(busy) || hostConnected || verifying}
                      onClick={() =>
                        act("edit", async () => {
                          if (candidate?.connection.host_id === host.id)
                            await cancel(candidate);
                          setForm({ host });
                        })
                      }
                    >
                      Изменить
                    </button>
                    <button
                      disabled={Boolean(busy) || hostConnected || verifying}
                      onClick={() =>
                        act("remove-prompt", async () => {
                          if (candidate?.connection.host_id === host.id)
                            await cancel(candidate);
                          setRemove(host);
                        })
                      }
                    >
                      Удалить подключение
                    </button>
                  </div>
                </section>
              )}
              {!context.client_only && (!local || localLost) && (
                <div className="ssh-local-action">
                  {localButton("Войти в локальную рабочую среду")}
                </div>
              )}
              {!context.client_only && local && (
                <p className="ssh-help">Переключайте рабочую среду после подключения к облаку.</p>
              )}
              {error && !decision && !stop && !remove && (
                <p className="error-message" role="alert">
                  {error}
                </p>
              )}
              {connection?.state === "failed" &&
                (!connectionHostID || connectionHostID === selected) && (
                  <div className="ssh-connection" role="alert">
                    <strong>
                      {connection.message || "Не удалось подключиться. Повторите попытку."}
                    </strong>
                    {pinnedFailure && (
                      <>
                        <p>Сверьте отпечаток хоста «{host?.name}» с администратором сервера.</p>
                        <code>
                          {connection.host_key.algorithm}
                          <br />
                          {connection.host_key.fingerprint}
                        </code>
                        <button
                          disabled={Boolean(busy)}
                          className="primary"
                          onClick={() => act("trust", trust)}
                        >
                          <ShieldCheck size={15} />
                          Я сверил отпечаток и доверяю этому хосту
                        </button>
                      </>
                    )}
                  </div>
                )}
              {remote && !active && !connection?.message && (
                <p className="ssh-help" role="status">
                  Соединение разорвано. Подключитесь заново и проверьте облачные задачи.
                </p>
              )}
              {gateway && candidate && !decision && (
                <>
                  {candidate.connection?.state === "connected" && !busy && (
                    <button
                      onClick={() => act("verify", () => verified(candidate))}
                    >
                      Продолжить подключение
                    </button>
                  )}
                  <button
                    disabled={decisionBusy}
                    onClick={() => cancel().catch((e) => setError(e.message))}
                  >
                    Отменить это подключение
                  </button>
                </>
              )}
            </div>
          </aside>
        )}
        {ready ? (
          <div className="client-workbench">{children}</div>
        ) : defaultLocal && !error && candidate?.connection?.state !== "failed" && !expanded ? (
          <div className="client-loading" role="status">Открытие рабочей среды Cage…</div>
        ) : (
          <main className="environment-picker">
            <div>
              <img className="environment-logo" src={logo} alt="" />
              <h1>
                {localLost
                  ? "Переподключиться к локальной рабочей среде"
                  : remote && !active
                    ? "Переподключиться к SSH-хосту"
                    : defaultLocal ? "Подключение к локальной рабочей среде не завершено" : "Подключиться к SSH-хосту"}
              </h1>
              <p>
                {context.client_only
                  ? "Подключитесь к серверу по SSH; при первом подключении Cage можно развернуть автоматически. Проектами, приложениями и сетью управляет сервер."
                  : "Этот компьютер и SSH-хосты используют одну рабочую среду. Проектами, приложениями и сетью управляет выбранная среда."}
              </p>
              {!context.client_only &&
                localStatus?.known &&
                localStatus.available === false &&
                !localStatus.service_running && (
                  <p>Компоненты запуска на этом компьютере недоступны; можно подключиться к серверу по SSH.</p>
                )}
              {!showHosts && error && (
                <p className="error-message" role="alert">
                  {error}
                </p>
              )}
              <div className="environment-actions">
                {!context.client_only &&
                  (!showHosts || localLost) &&
                  localButton("Переподключиться к этому компьютеру")}
                {!showHosts && (
                  <button disabled={Boolean(busy)} onClick={openSidebar}>
                    <Server size={16} />
                    Подключиться к SSH-хосту
                  </button>
                )}
              </div>
              {!showHosts && hosts.length > 0 && (
                <div className="environment-recent">
                  <h2>Сохранённые хосты</h2>
                  {hosts.map((item) => (
                    <button key={item.id} onClick={() => choose(item)}>
                      <Server size={15} />
                      {item.name}
                      {recent() === item.id && <small>Последнее использование</small>}
                    </button>
                  ))}
                </div>
              )}
              {busy === "local" && <p role="status">Подключение к локальной рабочей среде…</p>}
              {!showHosts && candidate?.connection?.state === "failed" && (
                <p role="alert" className="error-message">
                  {candidate.connection.message}
                </p>
              )}
            </div>
          </main>
        )}
      </div>
      {form && (
        <HostForm
          initial={form.host}
          platform={context.client_platform}
          onClose={() => setForm(null)}
          onSaved={async (saved) => {
            await load();
            setSelected(saved.id);
            setPassword("");
            setForm(null);
          }}
        />
      )}
      {remove && (
        <Modal
          title="Удалить SSH-хост"
          onClose={busy ? undefined : () => setRemove(null)}
          footer={
            <>
              <button disabled={Boolean(busy)} onClick={() => setRemove(null)}>
                Отмена
              </button>
              <button
                className="primary"
                disabled={Boolean(busy)}
                onClick={() =>
                  act("remove", async () => {
                    await api(
                      `/client/hosts/${remove.id}`,
                      undefined,
                      "DELETE",
                    );
                    setRemove(null);
                    setPassword("");
                    await load();
                  })
                }
              >
                Подтвердить удаление
              </button>
            </>
          }
        >
          <div className="ssh-dialog-body">
            <p>Удалить локальную конфигурацию подключения к «{remove.name}»? Облачные файлы и задачи сохранятся.</p>
            {error && <p role="alert">{error}</p>}
          </div>
        </Modal>
      )}
      {decision && (
        <Modal
          title="Переключиться на SSH-хост"
          onClose={decisionBusy ? undefined : cancelDecision}
          footer={
            <>
              <button disabled={decisionBusy} onClick={cancelDecision}>
                Отмена
              </button>
              <button
                disabled={decisionBusy}
                onClick={() =>
                  act("commit", () =>
                    commit(decision.pending, "keep", decision.status),
                  )
                }
              >
                Оставить работу на этом компьютере
              </button>
              <button
                className="primary"
                disabled={
                  decisionBusy ||
                  !decision.status.known ||
                  !decision.status.controller_id
                }
                onClick={() =>
                  act("commit", () =>
                    commit(decision.pending, "stop", decision.status),
                  )
                }
              >
                Остановить локальную среду и подключиться
              </button>
            </>
          }
        >
          <div className="ssh-dialog-body">
            <p>
              <Check size={16} /> SSH и служба Cage хоста{" "}
              {hosts.find(
                (h) =>
                  h.id ===
                  (decision.pending.connection?.host_id ||
                    decision.pending.host_id),
              )?.name || "целевой хост"}{" "}
              проверены.
            </p>
            <p>
              <strong>{localSummary(decision.status)}.</strong>{" "}
              Остановка на этом компьютере завершит терминальные задачи и
              освободит ресурсы; несохранённые данные могут быть потеряны. Если
              выбрать сохранение, локальную среду можно остановить позже из
              облачной рабочей среды.
            </p>
            {busy === "commit" && (
              <p role="status">Подтверждение переключения среды…</p>
            )}
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
            {unlockButton}
          </div>
        </Modal>
      )}
      {stop && (
        <Modal
          title="Остановить локальную среду?"
          onClose={busy ? undefined : () => setStop(null)}
          footer={
            <>
              <button disabled={Boolean(busy)} onClick={() => setStop(null)}>
                Отмена
              </button>
              <button
                className="primary"
                disabled={Boolean(busy)}
                onClick={() =>
                  act("stop", async () => {
                    await api("/client/local-stop", {
                      ...route(),
                      local_controller_id: stop.controller_id,
                    });
                    await readLocal();
                    setStop(null);
                  })
                }
              >
                Подтвердить остановку
              </button>
            </>
          }
        >
          <div className="ssh-dialog-body">
            <p>
              {localSummary(stop)}
              . Остановка завершит терминальные задачи на этом компьютере и
              освободит ресурсы; несохранённые данные могут быть потеряны.
              Облачные задачи продолжат работу.
            </p>
            {busy === "stop" && <p role="status">Остановка локальной среды…</p>}
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
            {unlockButton}
          </div>
        </Modal>
      )}
    </Navigation.Provider>
  );
}
