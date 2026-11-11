import React, { useEffect, useState } from "react";
import { api } from "./api";
import { SafetyMessage } from "./safety-message";

const gib = (bytes) => `${(bytes / 1073741824).toFixed(1)} GiB`;
const allocationFrom = (data) => ({ automatic: data.automatic, memory_gib: data.memory_gib, cpus: data.cpus });

export function ResourceSettings({ status, onConfirm, onDirtyChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [starting, setStarting] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data && data.runtime !== "container") setDraft((current) => current || allocationFrom(data));
  }, [data]);
  const save = async (event) => {
    event.preventDefault();
    setStarting(true);
    setSaved(false);
    try {
      await api("/environment/resources", { allocation: draft });
      const next = await api("/environment/resources");
      setData(next);
      setDraft(allocationFrom(next));
      setSaved(true);
      setError("");
    } catch (e) { setError(e.message); }
    finally { setStarting(false); }
  };
  useEffect(() => {
    let live = true;
    let timer;
    const refresh = async () => {
      try {
        const next = await api("/environment/resources");
        if (live) { setData(next); setReadError(""); }
      } catch (e) { if (live) setReadError(e.message); }
      if (live) timer = setTimeout(refresh, 4000);
    };
    refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [status.vm_running, status.job?.running]);
  const apply = async () => {
    if (!(await onConfirm({
      title: "Перезапустить и применить сохранённые ресурсы?",
      body: "Выполняемые команды завершатся, браузер и редактор перезапустятся. Сначала сохраните данные; файлы проектов и данные входа сохранятся. Вручную приостановленная сеть останется приостановленной.",
      confirm: "Перезапустить и применить",
    }))) return;
    setStarting(true);
    try { await api("/environment/resources", {}); setError(""); }
    catch (e) { setError(e.message); }
    finally { setStarting(false); }
  };
  const observation = data?.observation;
  const guest = observation?.guest;
  const macOS = data?.runtime === "vz-macos";
  const fresh = observation && Date.now() - Date.parse(observation.observed_at) < 10000;
  const resourceError = error || readError || data?.resource_error;
  const resourcesVerified = data?.resources_verified === true && !resourceError;
  const busy = starting || status.job?.running;
  const dirty = draft && data && (draft.automatic !== data.automatic || (!draft.automatic && (draft.memory_gib !== data.memory_gib || draft.cpus !== data.cpus)));
  useEffect(() => {
    onDirtyChange?.(Boolean(dirty));
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const edit = (key, value) => {
    setDraft((current) => ({ ...current, automatic: false, [key]: value === "" ? "" : Number(value) }));
    setSaved(false);
  };
  const reset = () => {
    setDraft({ automatic: true, memory_gib: data.recommended_memory_bytes / 1073741824, cpus: data.recommended_cpus });
    setSaved(false);
    setError("");
  };
  if (data?.runtime === "container") return <section className="environment-versions" aria-label="Вычислительные ресурсы">
    <h4>Лимиты ресурсов контейнера сервера</h4>
    <p className="field-help">CPU, память и число процессов ограничены группой ресурсов контейнера на сервере.</p>
    <div className="setting-summary-row"><span>Проверка лимитов ресурсов</span><strong>{data.running ? resourcesVerified ? "Проверено" : "Проверка не пройдена" : "Среда не запущена"}</strong></div>
    <div className="setting-summary-row"><span>Лимит памяти контейнера</span><strong>{data.running ? resourcesVerified ? gib(data.configured_memory_bytes) : "Не проверено" : gib(data.recommended_memory_bytes)}</strong></div>
    <div className="setting-summary-row"><span>Лимит CPU контейнера</span><strong>{data.running ? resourcesVerified ? `${data.configured_cpus} логических ядер` : "Не проверено" : `${data.recommended_cpus} логических ядер`}</strong></div>
    <div className="setting-summary-row"><span>Лимит процессов и потоков</span><strong>{data.running ? resourcesVerified ? data.pids_limit : "Не проверено" : "Проверка после запуска"}</strong></div>
    <p className="field-help">{data.running ? resourcesVerified ? "Фактические лимиты группы ресурсов контейнера проверены на сервере. Данные о текущем потреблении памяти и CPU пока недоступны." : "Не удалось подтвердить фактические лимиты работающего контейнера. Проверьте ошибку ниже или дождитесь повторной проверки." : "Среда не запущена; показаны лимиты из конфигурации развёртывания."}</p>
    {resourceError && <p role="alert" className="error-message"><SafetyMessage message={resourceError} /></p>}
  </section>;
  return <section className="environment-versions resource-settings" aria-label="Вычислительные ресурсы">
    <h4>Вычислительные ресурсы</h4>
    <p className="field-help resource-intro">По умолчанию используется половина ресурсов хоста; их можно изменить ниже. {macOS ? "Гостевая macOS использует фиксированный объём памяти при запуске." : "Память выделяется по мере необходимости и постепенно возвращается хосту после длительного простоя."} CPU используется по фактической нагрузке.</p>
    {draft ? <form className="resource-allocation" onSubmit={save}>
      <fieldset disabled={busy} className="resource-fields">
        <legend className="sr-only">Конфигурация ресурсов</legend>
        <label><span>Память{macOS ? " (объём)" : " (лимит)"}</span>
          <span className="resource-input"><input aria-label="Лимит памяти (GiB)" aria-describedby="resource-memory-help" type="number" min={data.min_memory_gib || 2} max={data.max_memory_gib} step="1" required value={draft.memory_gib} onChange={(e) => edit("memory_gib", e.target.value)} /><span aria-hidden="true">GiB</span></span>
          <small id="resource-memory-help">По умолчанию {gib(data.recommended_memory_bytes)} · диапазон {data.min_memory_gib || 2}–{data.max_memory_gib} GiB</small>
        </label>
        <label><span>Лимит CPU</span>
          <span className="resource-input"><input aria-label="Число логических ядер CPU" aria-describedby="resource-cpu-help" type="number" min={data.min_cpus || 1} max={data.max_cpus} step="1" required value={draft.cpus} onChange={(e) => edit("cpus", e.target.value)} /><span aria-hidden="true">логических ядер</span></span>
          <small id="resource-cpu-help">По умолчанию {data.recommended_cpus} · диапазон {data.min_cpus || 1}–{data.max_cpus}</small>
        </label>
      </fieldset>
      <div className="resource-actions">
        <span className="resource-mode">{draft.automatic ? "Конфигурация по умолчанию" : "Своя конфигурация"}{dirty ? " · не сохранено" : ""}</span>
        <button className="text-button" type="button" disabled={busy || draft.automatic} onClick={reset}>Вернуть по умолчанию</button>
        <button type="submit" disabled={busy || !dirty}>{starting ? "Сохранение…" : "Сохранить ресурсы"}</button>
      </div>
      <p role={saved ? "status" : undefined} className="field-help resource-save-note">{saved ? "Сохранено." : "После сохранения"}{data.running ? " Изменения вступят в силу после перезапуска среды." : " изменения вступят в силу при следующем запуске среды."}</p>
    </form> : !resourceError && <p role="status" className="field-help">Чтение конфигурации ресурсов…</p>}
    {macOS && data.minimum_requirements?.source === "existing-configuration" && <p className="field-help resource-minimum-note">Текущий минимум взят из существующей конфигурации запуска. Минимальные требования Apple ещё не прочитаны из исходного образа восстановления.</p>}
    {data?.running && <div className="resource-runtime">
      <div className="resource-runtime-heading"><h5>Текущий запуск</h5>{data.restart_required && <button className="text-button" disabled={busy} onClick={apply}>Перезапустить и применить сохранённую конфигурацию</button>}</div>
      <div className="setting-summary-row"><span>Лимит памяти текущего запуска</span><strong>{gib(data.configured_memory_bytes)}</strong></div>
      <div className="setting-summary-row"><span>Лимит CPU текущего запуска</span><strong>{data.configured_cpus} логических ядер</strong></div>
      <div className="setting-summary-row"><span>{macOS ? "Использование памяти средой (оценка)" : "Использование памяти средой"}</span><strong>{fresh && guest ? gib(guest.total_bytes - guest.available_bytes) : "Ожидание замера"}</strong></div>
      <div className="setting-summary-row"><span>{macOS ? "Объём физической памяти гостевой системы" : "Общий объём доступной памяти среды"}</span><strong>{fresh && guest ? gib(guest.total_bytes) : "—"}</strong></div>
      <div className="setting-summary-row"><span>Загрузка CPU</span><strong>{fresh && Number.isFinite(observation.cpu_percent) ? `${observation.cpu_percent.toFixed(0)}% / ${observation.cpus} ядер` : "Ожидание замера"}</strong></div>
      {fresh && guest?.oom_kills > 0 && <p className="field-help" role="status">С момента запуска среды система завершила {guest.oom_kills} процессов из-за нехватки памяти. Уменьшите число параллельных тяжёлых задач или используйте хост с большей памятью.</p>}
      {(observation?.pressure || observation?.host_pressure) && <p className="field-help" role="status">{macOS ? "Давление на память гостевой системы растёт. Уменьшите число параллельных задач или сохраните работу, измените лимит памяти и перезапустите." : observation.host_pressure ? "Хосту не хватает памяти; повремените с увеличением выделения." : "Среде не хватает памяти; доступный объём увеличивается в пределах лимита. После достижения лимита уменьшите число одновременных задач."}</p>}
    </div>}
    {(resourceError || observation?.error) && <p role="alert" className="error-message"><SafetyMessage message={resourceError || observation.error} /></p>}
    {data?.running && <details className="resource-observation-note"><summary>О показателях ресурсов</summary><p className="field-help">{macOS ? "Оценка памяти использует физический объём гостевой системы минус свободные и неактивные страницы; сжатые страницы учитываются как использованные. CPU рассчитывается по двум последовательным замерам счётчиков Mach. Счётчик завершений из-за OOM пока недоступен. Системный монитор хоста дополнительно учитывает накладные расходы виртуализации." : data.runtime === "hyperv" ? "Данные о памяти и CPU получены из наблюдений гостевой Windows. Hyper-V выделяет и освобождает память в заданных пределах; системный монитор хоста дополнительно учитывает накладные расходы виртуализации." : "Потребление памяти не включает кэш, который может быть освобождён; значения отражают состояние внутри среды, а системный монитор хоста дополнительно учитывает накладные расходы виртуализации."}</p></details>}
  </section>;
}
