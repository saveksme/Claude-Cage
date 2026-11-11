import React from "react";
import { SafetyMessage } from "./safety-message";
import { ArrowDownToLine, Box, Layers3, PackageOpen, SlidersHorizontal } from "lucide-react";
import "./setup-progress.css";

const stages = [
  ["image", "Системный образ", ArrowDownToLine],
  ["packages", "Системное ПО", Layers3],
  ["tools", "Инструменты разработки", PackageOpen],
  ["services", "Службы среды", SlidersHorizontal],
];

function bytes(value) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${Number(value.toFixed(unit && value < 100 ? 1 : 0))} ${units[unit]}`;
}

export function SetupProgress({ job, onDetails, onStop, onRetry, disconnected }) {
  const { phase, label, received, total, bytes_per_second, operation } = job.setup_progress;
  const native = job.kind === "guest-install";
  const windows = native && job.setup_progress.system === "windows-11";
  const stage = stages.find(([key]) => key === phase);
  const Icon = stage?.[2] || Box;
  const hasBytes = Number.isFinite(received) && received >= 0;
  const knownSize = hasBytes && Number.isFinite(total) && total > 0 && received <= total;
  const percent = knownSize ? Math.floor(received / total * 100) : null;
  const failed = Boolean(job.error);
  const waitingForWindows = windows && operation === "oobe";
  const canContinue = failed || (waitingForWindows && !job.running);
  const meter = knownSize ? `${bytes(received)} / ${bytes(total)}` : hasBytes ? `Получено ${bytes(received)}` : "";
  return <section className={`setup-progress${failed ? " setup-progress-failed" : ""}`} aria-label="Ход установки среды">
    <ol className="setup-stages" aria-label="Этапы установки">
      {stages.map(([key, name]) => <li key={key} aria-current={key === phase ? "step" : undefined}>{native && key === "image" ? "Материалы установки" : native && key === "packages" ? "Установка системы" : name}</li>)}
    </ol>
    <div className="setup-transfer">
      <div className="setup-transfer-heading">
        <span className="setup-transfer-icon"><Icon size={19} aria-hidden="true" /></span>
        <div className="setup-transfer-description">
          <h2>{label || stage?.[1] || "Подготовка среды"}</h2>
          {meter && <span className="setup-transfer-bytes">{meter}</span>}
          {hasBytes && operation !== "verify" && Number.isFinite(bytes_per_second) && bytes_per_second > 0 && <span className="setup-transfer-bytes"> · {bytes(bytes_per_second)}/s</span>}
        </div>
        {knownSize && <strong className="setup-transfer-number">{percent}<small>%</small></strong>}
      </div>
      {!failed && !waitingForWindows && <div role="progressbar" aria-label={label || stage?.[1] || "Текущая операция"}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
        aria-valuetext={knownSize ? `${percent}%, ${meter}` : meter || undefined}
        className={knownSize ? "setup-meter" : "setup-meter setup-meter-active"}>
        <span style={knownSize ? { width: `${received / total * 100}%` } : undefined} />
      </div>}
      {windows && operation === "account" && <p className="setup-transfer-hint">Задайте новое имя локального администратора и пароль для виртуальной Windows. После установки войдите с этим аккаунтом в гостевую систему и введите его снова при продолжении установки.</p>}
      {waitingForWindows && <p className="setup-transfer-hint">В окне подключения к виртуальной машине (VMConnect) выберите версию Windows, диск и регион, войдите в рабочий стол с локальным администратором, заданным перед установкой, затем вернитесь в Cage и продолжите. Окно создания PowerShell закроется автоматически.</p>}
      {windows && operation === "credentials" && <p className="setup-transfer-hint">Убедитесь, что гостевая система вошла в рабочий стол, и введите аккаунт администратора гостевой системы в окне установки PowerShell. Не закрывайте это окно до завершения установки компонентов.</p>}
      {windows && ["media", "tools", "services"].includes(operation) && <p className="setup-transfer-hint">Не закрывайте окно установки PowerShell: после установки компонентов Cage закроет его автоматически.</p>}
      {failed && <>
        <p className="setup-transfer-error" role="alert"><SafetyMessage message={job.error} /></p>
        <p className="setup-transfer-hint">Можно продолжить установку вручную; сохранённые загрузки будут возобновлены.</p>
      </>}
    </div>
    <div className="setup-transfer-actions">
      <button className="text-button" type="button" onClick={onDetails}>Подробности операции</button>
      {canContinue
        ? <button type="button" className="primary" onClick={onRetry} disabled={disconnected}>{waitingForWindows && !failed ? "Рабочий стол открыт, продолжить установку" : "Продолжить установку"}</button>
        : <button type="button" onClick={onStop} disabled={disconnected}>Остановить установку</button>}
    </div>
  </section>;
}
