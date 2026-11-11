import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, Pencil, Plus, RefreshCw, TerminalSquare, Timer } from "lucide-react";
import { api } from "./api";
import { InlineSelect } from "./inline-select";
import crabIcon from "./claude-account-crab.svg";
import "./claude-accounts.css";

// Ordinary reads never start an upstream usage query.
export function useClaudeAccounts() {
  const [registry, setRegistry] = useState(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pendingMutation = useRef(0);
  const polling = useRef(false);
  const load = useCallback(async (change, visiblePanel = false) => {
    if (!change && (pendingMutation.current || (visiblePanel && polling.current))) return;
    const request = ++generation.current;
    if (change) pendingMutation.current++;
    else if (visiblePanel) polling.current = true;
    try {
      const value = await api(visiblePanel ? "/claude-accounts?panel=visible" : "/claude-accounts", change);
      if (!Array.isArray(value?.accounts)) throw new Error("Не удалось прочитать список аккаунтов Claude");
      if (generation.current === request) {
        setRegistry(value);
        setError("");
      }
      return value.accounts;
    } catch (e) {
      if (generation.current === request) setError(e.message);
      if (change) throw e;
    } finally {
      if (change) pendingMutation.current--;
      else if (visiblePanel) polling.current = false;
    }
  }, []);
  useEffect(() => { load(); return () => { generation.current++; }; }, [load]);
  return { accounts: registry?.accounts ?? null, detected: registry?.detected,
    detectionStatus: registry?.detection_status, detectionError: registry?.detection_error,
    usageRunning: registry?.usage_panel_running, usageUnavailable: registry?.usage_unavailable_reason,
    scheduling: registry?.scheduling || {mode:"balanced",switch_policy:"ask"}, loginNotice: registry?.login_notice, error, load };
}

const statusLabels = {
  pending: "Ожидание входа", ready: "Вход выполнен", signed_out: "Требуется вход",
  duplicate: "Аккаунт уже в списке", changed: "Личность входа изменилась",
};
const localTimestamp = new Intl.DateTimeFormat(undefined, {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
});
const timeLabel = (seconds) => localTimestamp.format(seconds * 1000);

const usageUpdatedAt = (profile) => Math.max(profile.quota?.five_hour?.observed_at || 0,
  profile.quota?.seven_day?.observed_at || 0) || profile.usage_checked_at || 0;
const ageUnit = (elapsed) => elapsed < 3600 ? 60 : elapsed < 86400 ? 3600 : 86400;
function relativeTimeLabel(seconds, now) {
  const elapsed = Math.max(0, now - seconds);
  if (elapsed < 60) return "только что";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} мин назад`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)} ч назад`;
  return `${Math.floor(elapsed / 86400)} дн. назад`;
}

const QuotaTime = createContext(0);

// All rows share a clock. Only quota readings subscribe; a tick doesn't render
// the account forms or fetch data. Sleep until the next visible unit changes.
function QuotaClock({ accounts, children }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    let timer;
    const update = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const millis = Date.now();
      const seconds = Math.floor(millis / 1000);
      setNow(seconds);
      let delay = Infinity;
      for (const account of accounts || []) {
        const updated = usageUpdatedAt(account);
        if (updated > 0) {
          const elapsed = Math.max(0, seconds - updated);
          const unit = ageUnit(elapsed);
          delay = Math.min(delay, unit - elapsed % unit);
        }
        for (const window of [account.quota?.five_hour, account.quota?.seven_day]) {
          const left = window?.resets_at - seconds;
          if (left > 0) delay = Math.min(delay, left <= 60 ? 1 : (left - 1) % 60 + 1);
          const seen = window?.observed_at;
          if (window && seen && seen + 901 > seconds) delay = Math.min(delay, seen + 901 - seconds);
        }
      }
      if (Number.isFinite(delay)) timer = setTimeout(update, delay * 1000 - millis % 1000);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", update); };
  }, [accounts]);
  return <QuotaTime.Provider value={now}>{children}</QuotaTime.Provider>;
}

