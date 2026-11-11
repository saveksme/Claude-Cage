export const systemUIFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
export const systemCodeFont = '"SF Mono", Menlo, Consolas, monospace';
import { presets } from "./appearance-presets.mjs";
export {
  presets,
  presetNames,
  presetGroups,
  presetInfo,
  themeCatalog,
  applyThemePreset,
} from "./appearance-presets.mjs";
export const defaultAppearance = {
  customThemes: [],
  mode: "system",
  lightTheme: {
    ...presets.light.codex,
    preset: "codex",
    opaqueWindows: false,
    fonts: { ui: "", code: "" },
  },
  darkTheme: {
    ...presets.dark.codex,
    preset: "codex",
    opaqueWindows: false,
    fonts: { ui: "", code: "" },
  },
  uiFontSize: 14,
  codeFontSize: 13,
  pointerCursors: false,
  fontSmoothing: true,
  reducedMotion: "system",
};
export function normalizeAppearance(value = {}) {
  value = value && typeof value === "object" ? value : {};
  return {
    ...defaultAppearance,
    ...value,
    customThemes: Array.isArray(value.customThemes) ? value.customThemes : [],
    lightTheme: {
      ...defaultAppearance.lightTheme,
      ...value.lightTheme,
      colors: { ...value.lightTheme?.colors },
      terminal: { ...value.lightTheme?.terminal },
      fonts: {
        ...defaultAppearance.lightTheme.fonts,
        ...value.lightTheme?.fonts,
      },
    },
    darkTheme: {
      ...defaultAppearance.darkTheme,
      ...value.darkTheme,
      colors: { ...value.darkTheme?.colors },
      terminal: { ...value.darkTheme?.terminal },
      fonts: {
        ...defaultAppearance.darkTheme.fonts,
        ...value.darkTheme?.fonts,
      },
    },
  };
}
export function mix(a, b, weight) {
  const rgb = (hex) =>
    [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const left = rgb(a),
    right = rgb(b);
  return (
    "#" +
    left
      .map((value, index) =>
        Math.round(value + (right[index] - value) * weight)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
export function themeVariables(theme, variant) {
  const { surface, ink, accent, contrast } = theme;
  const chrome = mix(surface, ink, 0.025 + contrast * 0.00055);
  const line = mix(surface, ink, 0.09 + contrast * 0.0013);
  const variables = {
    "--paper": surface,
    "--chrome": chrome,
    "--chrome-dark": mix(surface, ink, 0.1),
    "--ink": ink,
    "--strong": mix(ink, variant === "light" ? "#000000" : "#ffffff", 0.15),
    "--muted": mix(ink, surface, 0.15),
    "--accent": accent,
    "--focus": accent,
    "--input": surface,
    "--line": line,
    "--hover": mix(surface, ink, 0.09),
    "--selected": mix(surface, ink, 0.13),
    "--selection": mix(surface, accent, 0.32),
    "--button": ink,
    "--button-ink": surface,
    "--link": accent,
    "--success": variant === "dark" ? "#70bf56" : "#357c3c",
    "--danger": variant === "dark" ? "#f26d78" : "#bb3535",
    "--warning": variant === "dark" ? "#e6b450" : "#af7a22",
    "--inactive": "#a3a3a3",
    "--ui-font-family": theme.fonts.ui || systemUIFont,
    "--code-font-family": theme.fonts.code || systemCodeFont,
    "--accent-ink": luminance(accent) > 0.4 ? "#111111" : "#ffffff",
  };
  for (const [key, value] of Object.entries(theme.colors || {})) {
    if (colorTokens[key]) variables[colorTokens[key]] = value;
  }
  variables["--sidebar"] = theme.colors?.sidebar || variables["--chrome"];
  variables["--sidebar-ink"] = theme.colors?.sidebarInk || ink;
  variables["--toolbar"] = theme.colors?.toolbar || surface;
  variables["--toolbar-ink"] = theme.colors?.toolbarInk || ink;
  // Shared components also use these aliases.
  variables["--border"] = variables["--line"];
  variables["--surface"] = variables["--paper"];
  return variables;
}
export function terminalTheme(theme, variant) {
  const vars = themeVariables(theme, variant);
  return {
    background: theme.surface,
    foreground: theme.ink,
    cursor: theme.ink,
    cursorAccent: theme.surface,
    selectionBackground: vars["--selection"],
    black: variant === "dark" ? "#202020" : "#242424",
    red: variant === "dark" ? "#f26d78" : "#c43d3d",
    green: variant === "dark" ? "#aad94c" : "#4b7b23",
    yellow: theme.accent,
    blue: variant === "dark" ? "#59c2ff" : "#206bb1",
    magenta: variant === "dark" ? "#d2a6ff" : "#a03e9c",
    cyan: variant === "dark" ? "#95e6cb" : "#187b74",
    white: variant === "dark" ? "#bfbdb6" : "#dadada",
    brightBlack: "#737373",
    brightRed: "#fa7784",
    brightGreen: "#a4d86a",
    brightYellow: "#ffd173",
    brightBlue: "#73d0ff",
    brightMagenta: "#d4bfff",
    brightCyan: "#95e6cb",
    brightWhite: "#ffffff",
    ...theme.terminal,
  };
}

// Optional overrides keep unedited colors linked to the three base colors.
export const colorGroups = [
  {
    label: "Интерфейс и уровни",
    entries: [
      ["chrome", "Фон панели"],
      ["sidebar", "Фон боковой панели"],
      ["sidebarInk", "Текст боковой панели"],
      ["toolbar", "Фон панели инструментов"],
      ["toolbarInk", "Текст панели инструментов"],
      ["chromeDark", "Вспомогательный фон"],
      ["strong", "Текст заголовков"],
      ["muted", "Вспомогательный текст"],
      ["line", "Границы и разделители"],
      ["input", "Фон полей ввода"],
    ],
  },
  {
    label: "Кнопки и взаимодействие",
    entries: [
      ["button", "Фон основной кнопки"],
      ["buttonInk", "Текст основной кнопки"],
      ["accentInk", "Текст на акцентном цвете"],
      ["link", "Ссылки"],
      ["focus", "Рамка фокуса"],
      ["hover", "Фон при наведении"],
      ["selected", "Фон выбранного"],
      ["selection", "Выделение текста"],
    ],
  },
  {
    label: "Индикаторы состояния",
    entries: [
      ["success", "Успешное состояние"],
      ["warning", "Предупреждение"],
      ["danger", "Ошибка"],
      ["inactive", "Не запущено"],
    ],
  },
];
export const colorTokens = Object.fromEntries(
  colorGroups.flatMap((group) =>
    group.entries.map(([key]) => [
      key,
      "--" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
    ]),
  ),
);
export const terminalColorGroups = [
  {
    label: "Терминал",
    entries: [
      ["background", "Фон"],
      ["foreground", "Текст"],
      ["cursor", "Курсор"],
      ["cursorAccent", "Текст под курсором"],
      ["selectionBackground", "Фон выделения"],
    ],
  },
  {
    label: "Цвета ANSI терминала",
    entries: [
      ["black", "Чёрный"],
      ["red", "Красный"],
      ["green", "Зелёный"],
      ["yellow", "Жёлтый"],
      ["blue", "Синий"],
      ["magenta", "Пурпурный"],
      ["cyan", "Голубой"],
      ["white", "Белый"],
      ["brightBlack", "Яркий чёрный"],
      ["brightRed", "Яркий красный"],
      ["brightGreen", "Яркий зелёный"],
      ["brightYellow", "Яркий жёлтый"],
      ["brightBlue", "Яркий синий"],
      ["brightMagenta", "Яркий пурпурный"],
      ["brightCyan", "Яркий голубой"],
      ["brightWhite", "Яркий белый"],
    ],
  },
];
export const themeFileLimit = 256 * 1024;
export const customThemeLimit = 50;
const hexColor = /^#[0-9a-fA-F]{6}$/;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function validateTheme(theme) {
  if (!object(theme)) throw new Error("В теме отсутствует конфигурация светлой или тёмной схемы");
  const allowed = [
    "preset",
    "accent",
    "surface",
    "ink",
    "contrast",
    "opaqueWindows",
    "fonts",
    "colors",
    "terminal",
  ];
  if (Object.keys(theme).some((key) => !allowed.includes(key)))
    throw new Error("Тема содержит неподдерживаемые настройки");
  if (
    ![theme.accent, theme.surface, theme.ink].every(
      (value) => typeof value === "string" && hexColor.test(value),
    )
  )
    throw new Error("Цвет должен быть шестизначным шестнадцатеричным значением, например #fdf6e3");
  if (
    typeof theme.preset !== "string" ||
    theme.preset.length > 80 ||
    !Number.isInteger(theme.contrast) ||
    theme.contrast < 0 ||
    theme.contrast > 100 ||
    typeof theme.opaqueWindows !== "boolean"
  )
    throw new Error("Недопустимая конфигурация темы");
  if (
    !object(theme.fonts) ||
    Object.keys(theme.fonts).some((key) => !["ui", "code"].includes(key)) ||
    [theme.fonts.ui, theme.fonts.code].some(
      (font) =>
        typeof font !== "string" ||
        font.length > 200 ||
        /[;{}<>\r\n]/.test(font),
    )
  )
    throw new Error("Недопустимое название шрифта");
  for (const [field, keys] of [
    ["colors", Object.keys(colorTokens)],
    [
      "terminal",
      terminalColorGroups.flatMap((group) => group.entries.map(([key]) => key)),
    ],
  ]) {
    if (theme[field] === undefined) continue;
    if (
      !object(theme[field]) ||
      Object.entries(theme[field]).some(
        ([key, value]) =>
          !keys.includes(key) ||
          typeof value !== "string" ||
          !hexColor.test(value),
      )
    )
      throw new Error("Недопустимый цвет элемента или неподдерживаемый цветовой параметр");
  }
  return structuredClone(theme);
}
export function validateThemeName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
    throw new Error("Введите название темы длиной от 1 до 80 символов");
  return name.trim();
}
export function themeDocument(name, appearance) {
  return {
    format: "cage-theme",
    version: 1,
    name: validateThemeName(name),
    lightTheme: validateTheme(appearance.lightTheme),
    darkTheme: validateTheme(appearance.darkTheme),
  };
}
export function parseThemeDocument(text) {
  if (new TextEncoder().encode(text).length > themeFileLimit)
    throw new Error("Файл темы не должен превышать 256 КБ");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Не удалось прочитать тему. Выберите допустимый файл JSON");
  }
  if (!object(data) || data.format !== "cage-theme" || data.version !== 1)
    throw new Error("Неподдерживаемый формат или версия темы. Используйте файл темы, экспортированный из Cage");
  if (
    Object.keys(data).some(
      (key) =>
        !["format", "version", "name", "lightTheme", "darkTheme"].includes(key),
    )
  )
    throw new Error("Файл темы содержит неподдерживаемые настройки");
  return themeDocument(data.name, data);
}
export function sameTheme(left, right) {
  const canonical = (theme) => {
    const valid = validateTheme(theme);
    return JSON.stringify([
      valid.preset,
      valid.accent,
      valid.surface,
      valid.ink,
      valid.contrast,
      valid.opaqueWindows,
      valid.fonts.ui,
      valid.fonts.code,
      Object.entries(valid.colors || {}).sort(),
      Object.entries(valid.terminal || {}).sort(),
    ]);
  };
  return (
    canonical(left.lightTheme) === canonical(right.lightTheme) &&
    canonical(left.darkTheme) === canonical(right.darkTheme)
  );
}
