import React, { useEffect, useState } from "react";
import { api } from "./api";
import { SafetyMessage } from "./safety-message";

export function EnvironmentVersions({ status, onConfirm }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false), [starting, setStarting] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try { setData(await api("/environment/versions")); setError(""); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let live = true;
    setLoading(true);
    api("/environment/versions")
      .then((next) => { if (live) { setData(next); setError(""); } })
      .catch((e) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [status.vm_running, status.job?.running]);
  const busy = Boolean(status.job?.running) || starting;
  const update = async (tools) => {
    if (!(await onConfirm({
      title: tools ? "Обновить инструменты среды?" : "Обновить компоненты среды?",
      body: data?.maintenance?.native
        ? "Сначала сохраните данные и завершите работающие терминалы и сеансы Claude Code. Обновление перезапустит браузер, редактор и подключение к общим файлам; история чатов, файлы проектов и данные входа сохранятся." + (data.maintenance.guest_system === "windows-11" ? "Подтвердите в системном запросе разрешение на управление хостом и проверьте учётную запись администратора, привязанную к гостевой системе." : "")
        : "Сначала сохраните данные в браузере и редакторе. Браузер и редактор ненадолго перезапустятся, терминалы внутри редактора могут завершиться; терминалы рабочей среды, файлы проектов и состояние входа сохранятся.",
      confirm: tools ? "Обновить инструменты" : "Обновить компоненты",
    }))) return;
    setStarting(true); setError("");
    try { await api(tools ? "/environment/tools" : "/environment/update", {}); }
    catch (e) { setError(e.message); }
    finally { setStarting(false); }
  };
  const componentLabels = { current: "Синхронизировано", update_required: "Требуется обновление", stopped: "Среда остановлена", unknown: "Пока не удаётся определить" };
  const toolNames = { chromium: "Браузер", code_server: "Редактор файлов", claude: "Claude Code", mise: "Менеджер версий инструментов", node: "Node.js", python: "Python", git: "Git", gh: "GitHub CLI", proxy: "Ядро прокси" };
  return (
    <section className="environment-versions" aria-label="Версии среды">
      <h4>Версии и компоненты</h4>
      <div className="setting-summary-row"><span>Служба управления</span><strong>{data?.controller?.version || "—"}</strong></div>
      <div className="setting-summary-row"><span>Компоненты среды</span><strong>{componentLabels[data?.components?.status] || (loading ? "Чтение…" : "Пока не удаётся определить")}</strong></div>
      {data?.tools && <table className="environment-tool-table">
        <thead><tr><th>Инструмент</th><th>Текущая версия</th><th>Управляемая версия</th></tr></thead>
        <tbody>{Object.entries(toolNames).filter(([key]) => data.tools[key]).map(([key, name]) => <tr key={key}><td>{name}</td><td>{data.tools[key]?.current || "—"}</td><td>{data.tools[key]?.required || "—"}</td></tr>)}</tbody>
      </table>}
      {(error || data?.error) && <p role="alert" className="error-message"><SafetyMessage message={error || data.error} /></p>}
      <div className="environment-version-actions">
        <button disabled={loading || busy} onClick={refresh}>{loading ? "Чтение…" : "Обновить версии"}</button>
        {data?.components?.update_required && <button className="primary" disabled={busy || !status.vm_running} onClick={() => update(false)}>Обновить компоненты среды</button>}
        <button disabled={busy || !data?.tools_update_allowed} onClick={() => update(true)}>Обновить инструменты среды</button>
      </div>
      <p className="field-help">{data?.maintenance?.native
        ? "Перед обновлением нативных компонентов завершите работающие терминалы и сеансы Claude Code. Системный диск, проекты и данные аккаунта сохранятся; приостановленный внешний доступ останется приостановленным. Пакеты инструментов подготавливаются и проверяются на хосте, затем передаются в гостевую систему."
        : "При обновлении компонентов виртуальный диск и терминалы сохраняются. Для обновления инструментов сначала запустите среду и синхронизируйте компоненты; зависимости загружаются через выбранный прокси. Открывать рабочую сеть не требуется, а приостановленный внешний доступ не восстановится автоматически."}</p>
    </section>
  );
}