function resetCountdown(seconds) {
  if (seconds < 60) return `через ${seconds} с`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `через ${hours} ч ${minutes % 60} мин`;
  return `через ${Math.floor(hours / 24)} дн. ${hours % 24} ч`;
}

const usageLabels = {
  checking: "Запрос квоты…", reported: "Квота получена", partial: "В этот раз получена только часть квоты",
  cached: "В этот раз только кэшированные данные", unavailable: "Квота не получена", error: "Не удалось запросить квоту",
  not_applicable: "Текущий вход не предоставляет квоту подписки",
  identity_changed: "Личность входа изменилась, эти данные отброшены", offline: "Среда не в сети, запрос невозможен",
  update_required: "Для запроса синхронизируйте компоненты среды", blocked: "Запрос квоты временно недоступен",
  signed_out: "Войдите, чтобы запросить квоту", local: "Данные из сеанса", unknown: "Квота ещё не запрашивалась",
};

function useUsageCheck(profile, environment, perform, change) {
  const [manual, setManual] = useState(null);
  const check = () => perform(async () => {
    setManual({ state: "checking" });
    try {
      await change(profile.id ? { action: "refresh", id: profile.id } :
        { action: "refresh_default", identity: profile.identity });
      setManual(null);
    } catch (e) {
      setManual({ state: "error", previousCheck: profile.usage_checked_at, previousStatus: profile.usage_status });
      await change(); // A failed identity check can still change which default account the panel should show.
      throw e;
    }
  });
  let state = profile.usage_status || (profile.quota ? "local" : "unknown");
  if (profile.status === "changed" || profile.status === "duplicate") state = "identity_changed";
  if (profile.status === "signed_out" || profile.status === "pending") state = "signed_out";
  if (manual?.state === "error" && manual.previousCheck === profile.usage_checked_at && manual.previousStatus === profile.usage_status) state = "error";
  if (profile.usage_checking || manual?.state === "checking") state = "checking";
  if (environment) state = environment;
  return { state, check };
}

function QuotaWindow({ label, snapshot, state }) {
  const now = useContext(QuotaTime);
  const reset = snapshot?.resets_at;
  const remaining = reset ? reset - now : null;
  const expired = remaining !== null && remaining <= 0;
  const hasReading = Number.isFinite(snapshot?.used_percentage);
  const known = !expired && hasReading;
  const lastSeen = snapshot?.observed_at;
  const stale = known && (!lastSeen || now - lastSeen > 15 * 60 ||
    !["reported", "partial"].includes(state));
  const countdown = expired ? "Ожидание обновления" : remaining !== null ? resetCountdown(remaining) :
    known ? "Время сброса неизвестно" : state === "checking" ? "Запрос…" : "Нет данных";
  return <div className="claude-quota-row" role="group" aria-label={label + ": квота"}>
    <span className="claude-quota-period">{label}</span>
    {known
      ? <progress aria-label={label + ": использованная квота"} value={snapshot.used_percentage} max={100} />
      : <span className="claude-quota-unknown" aria-hidden="true" />}
    <div className="claude-quota-reading">
      {stale && <span className="claude-quota-stale" title={lastSeen ? `Прежние данные · ${timeLabel(lastSeen)}` : "Прежние данные"}>Прежние данные</span>}
      {known && <strong title={lastSeen ? `Использовано · считано ${timeLabel(lastSeen)}` : "Использовано"}>{snapshot.used_percentage}%</strong>}
      <span className="claude-quota-reset" title={reset ? `Сброс: ${timeLabel(reset)}` : "Время сброса неизвестно"}>
        {remaining > 0 && <Timer size={12} aria-hidden="true" />}{countdown}
      </span>
    </div>
    {hasReading && (expired || stale || state === "partial") && <small className="claude-quota-history">
      {expired && `В прошлый раз ${snapshot.used_percentage}% · `}
      {lastSeen > 0 ? <>{!expired && "Считано "}<time dateTime={new Date(lastSeen * 1000).toISOString()}>{timeLabel(lastSeen)}</time></> : "Время считывания неизвестно"}
    </small>}
  </div>;
}

