import React from "react";
import { MacOSLogin } from "./macos-login";

// Recovery codes come from the operation that failed. Project status also
// supports restoring the flow after the in-memory job has been replaced.
export function initializationRecovery(status) {
  if (status?.guest_system !== "macos") return null;
  const workspace = status.workspace || status.environment_directory;
  const failure = status.project_errors?.find(item => item.path === workspace);
  if (failure) return { ...failure, workspace };
  if (status.job?.error && status.job.recovery) return { recovery: status.job.recovery, message: status.job.error, workspace: status.job.workspace || workspace };
  return { workspace };
}

export function InitializationChecks({ status, busy, onWorkspace, onCheck, onStart, onRestart, onUpdate, onDiagnostics }) {
  const recovery = initializationRecovery(status);
  const code = recovery?.recovery;
  const workspaceChecked = !code && status.safety?.report?.checks?.some(check => check.id === "filesystem_boundary" && check.state === "passed");
  return <section className="initialization-notice" aria-label="Завершение проверок установки">
    <h2>{code === "project-approval" ? "Разрешить виртуальному Mac доступ к рабочей области" : code === "guest-login" ? "Сначала войдите в виртуальный Mac" : code === "filesystem-permission" ? "Сначала включите разрешение общего доступа к файлам" : "Завершите проверку рабочей области и сети"}</h2>
    <p>{recovery?.message || status.job?.error || status.safety?.error || "Система установлена. Теперь убедитесь, что общая рабочая область доступна, затем проверьте выход прокси и изоляцию среды."}</p>
    {recovery?.workspace && <p className="macos-approval-path">{recovery.workspace}</p>}
    {code === "project-approval" && <p>Нажмите кнопку ниже, чтобы открыть окно авторизации в Cage. В окне нажмите Use Project (использовать проект); после проверки продолжится проверка сети.</p>}
    {code === "filesystem-permission" && <p>В виртуальном Mac включите оба переключателя macFUSE и macFUSE (local), затем вернитесь сюда и продолжите.</p>}
    {code === "guest-login" && <MacOSLogin disabled={busy} onSessionClosed={onCheck} />}
    {code === "filesystem-permission" && <MacOSLogin maintenance="projects" disabled={busy} onSessionClosed={onCheck} />}
    <div className="initialization-recovery">
      {["environment-update", "environment-restart"].includes(code) ? <>
        {code === "environment-update" && <button className="primary" disabled={busy} onClick={onUpdate}>Синхронизировать компоненты среды</button>}
        <button disabled={busy} onClick={code === "environment-restart" ? onRestart : onStart}>{code === "environment-restart" ? "Сохранить, перезапустить и проверить" : "Переподключиться и проверить"}</button>
      </> : <button className="primary" disabled={busy || !status.ready} onClick={() => workspaceChecked ? onCheck() : onWorkspace(recovery?.workspace)}>{code === "project-approval" ? "Открыть авторизацию рабочей области" : workspaceChecked ? "Повторить проверку сети и изоляции" : "Подключить рабочую область и продолжить проверку"}</button>}
      {code === "project-directory" && <button disabled={busy} onClick={onDiagnostics}>Посмотреть диагностику</button>}
    </div>
    <p className="mac-setup-retention">До успешной проверки внешний доступ гостевой системы остаётся закрытым. Авторизацию и проверки можно повторить; установка и личные файлы сохранятся.</p>
  </section>;
}

export function InitializationDetails({ status }) {
  const job = status?.job || {};
  const reasons = [...new Set([job.error, status?.safety?.error, status?.network_error].filter(Boolean))];
  const checks = status?.safety?.report?.checks || [];
  const labels = { passed: "Пройдено", failed: "Не пройдено", unknown: "Ещё не завершено" };
  return <div className="modal-body">
    <p>{job.running ? "Текущая операция" : "Последняя операция"}: {job.message || "Ещё не начата"}</p>
    {reasons.map(reason => <p key={reason} role="alert">{reason}</p>)}
    {checks.length > 0 && <><h3>Результаты последней проверки</h3><ol className="initialization-checks">{checks.map(check => <li key={check.id}>
      <strong>{check.title} · {labels[check.state] || "Ещё не завершено"}</strong>
      <p>{check.evidence}</p>{check.state !== "passed" && check.remedy && <p>{check.remedy}</p>}
    </li>)}</ol></>}
    <h3>Журнал операций</h3><pre className="job-log">{job.log || "Для текущей операции нет дополнительных записей. Причина сбоя показана выше; полный журнал можно экспортировать в разделе «Журналы и диагностика»."}</pre>
  </div>;
}
