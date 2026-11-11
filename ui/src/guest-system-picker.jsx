import React, { useEffect, useRef, useState } from "react";
import { api, native } from "./api";
import { InlineSelect } from "./inline-select";
import "./guest-system-picker.css";

const names = { "debian-12": "Debian 12", "debian-13": "Debian 13", "ubuntu-22.04": "Ubuntu 22.04", "ubuntu-24.04": "Ubuntu 24.04", macos: "macOS", "windows-11": "Windows 11" };
const editions = { Professional: "Профессиональная", ProfessionalN: "Профессиональная N", Enterprise: "Корпоративная", EnterpriseN: "Корпоративная N", Education: "Образовательная", EducationN: "Образовательная N", Core: "Домашняя", CoreSingleLanguage: "Домашняя для одного языка" };
const languages = { "zh-CN": "Китайский (упрощённый)", "zh-TW": "Китайский (традиционный)", "en-US": "Английский (США)" };

export function HostCloneSummary({ pending, onChange }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    api("/environment/guest-systems/clone").then((next) => {
      if (!active) return;
      setResult(next);
      onChange((current) => current?.clone ? { ...current, clone_key: next.key, clone_ready: next.enough_space } : current);
    }).catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [attempt, onChange]);
  if (error) return <div className="guest-install-fields" role="alert"><small>{error}</small>
    <button type="button" onClick={() => { setError(""); retry((value) => value + 1); }}>Проверить снова и подобрать</button></div>;
  if (!result) return <small className="guest-install-fields" role="status">Определение версии системы этого компьютера и подбор официального образа…</small>;
  const plan = result.plan;
  const host = plan.host;
  const download = result.download_bytes > 0 ? `${(result.download_bytes / 1e9).toFixed(2)} GB` : "";
  const source = host.system === "macos" ? "Apple" : host.system === "windows-11" ? "Microsoft" : "официальный репозиторий дистрибутива";
  const cached = Boolean(plan.path || result.download_bytes === 0 && plan.bytes > 0);
  return <div className="guest-install-fields host-clone-summary" aria-live="polite">
    <strong>Будет установлено: {names[host.system]} {host.system === "windows-11" ? `${host.version} · ${editions[host.edition] || host.edition} · ${languages[host.language] || host.language}` : host.system === "macos" ? host.version : ""}</strong>
    <small>{pending ? "Используется образ, выбранный при первом запуске; установка отдельной гостевой системы продолжится." : "Официальный образ подбирается по версии системы этого компьютера и устанавливается в отдельную гостевую систему."}</small>
    {host.build && <small>{pending ? "Номер сборки этого компьютера при первой проверке" : "Номер сборки этого компьютера"} {host.build} · номер сборки образа {plan.build}</small>}
    {host.system === "windows-11" && host.build !== plan.build && <small>Выпуск, редакция и язык Windows совпадают с этим компьютером, но уровень обновления отличается.</small>}
    <small>Приложения, личные файлы и состояние входа этого компьютера не копируются; инструменты, аккаунты и файлы гостевой системы сохраняются.</small>
    <small>{cached ? "Найден подходящий локальный образ; после проверки он будет использован без повторной загрузки." : `Официальный системный образ будет загружен (${source}); ${download ? `осталось загрузить примерно ${download}` : "размер загрузки появится после подключения"}.`}</small>
    <small>{result.installation_started ? "Используется прежний виртуальный диск, ход установки сохраняется." : `Требуется не менее ${result.minimum_free_gib} GiB свободного места; виртуальный диск растёт по мере использования.`} Компоненты рабочей среды, такие как браузер и редактор, загружаются по мере необходимости.</small>
    {!result.enough_space && <small role="alert">Доступно {result.free_gib} GiB. Выберите в настройках хранения место с достаточным объёмом и проверьте снова.</small>}
    {!pending && <button type="button" onClick={() => {
      setResult(null);
      onChange((current) => current?.clone ? { ...current, clone_key: "", clone_ready: false } : current);
      retry((value) => value + 1);
    }}>Проверить снова и подобрать</button>}
  </div>;
}