function ProfileUsage({ quota, state }) {
  return <div className="claude-quota-grid">
    <QuotaWindow label="5h" snapshot={quota?.five_hour} state={state} />
    <QuotaWindow label="7d" snapshot={quota?.seven_day} state={state} />
  </div>;
}

function UsageNote({ profile, state }) {
  const now = useContext(QuotaTime);
  const updated = usageUpdatedAt(profile);
  return <small className="claude-quota-age">
    <span>{usageLabels[state] || "Нет данных о квоте"}</span>
    {updated > 0 && <span>Обновлено <time dateTime={new Date(updated * 1000).toISOString()} title={timeLabel(updated)}>
      {relativeTimeLabel(updated, now)}</time></span>}
  </small>;
}

function DetectedProfile({ profile, usageEnvironment, busy, join, perform, change }) {
  const usage = useUsageCheck(profile, usageEnvironment, perform, change);
  return <article className="claude-profile claude-detected" aria-label={profile.email}>
    <div className="claude-profile-heading">
      <span className="claude-profile-avatar" aria-hidden="true"><img src={crabIcon} alt="" /></span>
      <div className="claude-profile-identity">
        <div className="claude-profile-name">
          <h4 title={profile.email}>{profile.email}</h4>
          {profile.plan && <span className="claude-profile-plan">{profile.plan}</span>}
        </div>
        <div className="claude-profile-meta">
          <span className="claude-profile-status">Обычный терминал · обнаружен, не добавлен</span>
          {profile.organization && <span className="claude-profile-email" title={profile.organization}>{profile.organization}</span>}
        </div>
      </div>
    </div>
    <ProfileUsage quota={profile.quota} state={usage.state} />
    <div className="claude-profile-actions">
      <button className="quiet-button" disabled={busy} onClick={join}><Plus size={14} />Добавить в распределение</button>
      <button className="quiet-button" disabled={busy || !!usageEnvironment || usage.state === "checking"} onClick={usage.check}>
        <RefreshCw size={14} />Проверить состояние</button>
      <UsageNote profile={profile} state={usage.state} />
    </div>
  </article>;
}

