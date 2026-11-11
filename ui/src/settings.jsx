import { MobilePairSettings } from "./mobile-pair-settings";
import { ArchivedSessions } from "./cli-sessions";
import { Smartphone } from "lucide-react";
import { PasswordVaultSettings } from "./password-vault";
import { KeyRound } from "lucide-react";
import { InlineSelect } from "./inline-select";
import { clientKeyboard, isRemoteClient, saveClientKeyboard } from "./client-context.mjs";
import { shortcut, usesControl } from "./platform.mjs";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Globe2,
  Clock3,
  FolderOpen,
  Check,
  LoaderCircle,
  RotateCcw,
  ArrowLeft,
  Settings,
  Palette,
  UserRound,
  UsersRound,
  Archive,
} from "lucide-react";
import { api } from "./api";
import { SafetyMessage } from "./safety-message";
import { AppearanceSettings } from "./appearance-settings";
import { ProxySettings } from "./proxy-settings";
import { ExitPolicyFields } from "./exit-policy";
import { canonicalExitPolicy } from "./safety-state.mjs";
import { EnvironmentVersions } from "./environment-versions";
import { EnvironmentStorage } from "./environment-storage";
import { ResourceSettings } from "./resources";
import { DiagnosticSettings } from "./diagnostics.jsx";
import { MacOSLogin } from "./macos-login";
import { AccountSettings } from "./account";
import { ClaudeAccountsPanel } from "./claude-accounts";
const sections = [
  ["account", "Аккаунт", UserRound],
  ["vault", "Хранилище паролей", KeyRound],
  ["claude-accounts", "Аккаунты Claude", UsersRound],
  ["archived-sessions", "Архив сеансов", Archive],
  ["keyboard", "Общие", Settings],
  ["appearance", "Внешний вид", Palette],
  ["mobile", "Удалённое подключение", Smartphone],
  ["network", "Сеть и прокси", Globe2],
  ["region", "Часовой пояс и язык", Clock3],
  ["project", "Среда и восстановление", RotateCcw],
];
export function SettingsPanel({
  current,
  status,
  onClose,
  onSaved,
  onConfirm,
  claudeProfiles,
  terminalTabs,
  onClaudeLogin,
  initialSection = "keyboard",
}) {
  const [localKeyboard, setLocalKeyboard] = useState(() => clientKeyboard(current.keyboard));
  const [accountDirty, setAccountDirty] = useState(false);
  const [proxyDirty, setProxyDirty] = useState(false);
  const [resourceDirty, setResourceDirty] = useState(false);
  const [draft, setDraft] = useState({ ...current }),
    [section, setSection] = useState(initialSection),
    [probe, setProbe] = useState(null),
    [probing, setProbing] = useState(false),
    [probeFailed, setProbeFailed] = useState(false),
    [error, setError] = useState(""),
    [jobId, setJobId] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const changed =
    JSON.stringify({
      ...draft,
      browser_home_url: undefined,
      exit_policy: canonicalExitPolicy(draft.exit_policy),
    }) !==
    JSON.stringify({
      ...current,
      browser_home_url: undefined,
      exit_policy: canonicalExitPolicy(current.exit_policy),
    });
  const environmentChanged = [
    "dns_url",
    "timezone",
    "locale",
    "browser_language",
    "auto_timezone",
    "auto_language",
    "exit_policy",
  ].some((k) =>
    k === "exit_policy"
      ? JSON.stringify(canonicalExitPolicy(draft[k])) !==
        JSON.stringify(canonicalExitPolicy(current[k]))
      : draft[k] !== current[k],
  );
  const busy =
    Boolean(status.job?.running) || Boolean(status.storage_recovery?.required) || probing || submitting || Boolean(jobId);
  const update = (key, value) => {
    setDraft((p) => ({ ...p, [key]: value }));
    if (["dns_url"].includes(key)) setProbe(null);
    setError("");
  };
  const close = async () => {
    if (submitting) return;
    if (status.job?.running && jobId) {
      onClose();
      return;
    }
    if (
      (!changed && !accountDirty && !proxyDirty && !resourceDirty) ||
      (await onConfirm({
        title: "Отменить несохранённые изменения?",
        body: "Текущая среда не изменится. После закрытия изменения этой формы будут потеряны.",
        confirm: "Отменить изменения",
      }))
    )
      onClose();
  };
  useEffect(() => {
    if (jobId && status.job?.id === jobId && !status.job.running) {
      setJobId("");
      if (status.job.error || status.job.canceled) {
        if (status.job.settings_saved) onSaved();
        setError(status.job.error || status.job.message);
      } else {
        onSaved();
        if (!proxyDirty) onClose();
      }
    }
  }, [status.job, jobId]);
  const check = async () => {
    setProbing(true);
    setProbeFailed(false);
    setError("");
    try {
      const result = await api("/settings/probe", draft);
      setProbe(result);
      if (draft.auto_timezone)
        setDraft((previous) => ({ ...previous, timezone: result.timezone }));
      if (draft.auto_language && result.suggested_locale)
        setDraft((previous) => ({
          ...previous,
          locale: result.suggested_locale,
          browser_language: result.suggested_browser_language,
        }));
    } catch (e) {
      setError(e.message);
      setProbeFailed(true);
    } finally {
      setProbing(false);
    }
  };
  const save = async () => {
    if (busy) return;
    if (
      environmentChanged &&
      status.vm_running &&
      !(await onConfirm({
        title: "Применить настройки и перезапустить среду?",
        body: "Сначала сохраните файлы в редакторе. Текущие сеансы терминалов завершатся; страницы браузера и состояние входа сохранятся.",
        confirm: "Сохранить и перезапустить",
      }))
    )
      return;
    setError("");
    setSubmitting(true);
    try {
      const payload = { ...draft };
      delete payload.browser_home_url;
      const result = await api("/settings", payload);
      setJobId(result.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };
  const zones = useMemo(
    () => [
      ...new Set([
        "Etc/UTC",
        current.timezone,
        ...(Intl.supportedValuesOf?.("timeZone") || []),
      ]),
    ],
    [],
  );
  const contentRef = useRef();
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [section]);
  const currentLoc = probe || status.location;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    document.getElementById("settings-back")?.focus();
    const dismiss = (event) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.type === "cage-close-modal" || event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("cage-close-modal", dismiss);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("cage-close-modal", dismiss);
      previous?.focus?.();
    };
  }, []);
  return (
    <section className="settings-page" aria-label="Настройки">
      <aside className="settings-sidebar">
        <button
          id="settings-back"
          className="back-to-workspace"
          onClick={close}
        >
          <ArrowLeft size={17} />
          Вернуться в рабочую среду
        </button>
        <h2>Настройки</h2>
        <nav aria-label="Разделы настроек">
          {sections.map(([id, label, Icon]) => (
            <button
              key={id}
              className={section === id ? "selected" : ""}
              aria-current={section === id ? "page" : undefined}
              onClick={async () => {
                if (id !== section && accountDirty && !(await onConfirm({ title: "Отменить несохранённые изменения?", body: "Сохранённые данные и пароли не изменятся.", confirm: "Отменить изменения" }))) return;
                if (id !== section && proxyDirty && !(await onConfirm({ title: "Отменить неприменённые изменения прокси?", body: "Текущий прокси продолжает работать по применённой цепочке. При уходе выбор узла будет потерян.", confirm: "Отменить изменения" }))) return;
                setSection(id);
              }}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="settings-main">
        <div className={section === "archived-sessions" ? "settings-content settings-content--archives" : section === "claude-accounts" ? "settings-content settings-content--accounts" : section === "mobile" ? "settings-content settings-content--remote" : "settings-content"} ref={contentRef}>
          {section === "appearance" && <AppearanceSettings />}
          {section === "archived-sessions" && <ArchivedSessions ready={status.ready && !busy} />}
          {section === "vault" && <PasswordVaultSettings onConfirm={onConfirm} onDirty={setAccountDirty} />}
          {section === "account" && <AccountSettings busy={busy} onDirty={setAccountDirty} />}
          {section === "claude-accounts" && <ClaudeAccountsPanel store={claudeProfiles} tabs={terminalTabs} onConfirm={onConfirm}
            running={status.vm_running} environmentBusy={busy} login={async (id) => {
              if (changed && !(await onConfirm({ title: "Отменить несохранённые настройки и войти?",
                body: "Открытие терминала входа закроет страницу настроек.", confirm: "Открыть терминал входа" }))) return;
              await onClaudeLogin(id);
              onClose();
            }} />}
          <fieldset className="settings-fields" disabled={busy && !(section === "project" && status.storage_recovery?.required)}>
            {section === "mobile" && (isRemoteClient()
              ? <section className="section-title"><h3>Подключение к этому компьютеру</h3><p>Сначала переключитесь на локальную среду этого компьютера, затем создавайте код сопряжения телефона или управляйте им.</p></section>
              : <MobilePairSettings relay={draft.mobile_relay ?? ""} savedRelay={current.mobile_relay ?? ""} onChange={value => update("mobile_relay",value)} onConfirm={onConfirm} />)}
            {section === "network" && (
              <>
                <ProxySettings
                  onDirty={setProxyDirty}
                  status={status}
                  onConfirm={onConfirm}
                  onApplied={async () => {
                    setProbe(null);
                    const applied = await api("/settings");
                    if (JSON.stringify(canonicalExitPolicy(applied.exit_policy)) !==
                        JSON.stringify(canonicalExitPolicy(current.exit_policy))) {
                      setDraft(previous => ({ ...previous, exit_policy: applied.exit_policy }));
                    }
                    await onSaved();
                  }}
                />
                <label>
                  Шифрованный DNS
                  <input
                    value={draft.dns_url}
                    onChange={(e) => update("dns_url", e.target.value)}
                    spellCheck="false"
                  />
                </label>
                <div className="probe-line">
                  <button disabled={busy} onClick={check}>
                    {probing ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Globe2 size={15} />
                    )}
                    Проверить выход
                  </button>
                  <span>Запросить IP-адрес и местоположение через текущий узел</span>
                </div>
                {currentLoc && (
                  <div className={`location-result ${probe ? "fresh" : ""}`}>
                    <span className="result-icon">
                      <Globe2 size={19} />
                    </span>
                    <div>
                      <strong>
                        {currentLoc.country} · {currentLoc.city}
                      </strong>
                      <code>{currentLoc.ip}</code>
                      <small>
                        {currentLoc.timezone} ·{" "}
                        {new Date(currentLoc.checked_at).toLocaleTimeString(
                          "ru-RU",
                          { hour: "2-digit", minute: "2-digit" },
                        )}{" "}
                        {probe ? "Проверка пройдена" : "Текущая среда · последняя проверка"}
                      </small>
                    </div>
                    {probe && <Check size={18} />}
                  </div>
                )}
                <p className="footnote">
                  При недоступности прокси Cage прекращает внешний доступ. После изменения формы требуется повторная проверка.
                </p>
                <section className="network-exit-policy" aria-label="Правила смены IP">
                  <ExitPolicyFields
                    value={draft.exit_policy}
                    onChange={(value) => update("exit_policy", value)}
                    observation={probe}
                    onProbe={check}
                    busy={busy}
                    probing={probing}
                  />
                </section>
              </>
            )}
            {section === "region" && (
              <>
                <div className="section-title">
                  <h3>Часовой пояс и язык</h3>
                  <p>Эти настройки действуют на систему, CLI и браузер внутри Cage.</p>
                </div>
                {!draft.auto_timezone && !draft.auto_language && (
                  <p className="field-help">
                    Часовой пояс и язык используют значения, выбранные вручную ниже. Для любого выхода по-прежнему запрашивается страна или регион, чтобы исключить материковый Китай; статический IP и отсутствие ограничений по региону не отменяют эту проверку.
                  </p>
                )}
                <label className="toggle-row">
                  <span>
                    <strong>Часовой пояс по IP-адресу выхода</strong>
                    <small>
                      Повторный запрос выполняется при запуске или применении настроек и не перезапускает работающие задачи незаметно.
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={draft.auto_timezone}
                    onChange={(e) => update("auto_timezone", e.target.checked)}
                  />
                </label>
                <label>
                  {draft.auto_timezone ? "Применяемый часовой пояс" : "Часовой пояс системы"}
                  <InlineSelect editable
                    aria-label={draft.auto_timezone ? "Применяемый часовой пояс" : "Часовой пояс системы"}
                    value={draft.timezone}
                    disabled={draft.auto_timezone}
                    onValueChange={(next) => update("timezone", next)}
                  >
                    {zones.map((zone) => (
                      <option key={zone} value={zone} />
                    ))}
                  </InlineSelect>
                </label>
                {draft.auto_timezone && (
                  <div className="inline-info">
                    <Clock3 size={16} />
                    <span>
                      {probe
                        ? `Рекомендуемый часовой пояс выхода: ${probe.timezone}; будет применён при сохранении.`
                        : "При сохранении местоположение запрашивается через прокси; при сбое запроса прежняя конфигурация сохранится."}
                    </span>
                    <button
                      className="text-button"
                      onClick={check}
                      disabled={busy}
                    >
                      Проверить сейчас
                    </button>
                  </div>
                )}
                <label className="toggle-row">
                  <span>
                    <strong>Язык по региону выхода</strong>
                    <small>
                      Обновляется при запуске или применении настроек. Для многоязычных регионов используются встроенные значения по умолчанию; при отсутствии рекомендации выбранный язык сохраняется.
                    </small>
                  </span>
                  <input
                    role="switch"
                    type="checkbox"
                    checked={Boolean(draft.auto_language)}
                    onChange={(e) => update("auto_language", e.target.checked)}
                  />
                </label>
                {draft.auto_language && (
                  <div className="inline-info">
                    <Globe2 size={16} />
                    <span>
                      {currentLoc?.suggested_locale
                        ? `Рекомендация для региона: ${currentLoc.suggested_locale} / ${currentLoc.suggested_browser_language}`
                        : "Рекомендация появится после проверки выхода; можно отключить автоматический выбор и указать язык вручную."}
                    </span>
                    <button
                      className="text-button"
                      onClick={check}
                      disabled={busy}
                    >
                      Проверить сейчас
                    </button>
                  </div>
                )}
                <label>
                  Язык системы
                  <InlineSelect
                    aria-label="Язык системы"
                    value={draft.locale}
                    disabled={draft.auto_language}
                    onValueChange={(next) => update("locale", next)}
                  >
                    {[
                      ["en_US.UTF-8", "English (United States)"],
                      ["zh_CN.UTF-8", "Китайский (упрощённый)"],
                      ["zh_TW.UTF-8", "Китайский (традиционный)"],
                      ["ja_JP.UTF-8", "Японский"],
                      ["de_DE.UTF-8", "Deutsch"],
                      ["fr_FR.UTF-8", "Français"],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                    {![
                      "en_US.UTF-8",
                      "zh_CN.UTF-8",
                      "zh_TW.UTF-8",
                      "ja_JP.UTF-8",
                      "de_DE.UTF-8",
                      "fr_FR.UTF-8",
                    ].includes(draft.locale) && (
                      <option value={draft.locale}>{draft.locale}</option>
                    )}
                  </InlineSelect>
                </label>
                <label>
                  Предпочитаемый язык сайтов
                  <InlineSelect
                    aria-label="Предпочитаемый язык сайтов"
                    value={draft.browser_language}
                    disabled={draft.auto_language}
                    onValueChange={(next) => update("browser_language", next)}
                  >
                    {[
                      ["en-US", "English (United States)"],
                      ["zh-CN", "Китайский (упрощённый)"],
                      ["zh-TW", "Китайский (традиционный)"],
                      ["ja-JP", "Японский"],
                      ["de-DE", "Deutsch"],
                      ["fr-FR", "Français"],
                    ].map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                    {![
                      "en-US",
                      "zh-CN",
                      "zh-TW",
                      "ja-JP",
                      "de-DE",
                      "fr-FR",
                    ].includes(draft.browser_language) && (
                      <option value={draft.browser_language}>
                        {draft.browser_language}
                      </option>
                    )}
                  </InlineSelect>
                </label>
                <p className="footnote">
                  Сайты по-прежнему выбирают язык по своим правилам. Интерфейс рабочей среды использует русский язык.
                </p>
              </>
            )}
            {section === "keyboard" && (
              <>
                <div className="section-title">
                  <h3>Общие</h3>
                  <p>Настройте клавиатурные привычки и повседневные действия рабочей среды.</p>
                </div>
                <label>
                  Команда запуска терминала Claude
                  <input
                    value={draft.claude_terminal_command ?? "claude"}
                    onChange={(e) => update("claude_terminal_command", e.target.value)}
                    placeholder="claude"
                    maxLength={4096}
                    spellCheck="false"
                    autoComplete="off"
                  />
                </label>
                <p className="field-help">
                  После выбора «Терминал Claude» эта команда выполняется в выбранном проекте, например claude --continue.
                  Если оставить поле пустым, используется claude; после сохранения изменение влияет только на новые терминалы Claude, а после выхода из Claude можно продолжить работу в shell.
                </p>
                {typeof current.balanced_display === "boolean" && <label className="toggle-row">
                  <span>
                    <strong>Приоритет плавности</strong>
                    <small>Снижает чёткость браузера и Claude Desktop. Вступает в силу при следующем запуске среды.</small>
                  </span>
                  <input type="checkbox" role="switch" checked={draft.balanced_display}
                    onChange={(event) => update("balanced_display", event.target.checked)} />
                </label>}
                <h4>Клавиатурные привычки</h4>
                <div className="choice-list">
                  {[
                    [
                      "mac",
                      "Сочетания Mac",
                      "Использовать ⌘ для работы с веб-страницами и редактором. Гостевые Linux и Windows используют соответствующие сочетания с Ctrl, гостевая macOS сохраняет Command.",
                    ],
                    [
                      "native",
                      "Сочетания гостевой системы",
                      "Использовать Control, Command и другие сочетания так, как принято в гостевой системе.",
                    ],
                  ].map(([value, title, help]) => (
                    <label
                      className={`choice ${(isRemoteClient() ? localKeyboard : draft.keyboard) === value ? "checked" : ""}`}
                      key={value}
                    >
                      <input
                        type="radio"
                        name="keyboard"
                        value={value}
                        checked={(isRemoteClient() ? localKeyboard : draft.keyboard) === value}
                        onChange={() => {
                          if (!isRemoteClient()) { update("keyboard", value); return; }
                          try { saveClientKeyboard(value); setLocalKeyboard(value); setError(""); }
                          catch { setError("Не удалось сохранить клавиатурные привычки на этом компьютере. Проверьте свободное место в локальном хранилище."); }
                        }}
                      />
                      <span>
                        <strong>{title}</strong>
                        <small>{help}</small>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="field-help">
                  В терминале копирование и вставка — {usesControl ? "Ctrl+Shift+C / Ctrl+Shift+V" : "⌘C / ⌘V"}; Ctrl+C всегда прерывает команду.
                  {isRemoteClient() && "Клавиатурные привычки действуют сразу и сохраняются только в текущем клиенте, не изменяя облачные настройки."}
                </p>
                <h4>Сочетания клавиш рабочей среды</h4>
                <div className="shortcut-list">
                  {[
                    ["Открыть проект", "⌘O"],
                    ["Новая веб-страница", "⌘T"],
                    ["Новый терминал", "⌘⇧↵"],
                    ["Адресная строка", "⌘L"],
                    ["Закрыть текущую вкладку", "⌘W"],
                    ["Переключить вкладку", "⌘1–9"],
                    ["Настройки", "⌘,"],
                  ].map(([label, key]) => (
                    <div key={label}>
                      <span>{label}</span>
                      <kbd>{shortcut(key)}</kbd>
                    </div>
                  ))}
                </div>
              </>
            )}
            {section === "project" && (
              <>
                <div className="section-title">
                  <h3>Среда и восстановление</h3>
                  <p>{isRemoteClient() ? "Проекты находятся в облаке; изменения в Cage напрямую сохраняются в облачные файлы." : "Изменения на этом компьютере и в Cage синхронизируются в обе стороны."}</p>
                </div>
                {status.local_vm_storage && !isRemoteClient() && <EnvironmentStorage status={status} onConfirm={onConfirm} />}
                <div className="setting-summary-row">
                  <span>Текущий проект</span>
                  <strong title={current.workspace}>
                    {status.environment_workspace
                      ? "Рабочая область Cage по умолчанию"
                      : current.workspace || "Проект ещё не выбран"}
                  </strong>
                </div>
                <p className="field-help">
                  {isRemoteClient() ? "Нажмите плюс рядом с заголовком «Проекты» на боковой панели, чтобы просмотреть и выбрать облачную папку." : "Нажмите плюс рядом с заголовком «Проекты» на боковой панели, чтобы выбрать другую локальную папку."}
                </p>
                <div className="project-explanation">
                  <FolderOpen size={22} />
                  <div>
                    <strong>Все проекты используют одну среду Cage</strong>
                    <p>
                      Явно открытые папки проектов предоставляются одной и той же среде. Вход в Claude
                      на хосте, SSH-ключи и личная конфигурация не импортируются автоматически. Загрузки браузера
                      единообразно сохраняются в папку Downloads рабочей области Cage по умолчанию.
                    </p>
                  </div>
                </div>
                <p className="footnote">
                  Переключение проекта меняет только начальное расположение новых терминалов и редактора файлов; существующие терминалы, веб-страницы и состояние входа сохраняются.
                </p>
                {!status.storage_recovery?.required && <EnvironmentVersions status={status} onConfirm={onConfirm} />}
                {status.guest_system === "macos" && <section aria-label="Разрешения гостевой системы">
                  <h4>Разрешения гостевой системы</h4>
                  <p className="field-help">Выполните авторизацию в ограниченном окне настроек гостевой системы; Cage автоматически проверит и переподключит проект.</p>
                  <div className="project-recovery-actions">
                    <MacOSLogin maintenance="projects" label="Доступ к общим файлам" disabled={!status.ready || busy} />
                    <MacOSLogin maintenance="screen" label="Запись экрана" disabled={!status.ready || busy} />
                    <MacOSLogin maintenance="input" label="Универсальный доступ" disabled={!status.ready || busy} />
                  </div>
                </section>}
                {!status.storage_recovery?.required && <ResourceSettings status={status} onConfirm={onConfirm} onDirtyChange={setResourceDirty} />}
 <DiagnosticSettings />
                {status.can_restore && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await onConfirm({
                          title: "Восстановить предыдущую конфигурацию?",
                          body: "Текущая среда будет остановлена и восстановлены настройки, действовавшие до последнего применения. Завершённые процессы терминалов восстановить нельзя.",
                          confirm: "Восстановить и перезапустить",
                        })
                      ) {
                        try {
                          const result = await api("/restore", {});
                          setJobId(result.id);
                        } catch (e) {
                          setError(e.message);
                        }
                      }
                    }}
                  >
                    <RotateCcw size={14} />
                    Восстановить предыдущую конфигурацию
                  </button>
                )}
              </>
            )}
          </fieldset>
          {error && (
            <div role="alert" className="error-message">
              <SafetyMessage message={error} />
              {probeFailed && (draft.auto_timezone || draft.auto_language) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setDraft((previous) => ({
                      ...previous,
                      auto_timezone: false,
                      auto_language: false,
                    }));
                    setProbeFailed(false);
                    setError("");
                    setSection("region");
                  }}
                >
                  Настроить часовой пояс и язык вручную
                </button>
              )}
            </div>
          )}
        </div>
        {(!["appearance", "browser", "account", "claude-accounts", "vault", "mobile", "archived-sessions", "project"].includes(section) || changed) && (
          <footer className="settings-footer">
            {" "}
            <>
              <span className="save-note">
                {status.job?.running
                  ? status.job.message
                  : proxyDirty
                    ? "Изменения прокси ожидают применения. Нажмите «Применить прокси»"
                    : changed
                    ? environmentChanged && status.vm_running
                      ? "Сетевые и системные настройки требуют перезапуска"
                      : "Есть несохранённые изменения"
                    : "Несохранённых изменений нет"}
              </span>
              <button onClick={close}>Вернуться в рабочую среду</button>
              <button
                className="primary"
                disabled={!changed || busy}
                onClick={save}
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}{" "}
                {environmentChanged && status.vm_running
                  ? "Сохранить и перезапустить"
                  : "Сохранить настройки"}
              </button>
            </>
          </footer>
        )}
      </div>
    </section>
  );
}
