import { InlineSelect } from "./inline-select";
import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
  LoaderCircle,
  Monitor,
  Moon,
  Sun,
  Upload,
  RotateCcw,
  CircleCheck,
  TriangleAlert,
  CircleX,
} from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { useAppearance } from "./appearance";
import {
  colorGroups,
  colorTokens,
  terminalColorGroups,
  terminalTheme,
  customThemeLimit,
  themeFileLimit,
  parseThemeDocument,
  themeDocument,
  validateThemeName,
  sameTheme,
  presets,
  presetNames,
  presetInfo,
  presetGroups,
  themeCatalog,
  applyThemePreset,
  systemUIFont,
  systemCodeFont,
  themeVariables,
} from "./appearance-state.mjs";

function SettingRow({ label, description, children }) {
  return (
    <div className="appearance-row">
      <div>
        <span>{label}</span>
        {description && <p>{description}</p>}
      </div>
      <div className="appearance-control">{children}</div>
    </div>
  );
}
function FontSizeInput({ label, value, min, onChange }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="font-size-control">
      <input
        aria-label={label}
        type="number"
        min={min}
        max="24"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const number = Number(event.target.value);
          if (Number.isInteger(number) && number >= min && number <= 24)
            onChange(number);
        }}
        onBlur={() => setText(String(value))}
      />
      <span>px</span>
    </div>
  );
}
function ColorField({ label, value, onChange, onReset }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const invalid = !/^#[0-9a-fA-F]{6}$/.test(text);
  const commit = () => {
    if (!invalid && text !== value) onChange(text.toLowerCase());
  };
  return (
    <div className="theme-color-field">
      <span>{label.replace(/^(Светлая|Тёмная) тема(?: · терминал)? · /, "")}</span>
      <div className="theme-color-value">
        <input
          type="color"
          aria-label={label + ": выбор цвета"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          aria-label={label}
          aria-invalid={invalid}
          value={text}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setText(value);
            }
          }}
        />
        {onReset && (
          <button
            className="icon-button"
            aria-label={label + ": вернуть автоматический цвет"}
            title="Вернуть автоматический цвет"
            onClick={onReset}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      {invalid && (
        <small className="theme-color-error">Введите # и шестизначный шестнадцатеричный цвет</small>
      )}
    </div>
  );
}
function ThemeCard({ variant, value, active, onChange }) {
  const [advanced, setAdvanced] = useState(false);
  const label = variant === "light" ? "Светлая тема" : "Тёмная тема";
  const options = presets[variant];
  const patch = (delta) => onChange({ ...value, preset: "custom", ...delta });
  const vars = themeVariables(value, variant);
  const terminal = terminalTheme(value, variant);
  const setColor = (field, key, color) => {
    const next = { ...value[field] };
    if (color === undefined) delete next[key];
    else next[key] = color;
    patch({ [field]: next });
  };
  return (
    <section
      className={`appearance-theme-card ${active ? "current" : ""}`}
      aria-label={label}
    >
      <div className="theme-card-heading">
        <strong>{label}</strong>
        {active && <small>Используется сейчас</small>}
        <InlineSelect
          aria-label={label + ": шаблон"}
          value={value.preset}
          onValueChange={(next) =>
            onChange(applyThemePreset(value, variant, next))
          }
        >
          {presetGroups.map((group) => (
            <optgroup key={group} label={group}>
              {themeCatalog
                .filter((item) => item.group === group && options[item.id])
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </optgroup>
          ))}
          {!options[value.preset] && (
            <option value={value.preset} disabled>
              {presetNames[value.preset] || "Своя"}
            </option>
          )}
        </InlineSelect>
      </div>
      <div
        className="theme-miniature"
        aria-hidden="true"
        style={{ ...vars, background: value.surface, color: value.ink }}
      >
        <div className="mini-sidebar" style={{ background: vars["--sidebar"] }}>
          <i />
          <i />
          <i />
        </div>
        <div className="mini-content">
          <span style={{ background: vars["--strong"] }} />
          <span />
          <div
            style={{ borderColor: vars["--line"], background: vars["--input"] }}
          >
            <i />
            <b style={{ background: value.accent }} />
          </div>
        </div>
      </div>
      <div className="theme-preset-summary">
        <p>
          {presetInfo[value.preset]?.description ||
            "Своя палитра; сохраните её как тему, чтобы использовать позже."}
        </p>
        <div
          className="theme-status-preview"
          aria-label={label + ": предпросмотр цветов состояний"}
          style={{ background: value.surface }}
        >
          <span style={{ color: vars["--success"] }}>
            <CircleCheck size={13} />
            Успех
          </span>
          <span style={{ color: vars["--warning"] }}>
            <TriangleAlert size={13} />
            Предупреждение
          </span>
          <span style={{ color: vars["--danger"] }}>
            <CircleX size={13} />
            Ошибка
          </span>
        </div>
      </div>
      <div className="theme-base-colors">
        {[
          ["accent", "Акцентный цвет"],
          ["surface", "Фон"],
          ["ink", "Текст"],
        ].map(([key, name]) => (
          <ColorField
            key={key}
            label={label + " · " + name}
            value={value[key]}
            onChange={(color) => patch({ [key]: color })}
          />
        ))}
      </div>
      <button
        className="theme-customize"
        onClick={() => setAdvanced(!advanced)}
        aria-expanded={advanced}
      >
        Настроить
        <ChevronDown size={14} className={advanced ? "rotated" : ""} />
      </button>
      {advanced && (
        <div className="theme-options">
          <p className="theme-options-hint">
            Цвета без отдельных настроек автоматически подстраиваются под базовую палитру.
          </p>
          {colorGroups.map((group) => (
            <details className="theme-color-group" key={group.label}>
              <summary>{group.label}</summary>
              {group.entries.map(([key, name]) => (
                <ColorField
                  key={key}
                  label={label + " · " + name}
                  value={vars[colorTokens[key]]}
                  onChange={(color) => setColor("colors", key, color)}
                  onReset={
                    value.colors?.[key]
                      ? () => setColor("colors", key)
                      : undefined
                  }
                />
              ))}
            </details>
          ))}
          {terminalColorGroups.map((group) => (
            <details className="theme-color-group" key={group.label}>
              <summary>{group.label}</summary>
              {group.entries.map(([key, name]) => (
                <ColorField
                  key={key}
                  label={label + " · терминал · " + name}
                  value={terminal[key]}
                  onChange={(color) => setColor("terminal", key, color)}
                  onReset={
                    value.terminal?.[key]
                      ? () => setColor("terminal", key)
                      : undefined
                  }
                />
              ))}
            </details>
          ))}
          <div
            className="theme-terminal-preview"
            style={{
              background: terminal.background,
              color: terminal.foreground,
            }}
            aria-label={label + ": предпросмотр терминала"}
          >
            <span style={{ color: terminal.green }}>~/cage</span> ${" "}
            <span style={{ color: terminal.blue }}>echo</span> hello
            <i style={{ background: terminal.cursor }} />
          </div>
          <button
            className="theme-reset-colors"
            disabled={
              !Object.keys(value.colors || {}).length &&
              !Object.keys(value.terminal || {}).length
            }
            onClick={() => patch({ colors: {}, terminal: {} })}
          >
            <RotateCcw size={13} />
            Вернуть все автоматические цвета
          </button>
          <label>
            Контрастность <output>{value.contrast}</output>
            <input
              aria-label={label + ": контрастность"}
              type="range"
              min="0"
              max="100"
              value={value.contrast}
              onChange={(e) => patch({ contrast: Number(e.target.value) })}
            />
          </label>
          <label>
            Шрифт интерфейса
            <InlineSelect editable
              aria-label={label + ": шрифт интерфейса"}
              value={value.fonts.ui}
              placeholder="Системный по умолчанию"
              onValueChange={(next) =>
                patch({ fonts: { ...value.fonts, ui: next } })
              }
            >
              <option value="system-ui" />
              <option value="PingFang SC" />
              <option value="Helvetica Neue" />
              <option value="Arial" />
            </InlineSelect>
          </label>
          <label>
            Шрифт кода
            <InlineSelect editable
              aria-label={label + ": шрифт кода"}
              value={value.fonts.code}
              placeholder="Системный моноширинный"
              onValueChange={(next) =>
                patch({ fonts: { ...value.fonts, code: next } })
              }
            >
              <option value="SF Mono" />
              <option value="Menlo" />
              <option value="Monaco" />
              <option value="JetBrains Mono" />
            </InlineSelect>
          </label>
          <label className="appearance-switch">
            <span>Полупрозрачная боковая панель</span>
            <input
              type="checkbox"
              role="switch"
              aria-label={label + ": полупрозрачная боковая панель"}
              checked={!value.opaqueWindows}
              onChange={(e) => patch({ opaqueWindows: !e.target.checked })}
            />
          </label>
        </div>
      )}
    </section>
  );
}
function ThemeLibrary({ appearance, update, saving, onError }) {
  const themes = appearance.customThemes;
  const matching = themes.find((item) => sameTheme(item, appearance));
  const [selectedId, setSelectedId] = useState(matching?.id || "");
  const [name, setName] = useState(matching?.name || "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const input = useRef(null);
  const selected = themes.find((item) => item.id === selectedId);
  const current = selected || matching;
  const dirty = current && !sameTheme(current, appearance);
  const run = async (task) => {
    setBusy(true);
    setNotice("");
    onError("");
    try {
      await task();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const apply = (item) => {
    setSelectedId(item.id);
    setName(item.name);
    setNotice("");
    onError("");
    void update((previous) => ({
      ...previous,
      lightTheme: structuredClone(item.lightTheme),
      darkTheme: structuredClone(item.darkTheme),
    }));
  };
  const save = (replace) =>
    run(async () => {
      const title = validateThemeName(name);
      if (!replace && themes.length >= customThemeLimit)
        throw new Error("Можно сохранить не более 50 пользовательских тем; сначала удалите ненужные");
      const document = themeDocument(title, appearance);
      const item = {
        id: replace ? current.id : crypto.randomUUID(),
        name: title,
        lightTheme: document.lightTheme,
        darkTheme: document.darkTheme,
      };
      if (
        await update((previous) => ({
          ...previous,
          customThemes: replace
            ? previous.customThemes.map((old) =>
                old.id === item.id ? item : old,
              )
            : [...previous.customThemes, item],
        }))
      ) {
        setSelectedId(item.id);
        setName(title);
        setNotice("Тема сохранена");
      }
    });
  const importText = async (text) => {
    const document = parseThemeDocument(text);
    if (themes.length >= customThemeLimit)
      throw new Error("Можно сохранить не более 50 пользовательских тем; сначала удалите ненужные");
    const item = {
      id: crypto.randomUUID(),
      name: document.name,
      lightTheme: document.lightTheme,
      darkTheme: document.darkTheme,
    };
    if (
      await update((previous) => ({
        ...previous,
        lightTheme: item.lightTheme,
        darkTheme: item.darkTheme,
        customThemes: [...previous.customThemes, item],
      }))
    ) {
      setSelectedId(item.id);
      setName(item.name);
      setNotice("Тема импортирована и применена");
    }
  };
  const importFile = () => {
    if (!nativeAvailable()) {
      input.current.click();
      return;
    }
    void run(async () => {
      const text = await native("importTheme");
      if (text) await importText(text);
    });
  };
  const exportFile = () =>
    run(async () => {
      const title = name.trim() || matching?.name || "Моя тема";
      const text =
        JSON.stringify(themeDocument(title, appearance), null, 2) + "\n";
      const filename =
        title
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
          .replace(/[. ]+$/, "")
          .slice(0, 80) + ".cage-theme.json";
      if (nativeAvailable()) {
        if (await native("exportTheme", { text, filename }))
          setNotice("Тема экспортирована");
      } else {
        const url = URL.createObjectURL(
          new Blob([text], { type: "application/json" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice("Загрузка файла темы начата");
      }
    });
  return (
    <section className="theme-library" aria-label="Мои темы">
      <div className="theme-library-heading">
        <div>
          <h4>Мои темы</h4>
          <p>Сохраняйте светлую и тёмную палитры со шрифтами, переключайтесь и делитесь ими.</p>
        </div>
        <div className="theme-file-actions">
          <button disabled={busy || saving} onClick={importFile}>
            <Upload size={14} />
            Импортировать тему
          </button>
          <button disabled={busy} onClick={exportFile}>
            <Download size={14} />
            Экспортировать тему
          </button>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="Выбрать файл темы"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void run(async () => {
              if (file.size > themeFileLimit)
                throw new Error("Файл темы не должен превышать 256 КБ");
              await importText(await file.text());
            });
        }}
      />
      <div className="theme-library-fields">
        <InlineSelect
          aria-label="Сохранённые темы"
          value={current?.id || ""}
          disabled={busy || saving}
          onValueChange={(next) => {
            const item = themes.find((theme) => theme.id === next);
            if (item) apply(item);
          }}
        >
          <option value="" disabled>
            {themes.length ? "Выберите сохранённую тему" : "Пользовательских тем пока нет"}
          </option>
          {themes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.id === current?.id && dirty ? " · изменена" : ""}
            </option>
          ))}
        </InlineSelect>
        <input
          aria-label="Название темы"
          placeholder="Назовите текущую палитру"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          disabled={busy || saving || !name.trim()}
          onClick={() => save(false)}
        >
          Сохранить как тему
        </button>
      </div>
      {current && (
        <div className="theme-library-manage">
          <span>
            {dirty ? "В текущей палитре есть изменения, не сохранённые в теме" : "Текущая палитра совпадает с сохранённой темой"}
          </span>
          {dirty && (
            <button disabled={busy || saving} onClick={() => apply(current)}>
              Вернуть сохранённую палитру
            </button>
          )}
          <button
            disabled={busy || saving || !name.trim()}
            onClick={() => save(true)}
          >
            Обновить эту тему
          </button>
          <button
            disabled={busy || saving}
            onClick={() =>
              run(async () => {
                if (!confirm(`Удалить тему «${current.name}»? Текущая палитра останется.`))
                  return;
                if (
                  await update((previous) => ({
                    ...previous,
                    customThemes: previous.customThemes.filter(
                      (item) => item.id !== current.id,
                    ),
                  }))
                ) {
                  setSelectedId("");
                  setName("");
                  setNotice("Тема удалена, текущая палитра сохранена");
                }
              })
            }
          >
            Удалить
          </button>
        </div>
      )}
      {notice && (
        <p className="theme-library-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
export function AppearanceSettings() {
  const { appearance, theme, variant, loading, saving, error, update, retry } =
    useAppearance();
  const [syncing, setSyncing] = useState(false),
    [syncError, setSyncError] = useState(""),
    [synced, setSynced] = useState(false),
    [themeError, setThemeError] = useState("");
  const patch = (delta) => update((previous) => ({ ...previous, ...delta }));
  const sync = async () => {
    setSyncing(true);
    setSyncError("");
    setSynced(false);
    try {
      const value = await api("/appearance/codex");
      if (
        await update((previous) => ({
          ...value,
          customThemes: previous.customThemes,
        }))
      )
        setSynced(true);
    } catch (e) {
      setSyncError(e.message);
    } finally {
      setSyncing(false);
    }
  };
  return (
    <div className="appearance-settings">
      <div className="section-title">
        <h3>Внешний вид</h3>
        <p>Изменения сохраняются автоматически и применяются сразу, без перезапуска проекта.</p>
      </div>
      <fieldset disabled={loading || syncing} className="appearance-fields">
        <SettingRow
          label="Тема"
          description="Следуйте системе или зафиксируйте светлое либо тёмное оформление."
        >
          <div className="appearance-mode" role="group" aria-label="Режим темы">
            {[
              ["light", "Светлая", Sun],
              ["dark", "Тёмная", Moon],
              ["system", "Как в системе", Monitor],
            ].map(([mode, label, Icon]) => (
              <button
                key={mode}
                aria-pressed={appearance.mode === mode}
                onClick={() => patch({ mode })}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <ThemeLibrary
          key={String(loading)}
          appearance={appearance}
          update={update}
          saving={saving}
          onError={setThemeError}
        />
        {themeError && (
          <div className="error-message" role="alert">
            {themeError}
          </div>
        )}
        <div className="theme-card-grid">
          {["light", "dark"].map((key) => (
            <ThemeCard
              key={key}
              variant={key}
              value={appearance[key + "Theme"]}
              active={variant === key}
              onChange={(value) => patch({ [key + "Theme"]: value })}
            />
          ))}
        </div>
        <h4>Шрифты</h4>
        <SettingRow
          label="Размер шрифта интерфейса"
          description="Размер текста в навигации, вкладках и настройках."
        >
          <FontSizeInput
            label="Размер шрифта интерфейса"
            value={appearance.uiFontSize}
            min={12}
            onChange={(value) => patch({ uiFontSize: value })}
          />
        </SettingRow>
        <SettingRow
          label="Размер шрифта кода"
          description="Размер текста во встроенном терминале и предпросмотре кода."
        >
          <FontSizeInput
            label="Размер шрифта кода"
            value={appearance.codeFontSize}
            min={10}
            onChange={(value) => patch({ codeFontSize: value })}
          />
        </SettingRow>
        <div
          className="appearance-sample"
          style={{ fontFamily: theme.fonts.ui || systemUIFont }}
        >
          <span>В знакомой рабочей среде сосредоточьтесь на следующем шаге.</span>
          <code
            style={{
              fontFamily: theme.fonts.code || systemCodeFont,
              fontSize: appearance.codeFontSize,
            }}
          >
            const workspace = "Cage";
          </code>
        </div>
        <h4>Отображение и взаимодействие</h4>
        <SettingRow
          label="Курсор-указатель"
          description="Показывать руку при наведении на кнопки и другие интерактивные элементы."
        >
          <label className="appearance-switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="Курсор-указатель"
              checked={appearance.pointerCursors}
              onChange={(e) => patch({ pointerCursors: e.target.checked })}
            />
          </label>
        </SettingRow>
        <SettingRow label="Сглаживание шрифтов">
          <label className="appearance-switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="Сглаживание шрифтов"
              checked={appearance.fontSmoothing}
              onChange={(e) => patch({ fontSmoothing: e.target.checked })}
            />
          </label>
        </SettingRow>
        <SettingRow label="Уменьшить анимацию">
          <InlineSelect
            aria-label="Уменьшить анимацию"
            value={appearance.reducedMotion}
            onValueChange={(next) => patch({ reducedMotion: next })}
          >
            <option value="system">Как в системе</option>
            <option value="on">Включено</option>
            <option value="off">Выключено</option>
          </InlineSelect>
        </SettingRow>
        <div className="appearance-import">
          <div>
            <strong>Использовать внешний вид Codex</strong>
            <p>Импортировать текущую тему, палитру и настройки шрифтов Codex с этого компьютера.</p>
          </div>
          <button onClick={sync}>
            {syncing ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}
            Синхронизировать с Codex на этом компьютере
          </button>
        </div>
      </fieldset>
      <div className="appearance-save-state" role="status">
        {saving ? (
          <>
            <LoaderCircle size={13} className="spin" />
            Сохранение…
          </>
        ) : error ? (
          <>
            <span>Не сохранено</span>
            <button className="text-button" onClick={retry}>
              Повторить сохранение
            </button>
          </>
        ) : (
          <>
            <Check size={14} />
            {synced ? "Внешний вид Codex синхронизирован" : "Изменения сохраняются автоматически и применяются сразу"}
          </>
        )}
      </div>
      {(error || syncError) && (
        <div className="error-message" role="alert">
          {syncError || error}
        </div>
      )}
    </div>
  );
}