function ProfileCard({ profile, environment, usageEnvironment, busy, active, defaultActive, perform, change, login, cancelDraft }) {
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState("");
  const [group, setGroup] = useState(profile.handoff_group || "");
  const displayName = profile.label || profile.email;
  const fromTerminal = profile.source === "default";
  const savedLabel = label.trim() || profile.email;
  const usage = useUsageCheck(profile, usageEnvironment, perform, change);
  return <article className="claude-profile" aria-label={displayName} data-enabled={profile.enabled}>
    <div className="claude-profile-heading">
      <span className="claude-profile-avatar" aria-hidden="true"><img src={crabIcon} alt="" /></span>
      <div className="claude-profile-identity">
        {renaming ? <form className="claude-profile-rename" onSubmit={(e) => {
          e.preventDefault();
          perform(async () => { await change({ action: "update", id: profile.id, label: savedLabel }); setRenaming(false); });
        }}>
          <input autoFocus aria-label="Заметка к аккаунту" maxLength={64} placeholder={profile.email || "Название аккаунта"} value={label} onChange={(e) => setLabel(e.target.value)} />
          <button disabled={busy || !savedLabel} aria-label="Сохранить заметку"><Check size={15} /></button>
          <button type="button" disabled={busy} onClick={() => setRenaming(false)}>Отмена</button>
        </form> : <div className="claude-profile-name">
          <h4 title={displayName}>{displayName}</h4>
          {profile.plan && <span className="claude-profile-plan">{profile.plan}</span>}
          <button type="button" className="icon-button" disabled={busy} aria-label={`Изменить заметку для ${displayName}`}
            onClick={() => { setLabel(profile.label === profile.email ? "" : profile.label || ""); setRenaming(true); }}><Pencil size={14} /></button>
        </div>}
        <div className="claude-profile-meta">
          <span className="claude-profile-status" data-ready={profile.status === "ready"}>{statusLabels[profile.status] || "Состояние неизвестно"}</span>
          {profile.email && <span className="claude-profile-email" title={[profile.email, profile.organization].filter(Boolean).join(" · ")}>
            {[profile.email !== displayName && profile.email, profile.organization].filter(Boolean).join(" · ")}
          </span>}
        </div>
      </div>
      <label className="check-line claude-participation">
        <input type="checkbox" aria-label="Участвовать в автоматическом распределении" checked={profile.enabled} disabled={busy}
          onChange={(e) => { const enabled = e.target.checked; perform(() => change({ action: "update", id: profile.id, enabled })); }} />
        <span className="claude-switch-track" aria-hidden="true" />
        <span>{profile.enabled ? "Участвует" : "Приостановлен"}</span>
      </label>
    </div>
    <ProfileUsage quota={profile.quota} state={usage.state} />
    <form className="claude-handoff-group" onSubmit={event => { event.preventDefault(); perform(() => change({action:"update",id:profile.id,handoff_group:group})); }}>
      <label>Группа продолжения<input aria-label={`Группа продолжения ${displayName}`} value={group} maxLength={32} placeholder="Без группы, без продолжения между аккаунтами" onChange={event => setGroup(event.target.value)} /></label>
      <button disabled={busy || group === (profile.handoff_group || "")}>Сохранить группу</button>
    </form>
    {active > 0 && <p className="claude-profile-note">Терминалов активно: {active}{!fromTerminal && "; после закрытия можно войти снова"}</p>}
    {!fromTerminal && defaultActive > 0 && <p className="field-help">
      Из них рабочих терминалов, использующих вход обычного терминала: {defaultActive}. Если аккаунт обычного терминала сменился, откройте эти сеансы заново, чтобы подтвердить личность.
    </p>}
    {fromTerminal && ["changed", "signed_out"].includes(profile.status) && <p className="field-help">
      {profile.status === "changed" ? "В обычном терминале сменился аккаунт, поэтому этот аккаунт временно не участвует в распределении. Новую личность нужно добавить отдельно." : "Выполнен выход из обычного терминала. Чтобы продолжить пользоваться этим аккаунтом, сначала войдите снова под исходной личностью."}
      {active > 0 && " Исходные рабочие терминалы сохраняют метку первого распределения. Откройте рабочие сеансы заново, чтобы подтвердить личность."}
    </p>}
    {!fromTerminal && profile.status === "changed" && <p className="field-help">Войдите снова под исходным аккаунтом. Чтобы использовать новую личность, нажмите «Войти в новый аккаунт».</p>}
    {profile.status === "duplicate" && <p className="field-help">Одна подписка участвует в распределении только один раз. Войдите здесь в другой аккаунт.</p>}
    <div className="claude-profile-actions">
      {fromTerminal ? <span className="claude-profile-source">Аккаунт обычного терминала</span> :
        <button className="quiet-button" disabled={busy || !!environment || active > 0} onClick={() => perform(() => login(profile.id))}>
          <TerminalSquare size={14} />{profile.status === "ready" ? "Войти снова" : "Открыть терминал входа"}</button>}
      <button className="quiet-button" disabled={busy || !!usageEnvironment || usage.state === "checking"} onClick={usage.check}>
        <RefreshCw size={14} />Проверить состояние</button>
      {!fromTerminal && !profile.email && !active && ["pending", "signed_out", "duplicate"].includes(profile.status) &&
        <button className="text-button" disabled={busy} onClick={() => perform(() => cancelDraft(profile))}>Отменить добавление</button>}
      <UsageNote profile={profile} state={usage.state} />
    </div>
  </article>;
}

