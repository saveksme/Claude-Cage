import React, { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { useAccount } from "./account";
import { MacOSLogin } from "./macos-login";
import { DiagnosticSettings } from "./diagnostics.jsx";
import { Modal } from "./modal";
import "./initialization.css";

const steps = [
  { id: "screen", label: "Запись окна", hint: "Включите запись окна для Cage Guest Window. Если появится предложение «Завершить и открыть заново», следуйте ему." },
  { id: "input", label: "Универсальный доступ", hint: "Включите универсальный доступ для Cage Guest Window, чтобы Cage мог управлять окном гостевой системы." },
  { id: "projects", label: "Расширения файловой системы", hint: "Включите оба переключателя macFUSE и macFUSE (local), чтобы в гостевой системе был доступ к выбранному проекту." },
];

export function MacOSFirstSetup() {
  const { account, refresh } = useAccount();
  const [permissionPage, setPermissionPage] = useState("screen");
  const [state, setState] = useState(null);
  const [permissions, setPermissions] = useState({});
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [completionFailed, setCompletionFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [details, setDetails] = useState(false);
  const current = useRef({ account, refresh });
  current.current = { account, refresh };
  const control = useRef({ active: false, inFlight: false, started: false, finished: false, requested: "", pending: "" });

  async function request(action) {
    const lifecycle = action === "start" || action === "stop";
    const signal = AbortSignal.timeout(action === "finish" ? 60000 : 30000);
    let result;
    try {
      result = await api(lifecycle ? `/${action}` : "/macos/first-setup", action === "start" ? { guest_system: "macos" } : action === "stop" ? {} : { action }, undefined, {}, { signal });
    } catch (e) {
      if (signal.aborted) throw new Error("Истекло время ожидания ответа гостевой системы. Проверьте состояние и убедитесь, что предыдущее действие завершилось, затем продолжите.");
      // A finish response can be lost after the server has closed this entry.
      if (e.status === 410) await current.current.refresh();
      throw e;
    }
    if (result.error) throw new Error(result.error);
    return result;
  }

  // Automatic probes, page changes and explicit retries share one operation slot.
  // A failed probe retains the previous display but cannot advance the workflow.
  async function check() {
    const c = control.current;
    if (c.inFlight || !c.active) return;
    c.inFlight = true;
    setBusy(true);
    try {
      const next = await api("/status", undefined, undefined, {}, { signal: AbortSignal.timeout(15000) });
      if (!c.active) return;
      setState(next);
      const credentialsPending = current.current.account.macos_password_pending;
      if ((!next.vm_running || credentialsPending) && !next.job?.running && !next.job?.error && !next.job?.canceled && !c.started) {
        c.started = true;
        setBusy(true);
        try { await request("start"); }
        catch (e) { if (c.active) setError(e.message); }
        return;
      }
      if (!next.ready || next.job?.running || credentialsPending) { setReadError(""); return; }
      const measured = await request("permissions");
      if (!c.active) return;
      setReadError("");
      setPermissions(measured);
      const pending = steps.find(({ id }) => !measured[id]);
      if (pending && c.pending !== pending.id) {
        c.pending = pending.id;
        setPermissionPage(pending.id);
      }
      if (measured.managed_credential && pending && c.requested !== pending.id) {
        c.requested = pending.id;
        setPermissionPage(pending.id);
        setBusy(true);
        try { await request(pending.id); setError(""); }
        catch (e) { if (c.active) setError(e.message); }
      }
      if (!pending && !c.finished) {
        c.finished = true;
        setBusy(true);
        try { await request("finish"); if (c.active) await current.current.refresh(); }
        catch (e) { if (c.active) { setCompletionFailed(true); setError(e.message); } }
      }
    } catch (e) { if (c.active) setReadError(e.name === "TimeoutError" ? "Истекло время чтения состояния гостевой системы. Проверьте состояние ещё раз; прогресс установки сохранится." : e.message); }
    finally { c.inFlight = false; if (c.active) setBusy(false); }
  }

  useEffect(() => {
    const c = control.current;
    c.active = true;
    let timer;
    async function poll() {
      await check();
      if (c.active) timer = setTimeout(poll, 2000);
    }
    poll();
    window.cageWorkbenchAction = async command => {
      if (command === "closeTab") document.dispatchEvent(new Event("cage-close-modal"));
      if (command === "quit") await native("quitNow");
    };
    window.cageEditAction = () => false;
    if (nativeAvailable()) native("workbenchReady").catch(() => {});
    return () => { c.active = false; clearTimeout(timer); delete window.cageWorkbenchAction; delete window.cageEditAction; };
  }, []);

  async function act(action) {
    const c = control.current;
    if (c.inFlight) return;
    c.inFlight = true;
    if (action === "stop") c.started = true;
    if (steps.some(({ id }) => id === action)) { setPermissionPage(action); c.requested = action; }
    setBusy(true); setError("");
    try {
      await request(action);
      if (action === "finish") { await current.current.refresh(); setCompletionFailed(false); }
    } catch (e) {
      if (action === "finish") setCompletionFailed(true);
      setError(e.message);
    } finally { c.inFlight = false; if (c.active) { setBusy(false); void check(); } }
  }

  const pending = steps.find(({ id }) => !permissions[id]);
  const selected = steps.find(({ id }) => id === permissionPage);
  const running = Boolean(state?.job?.running);
  const canOperate = Boolean(state?.vm_running && !running && !busy);
  const canFinish = Boolean(state?.ready && !account.macos_password_pending && !pending && !readError);
  const progress = !state ? "Чтение хода установки…" : running ? state.job.message || "Запуск и настройка виртуального Mac…" :
    account.macos_password_pending ? "Пароль гостевой системы ещё не синхронизирован. Повторите синхронизацию и продолжите авторизацию." : !state.vm_running ? "Виртуальный Mac ещё не запущен; можно продолжить с существующего диска." :
    !state.ready ? "Виртуальный Mac запущен, ожидается подключение гостевой системы. Если она осталась на экране входа, откройте изображение гостевой системы и войдите." :
    readError ? "Сейчас не удаётся подтвердить состояние разрешений; показанный результат носит справочный характер. После восстановления соединения проверка продолжится." :
    pending ? `Сейчас нужно подтвердить «${pending.label}». После этого Cage проверит автоматически и продолжит.` :
    completionFailed ? "Все три разрешения проверены, но завершающий шаг настройки не выполнен. Повторите завершение настройки." : "Все три разрешения проверены, настройки сохраняются; затем последуют авторизация рабочей области и проверка сети.";
  const controls = <button type="button" className="primary" disabled={!canOperate} onClick={() => act(pending?.id || permissionPage)}>
    {busy ? "Обработка…" : `Открыть: ${pending?.label || selected.label}`}
  </button>;
  const failure = error || readError || (!running && state?.job?.error) || (!state?.ready && state?.environment_update_error);

  return <main className="initialization"><section className="initialization-content mac-setup-content">
    <div className="initialization-title"><p className="mac-setup-eyebrow">Установка и проверка · Разрешения macOS</p><h1>Завершите настройку разрешений виртуального Mac</h1>
      <p>Установочные файлы и диск гостевой системы сохранены. Три разрешения ниже выдаются внутри виртуального Mac; после каждого Cage продолжит автоматически.</p></div>
    <ol className="mac-setup-checklist" aria-label="Ход системных разрешений">
      {steps.map(({ id, label }, index) => <li key={id} data-complete={Boolean(permissions[id])} aria-current={pending?.id === id ? "step" : undefined}>
        <span className="mac-setup-marker">{permissions[id] ? <Check size={16} aria-hidden="true" /> : index + 1}</span>
        <span>{label}</span><small>{permissions[id] ? "Проверено" : pending?.id === id ? "Ожидает подтверждения" : "Проверить позже"}</small>
      </li>)}
    </ol>
    <section className="initialization-operation mac-setup-task" aria-label="Текущий шаг настройки">
      <h2>{!state?.ready ? "Подключение виртуального Mac" : pending ? `Подтверждение: ${pending.label}` : "Завершение системной настройки"}</h2>
      <p role="status">{busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />} {progress}</p>
      {pending && state?.ready && <><p>{selected.hint}</p>{pending.id === "projects" && permissions.projects_error && <p>{permissions.projects_error}</p>}</>}
      <div className="initialization-recovery">
        {state && !running && (!state.ready || account.macos_password_pending || state.job?.error) && <button className="primary" disabled={busy} onClick={() => act("start")}>{account.macos_password_pending ? "Повторить синхронизацию пароля" : "Продолжить запуск и подключение"}</button>}
        {pending && state?.ready && controls}
        {completionFailed && <button className="primary" disabled={busy || !canFinish} onClick={() => act("finish")}>Повторить завершение настройки</button>}
        <button disabled={busy || running} onClick={() => void check()}>Проверить состояние заново</button>
      </div>
      {running && <button disabled={busy} onClick={() => act("stop")}>Остановить текущую операцию, сохранив прогресс</button>}
      {state?.vm_running && <MacOSLogin initialSetup autoOpen={Boolean(permissions.managed_credential)} managedCredential={permissions.managed_credential} disabled={!canOperate}
        label="Открыть изображение гостевой системы" setupActions={controls} setupHint={`${selected.hint} Если система требует администратора, укажите имя cagesetup; выделив поле пароля, нажмите «Заполнить пароль авторизации».`}
        setupStatus={failure || progress} setupError={Boolean(failure)} />}
    </section>
    {failure && <section className="initialization-notice" role="alert"><h2>Этот шаг ещё не завершён</h2><p>{failure}</p><p>Прогресс установки сохранится. Можно заново открыть текущую страницу настроек или проверить состояние и продолжить.</p></section>}
    <details className="mac-setup-help"><summary>Пароль администратора и помощь, если страница настроек не найдена</summary>
      <p>Если система требует администратора, укажите имя <strong>cagesetup</strong>; {account.macos_password_pending ? "до завершения синхронизации может понадобиться прежний пароль гостевой системы." : account.macos_credentials_ready ? "пароль совпадает с паролем аккаунта Cage." : "выделите поле пароля на изображении гостевой системы и нажмите «Заполнить пароль авторизации»."} Продолжайте после вашего подтверждения авторизации; этот временный администратор отключается на завершающем шаге.</p>
      <p>Ручной путь к расширениям файловой системы: в гостевой системе «Системные настройки → Основные → Элементы входа и расширения → По категориям → Расширения файловой системы», включите macFUSE и macFUSE (local).</p>
      <div className="initialization-recovery">{steps.map(({ id, label }) => <button key={id} disabled={!canOperate} onClick={() => act(id)}>Открыть заново: {label}</button>)}</div>
    </details>
    <p className="mac-setup-retention">После системных разрешений будут проверены общая рабочая область и сетевая изоляция. Когда все проверки пройдут, можно войти в рабочую среду.</p>
    <div className="initialization-support"><button className="text-button" onClick={() => setDetails(true)}>Подробности операций</button><button className="text-button" onClick={() => setDiagnostics(!diagnostics)}>Журналы и диагностика</button></div>
    {diagnostics && <DiagnosticSettings />}
    {details && <Modal title="Подробности системных настроек" onClose={() => setDetails(false)}><div className="modal-body"><p>{progress}</p>{failure && <p role="alert">{failure}</p>}<pre className="job-log">{state?.job?.log || "Для текущего шага нет дополнительных журналов операций. Полную запись можно экспортировать через «Журналы и диагностика»."}</pre></div></Modal>}
  </section></main>;
}
