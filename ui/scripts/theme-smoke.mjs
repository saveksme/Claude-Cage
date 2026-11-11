import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chooseInline, createWorkbench } from "./workbench-fixture.mjs";
import {
  themeDocument,
  parseThemeDocument,
  sameTheme,
} from "../src/appearance-state.mjs";
const output = fileURLToPath(
  new URL("../../docs/test-reports/2026-11-02-themes/", import.meta.url),
);
await fs.mkdir(output, { recursive: true });
let imported = "",
  exported,
  cancelExport = false;
const { browser, page, state, errors } = await createWorkbench({
  nativeRequest: (body) => {
    if (body.action === "importTheme") return imported;
    if (body.action === "exportTheme") {
      exported = body;
      return !cancelExport;
    }
    return true;
  },
});
const checks = [];
const open = async () => {
  await page.getByRole("button", { name: /Настройки/ }).click();
  await page.getByRole("button", { name: "Внешний вид", exact: true }).click();
  await page.getByRole("heading", { name: "Внешний вид", exact: true }).waitFor();
  await page.locator(".appearance-fields").evaluate((el) => {
    if (el.disabled) throw new Error("appearance still loading");
  });
};
const saved = async () => {
  await page
    .locator(".appearance-save-state")
    .filter({ hasText: /Изменения сохраняются автоматически|Внешний вид Codex синхронизирован/ })
    .waitFor();
};
const edit = async (label, value) => {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press("Enter");
  await saved();
};
const light = () => page.getByRole("region", { name: "Светлая тема", exact: true });
const color = (key) =>
  page.evaluate(
    (key) => getComputedStyle(document.documentElement).getPropertyValue(key),
    key,
  );