export function ClaudeAccountsPanel({ store, running, environmentBusy, tabs, login, onConfirm }) {
  const { accounts, detected, detectionStatus, detectionError, loginNotice, usageRunning, usageUnavailable, load, error } = store;
  const [busy, setBusy] = useState(false);
  const [requestingUsage, setRequestingUsage] = useState(false);
  const [actionError, setActionError] = useState("");
  const visibleProfiles = useMemo(() => detected ? [detected, ...(accounts || [])] : accounts, [accounts, detected]);
  const environment = !running || detectionStatus === "offline" ? "offline" :
    detectionStatus === "update_required" ? "update_required" : "";
  const usageEnvironment = environment || (usageUnavailable ? "blocked" : "");
  const checking = !usageEnvironment && (usageRunning || visibleProfiles?.some((profile) => profile.usage_checking));
  const activeCounts = useMemo(() => {
    const counts = new Map();
    for (const tab of tabs) {
      if (!tab.claude_account_id || tab.closed) continue;
      const count = counts.get(tab.claude_account_id) || { all: 0, fromDefault: 0 };
      count.all++;
      if (tab.claude_account_source === "default") count.fromDefault++;
      counts.set(tab.claude_account_id, count);
    }
    return counts;
  }, [tabs]);
  useEffect(() => {
    let requested = false, mounted = true;
    const openPanel = () => {
      if (requested || document.hidden) return;
      requested = true;
      setRequestingUsage(running);
      if (running) {
        load({ action: "usage_panel" })
          .catch(() => {})
          .finally(() => { if (mounted) setRequestingUsage(false); });
      } else load();
    };
    openPanel();
    document.addEventListener("visibilitychange", openPanel);
    return () => { mounted = false; document.removeEventListener("visibilitychange", openPanel); };
  }, [load, running]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) load(undefined, true); }, checking ? 2000 : 12000);
    return () => clearInterval(timer);
  }, [load, checking]);
  const perform = async (operation) => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try { await operation(); }
    catch (e) { setActionError(e.message); }
    finally { setBusy(false); }
  };
  const cancelDraft = async (profile) => {
    const last = accounts.length === 1;
    if (await onConfirm({ title: `Отменить добавление «${profile.label}»?`,
      body: last
        ? "Это последний аккаунт в списке. После отмены новые терминалы Claude будут использовать исходный вход среды. Данные в виртуальной машине сохранятся."
        : "Аккаунт будет удалён из списка; данные в виртуальной машине сохранятся.",
      confirm: "Отменить добавление" })) {
      await load({ action: "cancel", id: profile.id });
    }
  };
  const joinDetected = async () => {
    try { await load({ action: "join", identity: detected.identity }); }
    catch (e) {
      await load(); // The identity shown when the user clicked may no longer be signed in.
      throw e;
    }
  };
  return <section className="claude-profiles" aria-label="Управление аккаунтами Claude">
    <div className="section-title">
      <h3>Аккаунты Claude</h3>
      <p>Добавьте в распределение подписку, в которой уже выполнен вход в обычном терминале, или войдите в новый аккаунт отдельно. При создании терминала Claude аккаунт назначается автоматически.</p>
    </div>
    <details className="claude-scheduling">
      <summary>Настройки распределения · {store.scheduling.mode === "sequential" ? "Сначала по порядку" : "Равномерное распределение"}</summary>
      <label>Распределение новых сеансов<InlineSelect aria-label="Распределение новых сеансов" value={store.scheduling.mode} disabled={busy}
        onValueChange={mode => perform(() => load({action:"scheduling",scheduling:{...store.scheduling,mode}}))}>
        <option value="balanced">Равномерное распределение</option><option value="sequential">Сначала по порядку в списке</option>
      </InlineSelect></label>
      <label>Переключение для новых сеансов<InlineSelect aria-label="Переключение для новых сеансов" value={store.scheduling.switch_policy} disabled={busy}
        onValueChange={switch_policy => perform(() => load({action:"scheduling",scheduling:{...store.scheduling,switch_policy}}))}>
        <option value="ask">Спрашивать каждый раз</option><option value="allow">Продолжать автоматически после исчерпания квоты</option><option value="wait">Всегда ждать исходный аккаунт</option>
      </InlineSelect></label>
      <p className="field-help">Существующие сеансы сохраняют исходный аккаунт и разрешение. Автоматическое продолжение выполняется только при подтверждённом лимите, безопасной остановке исходной задачи и принадлежности целевого аккаунта к той же группе продолжения; при смене аккаунта кэш может быть перестроен.</p>
      {store.scheduling.mode === "sequential" && accounts?.length > 1 && <div className="claude-account-order" aria-label="Приоритет аккаунтов">
        {accounts.map((profile,index) => <div key={profile.id}><span>{index+1}. {profile.label || profile.email}</span>
          <button disabled={busy || index===0} aria-label={`Повысить приоритет ${profile.label}`} onClick={() => {
            const order=accounts.map(a=>a.id); [order[index-1],order[index]]=[order[index],order[index-1]];
            perform(() => load({action:"scheduling",scheduling:store.scheduling,order}));
          }}>Выше</button></div>)}
      </div>}
    </details>
    <div className="claude-add-profile">
      <button className="primary" disabled={busy || environmentBusy || !!environment}
        onClick={() => perform(() => login())}><Plus size={16} />Войти в новый аккаунт</button>
    </div>
    {(actionError || error) && <p className="account-error" role="alert">{actionError || error}</p>}
    {loginNotice && <p className="claude-profile-note" role="status">{loginNotice}</p>}
    {detectionError && <p className="account-error" role="alert">{detectionError}</p>}
    {usageUnavailable && !environment && <p className="claude-profile-note" role="status">{usageUnavailable}</p>}
    {!running ? <p className="claude-profile-note">После запуска среды Cage можно обнаружить вход обычного терминала или войти в новый аккаунт.</p> :
      detectionStatus === "offline" ? <p className="claude-profile-note">После готовности рабочей среды можно обнаруживать аккаунты и входить в них.</p> :
      detectionStatus === "signed_out" && <p className="claude-profile-note">В обычном терминале ещё не выполнен вход в подписку Claude. Там можно запустить <code>claude auth login</code>; после входа аккаунт появится здесь.</p>}
    <div className="claude-list-heading">
      <h4>Список аккаунтов <span>{visibleProfiles?.length ?? "—"}</span></h4>
      {requestingUsage || checking ? <small role="status">{requestingUsage ? "Запрос использования аккаунтов…" : "Проверка использования аккаунтов…"}</small> :
        accounts?.length > 0 && <small>В распределении: {accounts.filter((a) => a.enabled).length}</small>}
    </div>
    <div className="claude-profile-list" role="region" aria-label="Список аккаунтов" tabIndex={0}>
      {accounts === null && !error && <p role="status">Чтение аккаунтов…</p>}
      {accounts?.length === 0 && !detected && <div className="claude-profile-empty">
        <img src={crabIcon} alt="" /><p>Аккаунтов в распределении пока нет.</p><small>Пока не добавлен первый аккаунт, новые терминалы используют исходный вход среды.</small>
      </div>}
      <QuotaClock accounts={visibleProfiles}>
        {detected && <DetectedProfile key={detected.identity} profile={detected} usageEnvironment={usageEnvironment} busy={busy || environmentBusy || !!environment}
          perform={perform} change={load}
          join={() => perform(joinDetected)} />}
        {accounts?.map((profile) => <ProfileCard key={profile.id} profile={profile} environment={environment} usageEnvironment={usageEnvironment}
          busy={busy || environmentBusy} perform={perform} change={load} login={login} cancelDraft={cancelDraft}
          active={activeCounts.get(profile.id)?.all || 0} defaultActive={activeCounts.get(profile.id)?.fromDefault || 0} />)}
      </QuotaClock>
    </div>
  </section>;
}
