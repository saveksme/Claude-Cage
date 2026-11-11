import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chooseInline, createWorkbench } from "./workbench-fixture.mjs";

const output = new URL("../../docs/test-reports/2026-11-01-manual-region/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const { browser, page, state, errors } = await createWorkbench();
try {
  state.settings.auto_language = true;
  await page.reload();
  await page.route("**/api/settings/probe", (route) => route.fulfill({
    status: 400,
    json: { error: "IP-адрес выхода получен, но все запросы местоположения не удались. Повторите попытку или смените узел. Прямое подключение не использовалось" },
  }));
  const policy = structuredClone(state.settings.exit_policy);
  await page.getByRole("button", { name: /Настройки/ }).click();
  await page.getByRole("button", { name: "Часовой пояс и язык", exact: true }).click();
  await page.getByRole("button", { name: "Проверить сейчас", exact: true }).first().click();
  await page.getByRole("alert").filter({ hasText: "все запросы местоположения не удались" }).waitFor();
  await page.getByRole("button", { name: "Настроить часовой пояс и язык вручную", exact: true }).click();
  assert.equal(await page.getByRole("switch").nth(0).isChecked(), false);
  assert.equal(await page.getByRole("switch").nth(1).isChecked(), false);
  await page.getByLabel("Часовой пояс системы", { exact: true }).fill("Asia/Tokyo");
  await chooseInline(page.getByRole("combobox", { name: "Язык системы", exact: true }), "ja_JP.UTF-8");
  await chooseInline(page.getByRole("combobox", { name: "Предпочитаемый язык сайтов", exact: true }), "ja-JP");
  await page.getByText("Для любого выхода по-прежнему запрашивается страна или регион, чтобы исключить материковый Китай.", { exact: false }).waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("manual-settings.png", output)) });
  await page.getByRole("button", { name: "Сохранить настройки", exact: true }).click();
  await page.getByRole("heading", { name: "Часовой пояс и язык", exact: true }).waitFor({ state: "hidden" });
  assert.equal(state.settings.auto_timezone, false);
  assert.equal(state.settings.auto_language, false);
  assert.equal(state.settings.timezone, "Asia/Tokyo");
  assert.equal(state.settings.locale, "ja_JP.UTF-8");
  assert.equal(state.settings.browser_language, "ja-JP");
  assert.deepEqual(state.settings.exit_policy, policy);
  await page.reload();
  await page.getByRole("button", { name: /Настройки/ }).click();
  await page.getByRole("button", { name: "Часовой пояс и язык", exact: true }).click();
  assert.equal(await page.getByLabel("Часовой пояс системы", { exact: true }).inputValue(), "Asia/Tokyo");
  assert.equal(await page.getByRole("combobox", { name: "Язык системы", exact: true }).getAttribute("value"), "ja_JP.UTF-8");
  assert.equal(await page.getByRole("combobox", { name: "Предпочитаемый язык сайтов", exact: true }).getAttribute("value"), "ja-JP");
  assert.equal(await page.getByRole("switch").nth(0).isChecked(), false);
  assert.equal(await page.getByRole("switch").nth(1).isChecked(), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ["failed lookup recovery", "manual fields editable", "manual values saved and reloaded", "exit policy preserved"] }));
} finally {
  await browser.close();
}
