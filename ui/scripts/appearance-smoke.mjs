import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chooseInline, createWorkbench } from "./workbench-fixture.mjs";
const output = fileURLToPath(
  new URL("../../docs/test-reports/2026-10-31-appearance/", import.meta.url),
);
await fs.mkdir(output, { recursive: true });
const { browser, page, state, errors } = await createWorkbench();
const checks = [];
const showAppearance = async () => {
  await page.getByRole("button", { name: /Настройки/ }).click();
  await page.getByRole("button", { name: "Внешний вид", exact: true }).click();
  await page.getByRole("heading", { name: "Внешний вид", exact: true }).waitFor();
};
const saved = () =>
  page
    .getByRole("status")
    .filter({ hasText: /Изменения сохраняются автоматически|Внешний вид Codex синхронизирован/ })
    .waitFor();
const shot = async (name) => {
  await page.locator(".settings-content").evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({
    path: output + name + ".png",
    animations: "disabled",
  });
};
try {
  await page.emulateMedia({ colorScheme: "light" });
  await showAppearance();
  await page
    .getByRole("button", { name: "Синхронизировать с Codex на этом компьютере", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Внешний вид Codex синхронизирован" })
    .waitFor();
  assert.equal(state.appearance.lightTheme.preset, "solarized");
  assert.equal(state.appearance.darkTheme.preset, "ayu");
  assert.equal(
    await page.getByLabel("Размер шрифта интерфейса", { exact: true }).inputValue(),
    "16",
  );
  assert.equal(
    await page.getByLabel("Размер шрифта кода", { exact: true }).inputValue(),
    "13",
  );
  await shot("appearance-light");
  await page.getByRole("button", { name: "Тёмная", exact: true }).click();
  await saved();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "dark",
  );
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--paper"),
    ),
    "#10141c",
  );
  await shot("appearance-dark");
  await page.getByRole("button", { name: "Как в системе", exact: true }).click();
  await saved();
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  checks.push("Импорт настроек этого компьютера, независимое сохранение светлой и тёмной темы, переключение вслед за системой в реальном времени, размеры шрифта 16/13");
  await page
    .getByRole("region", { name: "Тёмная тема", exact: true })
    .getByRole("button", { name: "Своя", exact: true })
    .click();
  await page.getByLabel("Тёмная тема: шрифт кода", { exact: true }).fill("Menlo");
  await saved();
  await page.getByLabel("Тёмная тема: полупрозрачная боковая панель", { exact: true }).uncheck();
  await saved();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.translucent),
    "false",
  );
  await page.getByRole("switch", { name: "Курсор-указатель", exact: true }).check();
  await saved();
  assert.equal(
    await page
      .getByRole("button", { name: "Тёмная", exact: true })
      .evaluate((el) => getComputedStyle(el).cursor),
    "pointer",
  );
  await chooseInline(page.getByLabel("Уменьшить анимацию", { exact: true }), "on");
  await saved();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.reducedMotion),
    "true",
  );
  state.failAppearance = true;
  await page.getByLabel("Размер шрифта кода", { exact: true }).fill("15");
  await page
    .getByRole("alert")
    .filter({ hasText: "Не удалось сохранить настройки оформления" })
    .waitFor();
  assert.equal(
    await page.getByLabel("Размер шрифта кода", { exact: true }).inputValue(),
    "15",
  );
  assert.equal(state.appearance.codeFontSize, 13);
  state.failAppearance = false;
  await page.getByRole("button", { name: "Повторить сохранение", exact: true }).click();
  await saved();
  await page.getByRole("button", { name: "Светлая", exact: true }).click();
  await page.getByRole("button", { name: "Тёмная", exact: true }).click();
  await page.getByRole("button", { name: "Как в системе", exact: true }).click();
  await saved();
  await page.reload();
  await showAppearance();
  assert.equal(
    await page.getByLabel("Размер шрифта кода", { exact: true }).inputValue(),
    "15",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Как в системе", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(state.appearance.darkTheme.fonts.code, "Menlo");
  checks.push(
    "Свои шрифты/полупрозрачность/курсор/анимация, ввод сохраняется при ошибке и повторяется, при быстром переключении побеждает последняя запись, чтение после обновления",
  );
  await page.setViewportSize({ width: 820, height: 558 });
  await shot("appearance-minimum");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).click();
  await page
    .getByRole("button", { name: "Новый терминал", exact: true })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Обычный терминал", exact: true }).click();
  await page.getByRole("tab", { name: "Терминал 1", exact: true }).waitFor();
  const count = state.terminalConnections;
  await showAppearance();
  await page.getByRole("button", { name: "Светлая", exact: true }).click();
  await saved();
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  assert.equal(state.terminalConnections, count);
  assert.equal(
    await page
      .locator(".xterm-char-measure-element")
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize),
    "15px",
  );
  assert.ok(
    !state.requests.some(
      (request) => request.path === "/settings" && request.method === "POST",
    ),
  );
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.screenshot({
    path: output + "terminal-solarized.png",
    animations: "disabled",
  });
  checks.push(
    "Настройки прокручиваются при 820px без горизонтального переполнения, смена внешнего вида сохраняет соединение терминала, интерфейс настроек среды не вызывался",
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    output + "smoke-result.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        scope: "Изолированный интерфейс управления; импорт исходной конфигурации и запись на диск проверяются отдельно реальным сервисом",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser.close();
}