export function GuestSystemPicker({ system, onChange, preserveOnUnmount = false, deferMatch = false }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const activated = useRef(false);
  useEffect(() => {
    if (!system?.activate || activated.current) return;
    activated.current = true;
    api("/environment/guest-systems/activate",{}).then(() => native("reconnect")).catch(e => setError(e.message));
  }, [system?.activate]);
  useEffect(() => {
    let active = true;
    setError("");
    api("/environment/guest-systems").then((next) => {
      if (!active) return;
      setView(next);
      if (next.fresh || next.pending) {
        onChange(current => !next.pending && current && !current.pending ? current : ({ guest_system: next.pending?.system || "debian-13", media: next.pending?.media || "",
          sha256: next.pending?.sha256 || "", editor_terms: Boolean(next.pending?.editor_terms),
          clone: Boolean(next.pending?.source && !next.pending?.source_kind), clone_key: "", clone_ready: false,
          activate: next.activate, pending: Boolean(next.pending) }));
      } else onChange(null);
    }).catch((e) => {
      if (!active) return;
      if (e.status === 403 || e.status === 404) onChange(null);
      else setError(e.message);
    });
    return () => { active = false; if (!preserveOnUnmount) onChange(undefined); };
  }, [onChange, attempt, preserveOnUnmount]);
  if (!view || !system) return error ? <div className="guest-system-picker"><span role="alert">{error}</span>
    <button type="button" onClick={() => retry((n) => n + 1)}>Проверить варианты установки снова</button></div> : null;
  const os = system.guest_system;
  const change = (changes) => onChange((current) => current?.guest_system === os ? { ...current, ...changes } : current);
  async function choose() {
    try {
      const path = await native("chooseGuestMedia");
      if (path) change({ media: path });
    } catch (e) { setError(e.message); }
  }
  async function reference(kind) {
    try { await native("guestInstallReference", { kind }); }
    catch (e) { setError(e.message); }
  }
  return (
    <div className="guest-system-picker">
      <span>Гостевая система</span>
      <InlineSelect aria-label="Гостевая система" value={system.clone ? "host" : os} disabled={system.pending}
        onValueChange={(value) => onChange({ guest_system: value === "host" ? view.system : value, clone: value === "host", clone_key: "", clone_ready: false, media: "", sha256: "", editor_terms: false })}>
        {Boolean(view.system) && <option value="host" disabled={!view.available}>Автоматически подобрать версию системы этого компьютера{view.available ? "" : " (недоступно)"}</option>}
        <option value="debian-13">Debian 13</option>
        <option value="ubuntu-22.04" disabled={!view.linux_systems?.includes("ubuntu-22.04")}>Ubuntu 22.04{view.linux_systems?.includes("ubuntu-22.04") ? "" : " (недоступно в этой сборке)"}</option>
        <option value="macos" disabled={view.system !== "macos" || !view.available}>macOS{view.system === "macos" ? view.available ? "" : " (недоступно)" : " (требуется Apple Silicon Mac)"}</option>
        <option value="windows-11" disabled={view.system !== "windows-11" || !view.available}>Windows 11{view.system === "windows-11" ? view.available ? "" : " (недоступно)" : " (требуются Windows 11 и Hyper-V)"}</option>
      </InlineSelect>
      {system.clone && !system.activate && (deferMatch ? <small className="guest-install-fields">Cage определит версию системы этого компьютера и на следующем шаге покажет подходящий официальный образ, объём загрузки и требования к месту.</small> : <HostCloneSummary pending={system.pending} onChange={onChange} />)}
      {!system.activate && <small className="guest-install-fields">Системный образ загружается через сеть хоста и подчиняется системному прокси или настройкам TUN хоста, а не прокси гостевой системы Cage. При использовании Clash и подобных программ сначала включите системный прокси или TUN; правила прокси определяют фактический выход к сайту образа.</small>}
      {!system.clone && os !== "debian-13" && !system.activate && <div className="guest-install-fields">
        {os === "ubuntu-22.04" ? <>
          <small>Образ Ubuntu 22.04 LTS загружается из официального источника Ubuntu и проверяется по SHA-256. Cage выбирает ARM64 или x86_64 в зависимости от архитектуры хоста.</small>
          <small>Автоматически устанавливаются инструменты разработки, браузер и редактор. Аккаунты, файлы и состояние входа гостевой системы хранятся на отдельном постоянном виртуальном диске.</small>
          <small>Требуется не менее 17 GiB свободного места. После сбоя установку можно продолжить; система не будет заменена другой и существующая среда не будет перезаписана.</small>
        </> : os === "macos" ? <>
          <small>{system.media || "С Apple будет загружена macOS 26.5.2 (19,77 GB) и создан разреженный виртуальный диск на 64 GiB."}</small>
          {!system.pending && <div>
            <button type="button" onClick={choose}>Выбрать локальный IPSW</button>
            {system.media && <button type="button" onClick={() => change({ media: "" })}>Загрузить вместо этого</button>}
          </div>}
          <small>Cage автоматически подготовит аккаунт гостевой системы и отдельный пароль, сохранит их в зашифрованном виде и будет входить автоматически при запуске.</small>
        </> : <>
          <small>Для Windows 11 x64 требуются Hyper-V и не менее 64 GiB свободного места на диске. Перед установкой задайте локального администратора гостевой системы в окне авторизации; Cage создаст ответ для автономной учётной записи. После входа в рабочий стол гостевой системы вернитесь в Cage и подтвердите установку компонентов с этим аккаунтом. Затем Cage создаст отдельный обычный аккаунт и перезапустит гостевую систему.</small>
          {!system.pending && <div>
            <button type="button" onClick={() => reference("windows-media")}>Загрузить ISO с сайта Microsoft</button>
            <button type="button" onClick={choose}>Выбрать локальный ISO</button>
          </div>}
          {system.media && <small>{system.media}</small>}
          <label>SHA-256 ISO-образа<input value={system.sha256} readOnly={system.pending} spellCheck={false}
            onChange={(e) => change({ sha256: e.target.value.trim() })} placeholder="64-символьная шестнадцатеричная сумма, опубликованная Microsoft" /></label>
          <button type="button" onClick={() => reference("editor-license")}>Прочитать условия лицензии Microsoft VS Code Server</button>
          <label><input type="checkbox" checked={system.editor_terms} disabled={system.pending}
            onChange={(e) => change({ editor_terms: e.target.checked })} />Я принимаю условия лицензии редактора выше</label>
        </>}
      </div>}
      {system.clone && os === "windows-11" && <div className="guest-install-fields">
        <small>При установке потребуется подтвердить авторизацию администратора Windows; затем Cage автоматически установит систему и создаст отдельный аккаунт гостевой системы.</small>
        <button type="button" onClick={() => reference("editor-license")}>Прочитать условия лицензии Microsoft VS Code Server</button>
        <label><input type="checkbox" checked={system.editor_terms} disabled={system.pending}
          onChange={(e) => change({ editor_terms: e.target.checked })} />Я принимаю условия лицензии редактора выше</label>
      </div>}
      {view.reason && !view.available && <small className="guest-install-fields">{view.reason}</small>}
      {view.reselect && <button type="button" className="guest-install-fields" onClick={async () => {
        try {
          await api("/environment/guest-systems", { id: view.pending.id }, "DELETE");
          setView(await api("/environment/guest-systems"));
          onChange({ guest_system: "debian-13", media: "", sha256: "", editor_terms: false });
        } catch (e) { setError(e.message); }
      }}>Выбрать другую систему или образ</button>}
      {system.activate && <small className="guest-install-fields">Гостевая система установлена. Можно открыть рабочую среду.</small>}
      {error && <p role="alert" className="guest-install-fields">{error}</p>}
    </div>
  );
}

export function validGuestChoice(value) {
  if (value?.clone && !value.activate) return Boolean(value.clone_key && value.clone_ready && (value.guest_system !== "windows-11" || value.editor_terms));
  if (!value || value.activate || value.guest_system === "debian-13" || value.guest_system === "ubuntu-22.04") return true;
  if (value.guest_system === "macos") return true;
  return value.media && /^[a-f\d]{64}$/i.test(value.sha256) && value.editor_terms;
}