const shot = async (name) => {
  await page.screenshot({
    path: output + name + ".png",
    animations: "disabled",
  });
};
try {
  await page.emulateMedia({ colorScheme: "light" });
  await open();
  await shot("themes-light");
  await edit("Светлая тема · Фон", "#fdf6e3");
  await light().getByRole("button", { name: "Своя", exact: true }).click();
  await light().getByText("Интерфейс и уровни", { exact: true }).click();
  await edit("Светлая тема · Фон панели", "#e8dec3");
  assert.equal(await color("--chrome"), "#e8dec3");
  await light().getByText("Кнопки и взаимодействие", { exact: true }).click();
  await edit("Светлая тема · Фон основной кнопки", "#426b52");
  await edit("Светлая тема · Текст основной кнопки", "#ffffff");
  assert.equal(await color("--button"), "#426b52");
  await light().getByText("Терминал", { exact: true }).click();
  await edit("Светлая тема · терминал · Фон", "#101820");
  await light().getByText("Цвета ANSI терминала", { exact: true }).click();
  await edit("Светлая тема · терминал · Красный", "#f08080");
  await shot("themes-colors");
  const originalChrome = state.appearance.lightTheme.colors.chrome;
  await page.getByLabel("Светлая тема · Фон панели", { exact: true }).fill("#oops");
  await page.getByLabel("Светлая тема · Фон панели", { exact: true }).press("Tab");
  assert.equal(state.appearance.lightTheme.colors.chrome, originalChrome);
  await page.getByLabel("Светлая тема · Фон панели", { exact: true }).press("Escape");
  checks.push("Базовые и элементы применяются сразу, терминал и ANSI переопределяются отдельно, недопустимый HEX не отправляется");
  await page.getByLabel("Название темы", { exact: true }).fill("Лесной дневной свет");
  await page.getByRole("button", { name: "Сохранить как тему", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Тема сохранена" }).waitFor();
  assert.equal(state.appearance.customThemes.length, 1);
  const savedTheme = structuredClone(state.appearance.customThemes[0]);
  await edit("Светлая тема · Фон", "#eeeeee");
  await page
    .getByRole("button", { name: "Вернуть сохранённую палитру", exact: true })
    .click();
  await saved();
  assert.equal(state.appearance.lightTheme.surface, "#fdf6e3");
  await page.getByRole("button", { name: "Экспорт темы", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Тема экспортирована" }).waitFor();
  assert.ok(sameTheme(parseThemeDocument(exported.text), savedTheme));
  assert.equal(exported.filename, "Лесной дневной свет.cage-theme.json");
  cancelExport = true;
  await page.getByRole("button", { name: "Экспорт темы", exact: true }).click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Экспорт темы",
      )?.disabled,
  );
  assert.equal(
    await page.getByRole("status").filter({ hasText: "Тема экспортирована" }).count(),
    0,
  );
  cancelExport = false;
  const original = JSON.stringify(state.appearance);
  imported = "";
  await page.getByRole("button", { name: "Импорт темы", exact: true }).click();
  assert.equal(JSON.stringify(state.appearance), original);
  imported = '{"format":"cage-theme","version":2}';
  await page.getByRole("button", { name: "Импорт темы", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Неподдерживаемый формат или версия темы" })
    .waitFor();
  assert.equal(JSON.stringify(state.appearance), original);
  imported = exported.text;
  await page.getByRole("button", { name: "Импорт темы", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Тема импортирована и применена" })
    .waitFor();
  assert.equal(state.appearance.customThemes.length, 2);
  assert.ok(sameTheme(state.appearance, savedTheme));
  checks.push(
    "Сохранение с именем, восстановление при переключении, содержимое нативного экспорта, импорт с тем же именем не перезаписывает, отмена и недопустимый файл сохраняют настройки",
  );
  const second = state.appearance.customThemes[1];
  await edit("Светлая тема · Фон", "#f5efdd");
  await page.getByLabel("Название темы", { exact: true }).fill("Лесной дневной свет II");
  await page.getByRole("button", { name: "Обновить эту тему", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Тема сохранена" }).waitFor();
  assert.equal(state.appearance.customThemes[1].id, second.id);
  assert.equal(state.appearance.customThemes[1].name, "Лесной дневной свет II");
  assert.equal(state.appearance.customThemes[0].name, "Лесной дневной свет");
  state.failAppearance = true;
  await page.getByLabel("Светлая тема · Фон", { exact: true }).fill("#fafafa");
  await page.getByLabel("Светлая тема · Фон", { exact: true }).press("Enter");
  await page
    .getByRole("alert")
    .filter({ hasText: "Не удалось сохранить настройки оформления" })
    .waitFor();
  assert.equal(await color("--paper"), "#fafafa");
  assert.equal(state.appearance.lightTheme.surface, "#f5efdd");
  state.failAppearance = false;
  await page.getByRole("button", { name: "Повторить сохранение", exact: true }).click();
  await saved();
  await page.reload();
  await open();
  assert.equal(state.appearance.customThemes.length, 2);
  assert.equal(
    await page.getByLabel("Светлая тема · Фон", { exact: true }).inputValue(),
    "#fafafa",
  );
  await chooseInline(page
    .getByLabel("Сохранённые темы", { exact: true }), second.id);
  await saved();
  assert.equal(
    await page.getByLabel("Светлая тема · Фон", { exact: true }).inputValue(),
    "#f5efdd",
  );
  // Codex sync must preserve the user's library.
  await page
    .getByRole("button", { name: "Синхронизировать с Codex на этом компьютере", exact: true })
    .click();
  await saved();
  assert.equal(state.appearance.customThemes.length, 2);
  await chooseInline(page
    .getByLabel("Сохранённые темы", { exact: true }), second.id);
  await saved();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  assert.equal(state.appearance.customThemes.length, 2);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await saved();
  assert.equal(state.appearance.customThemes.length, 1);
  assert.equal(state.appearance.lightTheme.surface, "#f5efdd");
  checks.push(
    "Обновление темы, предпросмотр сохраняется при ошибке и повторяется, чтение после обновления, синхронизация Codex сохраняет библиотеку тем, подтверждение удаления и сохранение текущей палитры",
  );
  // Exercise the actual browser file input and download fallback as well.
  await page.evaluate(() => {
    delete window.webkit;
  });
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт темы", exact: true }).click();
  const download = await downloadEvent;
  const path = output + "browser-export.cage-theme.json";
  await download.saveAs(path);
  const data = parseThemeDocument(await fs.readFile(path, "utf8"));
  assert.ok(sameTheme(data, state.appearance));
  await page.getByLabel("Выбрать файл темы", { exact: true }).setInputFiles(path);
  await page
    .getByRole("status")
    .filter({ hasText: "Тема импортирована и применена" })
    .waitFor();
  assert.equal(state.appearance.customThemes.length, 2);
  await page.getByRole("button", { name: "Тёмная", exact: true }).click();
  await saved();
  await page.locator(".settings-content").evaluate((el) => el.scrollTo(0, 0));
  await shot("themes-dark");
  await page.setViewportSize({ width: 820, height: 558 });
  await shot("themes-minimum");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await light().getByRole("button", { name: "Своя", exact: true }).click();
  await light().getByText("Интерфейс и уровни", { exact: true }).click();
  const row = page.getByLabel("Светлая тема · Фон панели", { exact: true });
  await row.scrollIntoViewIfNeeded();
  await shot("themes-minimum-colors");
  const bounds = await row.boundingBox();
  assert.ok(bounds.x + bounds.width <= 820);
  await page.getByRole("button", { name: "Светлая", exact: true }).click();
  await saved();
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  await page
    .getByRole("button", { name: "Запустить среду Cage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Новый терминал", exact: true })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Обычный терминал", exact: true }).click();
  await page.getByRole("tab", { name: "Терминал 1", exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".xterm-scrollable-element")].some(
      (el) => getComputedStyle(el).backgroundColor === "rgb(16, 24, 32)",
    ),
  );
  await shot("themes-terminal");
  const connections = state.terminalConnections;
  await open();
  await light().getByRole("button", { name: "Своя", exact: true }).click();
  await light().getByText("Терминал", { exact: true }).click();
  await edit("Светлая тема · терминал · Фон", "#202830");
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".xterm-scrollable-element")].some(
      (el) => getComputedStyle(el).backgroundColor === "rgb(32, 40, 48)",
    ),
  );
  assert.equal(state.terminalConnections, connections);
  checks.push(
    "Загрузка и скачивание файлов браузера, светлая и тёмная темы без переполнения при 820px, существующий терминал меняет цвета без переподключения",
  );
  assert.deepEqual(errors, []);
  assert.ok(
    !state.requests.some(
      (request) => request.path === "/settings" && request.method === "POST",
    ),
  );
  await fs.writeFile(
    output + "result.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        scope: "Настоящий фронтенд и xterm, изолированный интерфейс управления; запись Go и нативная сборка проверяются отдельно",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser.close();
}
