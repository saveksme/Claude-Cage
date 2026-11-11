import React, { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { SafetyMessage } from "./safety-message";

export function EnvironmentStorage({ status, onConfirm }) {
  const [location, setLocation] = useState(null);
  const [pending, setPending] = useState(null);
  const [directory, setDirectory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const job = status.job;
  const recovery = status.storage_recovery?.required ? status.storage_recovery : location?.recovery;
  const storageJob = job?.kind === "storage" || job?.kind === "storage-recovery";
  const busy = submitting || Boolean(pending) || Boolean(job?.running);
  useEffect(() => {
    let live = true;
    if (pending && job?.id === pending.previousJob) return;
    if (storageJob && job.running) return;
    api("/environment/storage").then((next) => {
      if (!live) return;
      setLocation(next);
      if (pending) {
        setPending(null);
        if (job?.id === pending.id && job.error) setError(job.error);
        else if (job?.id === pending.id || next.directory && next.directory === pending.path) { setDirectory(""); setError(""); }
        else setError("Операция завершена. Проверьте текущий каталог среды и повторите.");
      }
    }).catch((e) => {
      if (live) { setError(e.message); setPending(null); }
    });
    return () => { live = false; };
  }, [pending, job?.id, job?.running, storageJob, status.storage_recovery?.required]);

  const choose = async () => {
    setError("");
    try {
      const selected = await native("chooseFolder", { purpose: "environmentStorage" });
      if (selected) setDirectory(selected);
    } catch { setError("Не удалось выбрать папку. Введите абсолютный путь вручную."); }
  };
  const apply = async () => {
    if (!location?.directory || busy || recovery?.required) return;
    const path = directory.trim();
    if (location.has_environment && !(await onConfirm({
      title: "Перенести локальную среду?",
      body: `Сначала сохраните файлы. Cage остановит среду и терминалы, скопирует виртуальный диск в ${path}, проверит его и переключит расположение. Исходные данные останутся как резервная копия; после переноса среду можно запустить вручную.`,
      confirm: "Перенести среду",
    }))) return;
    setSubmitting(true);
    setError("");
    try {
      const accepted = await api("/environment/storage", {
        directory: path, previous: location.directory, migrate: location.has_environment,
      });
      setPending({ id: accepted.id, previousJob: job?.id, path });
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  const recover = async (repair) => {
    if (busy) return;
    setSubmitting(true);
    setError("");
    try {
      const accepted = await api("/environment/storage/recover", { repair });
      setPending({ id: accepted.id, previousJob: job?.id });
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };
  return <section className="environment-versions environment-storage" aria-label="Хранилище локальной среды">
    <h4>Хранилище локальной среды</h4>
    {recovery?.required ? <>
      <p className="field-help">Хранилище среды требует восстановления. Подключите диск, использовавшийся для переноса, и повторите. После восстановления среду можно запустить.</p>
      <p role="alert" className="error-message"><SafetyMessage message={recovery.error} /></p>
      <div className="storage-actions">
        <button type="button" disabled={busy} onClick={() => recover(false)}>Повторить восстановление</button>
        {recovery.repair_allowed && <button type="button" disabled={busy} onClick={() => recover(true)}>Исправить системный помощник и восстановить</button>}
      </div>
      {recovery.repair_allowed && <p className="field-help storage-repair-help">Для исправления системного помощника требуется авторизация Windows. После этого восстановление прежней среды продолжится.</p>}
    </> : <>
    <p className="field-help">Системные образы, кэш загрузок и виртуальные диски можно разместить на другом локальном диске. Файлы проектов хранятся в папках соответствующих проектов.</p>
    <div className="setting-summary-row"><span>Текущий каталог среды</span><strong>{location?.directory || "Чтение…"}</strong></div>
    {status.environment_identity_directory && status.environment_identity_directory !== status.environment_directory &&
      <p className="field-help">Файлы проекта по умолчанию до обновления находятся в <code>{status.environment_identity_directory}</code>, текущий проект по умолчанию — в <code>{status.environment_directory}</code>. Чтобы использовать проекты из старого каталога, переместите их за пределы каталога конфигурации Cage в файловом менеджере хоста, затем откройте из рабочей среды.</p>}
    {location?.backup && <p className="field-help">Резервная копия до переноса сохранена в <code>{location.backup}</code>. Убедившись, что новая среда запускается, а файлы и состояние входа на месте, резервную копию можно удалить.</p>}
    <label>Новое место хранения
      <input value={directory} onChange={(e) => { setDirectory(e.target.value); setError(""); }} spellCheck="false"
        disabled={busy || !location?.directory} placeholder="Полный путь к отдельной пустой папке на локальном диске" />
    </label>
    <div className="storage-actions">
      {nativeAvailable() && <button type="button" disabled={busy || !location?.directory} onClick={choose}><FolderOpen size={15} />Выбрать папку</button>}
      <button type="button" disabled={busy || !location?.directory || !directory.trim() || directory.trim() === location.directory} onClick={apply}>
        {location?.has_environment ? "Перенести сюда" : "Использовать это место"}
      </button>
    </div>
    </>}
    {storageJob && job.running && <p role="status" className="field-help">{job.message}</p>}
    {error && error !== recovery?.error && <p role="alert" className="error-message"><SafetyMessage message={error} /></p>}
  </section>;
}
