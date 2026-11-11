import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { smokeCaptureDirectory } from "./smoke-captures.mjs";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = await smokeCaptureDirectory("recovery-ui");
const calls = [];
let update = { phase: "available", currentVersion: "0.2.0-alpha.1", latestVersion: "0.2.0-alpha.2", message: "Доступна новая версия, можно скачать обновление", retryable: true };
const fixture = await createWorkbench({ nativeRequest: async (body) => {
  calls.push(body);
  if (body.action === "workbenchReady") return true;
  if (body.action !== "appUpdate") return null;
  if (body.operation === "install") update = { ...update, phase: "downloading", receivedBytes: 50, totalBytes: 100, message: "Загрузка обновления 50%" };
  if (body.operation === "cancel") update = { ...update, phase: "available", message: "Обновление приостановлено; повторите попытку позже" };
  return update;
} });
const { browser, page, state, errors } = fixture;
const checks = [];
try {
  await page.getByRole("button", { name: "Скачать обновление", exact: true }).waitFor();
  const button = page.getByRole("button", { name: "Скачать обновление", exact: true });
  assert.match(await button.getAttribute("title"), /После нажатия среда будет остановлена, обновление установлено/);
  const bounds = await button.boundingBox();
  assert.ok(bounds.x < 248 && bounds.y > 700, "update action is not in the bottom-left sidebar");
  await page.screenshot({ path: join(output, "update-available.png") });
  await button.click();
  assert.equal(calls.filter((call) => call.operation === "install").length, 1);
  await page.getByRole("progressbar", { name: "Прогресс скачивания обновления" }).waitFor();
  assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "50");
  assert.equal(await page.getByRole("dialog", { name: "Обновление Cage" }).count(), 0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cage-app-update", { detail: { phase: "failed", latestVersion: "0.2.0-alpha.2", message: "Источник обновлений временно недоступен; репозиторий ещё не опубликован", retryable: true } })));
  await page.getByRole("button", { name: "Повторить обновление", exact: true }).waitFor();
  await page.getByRole("alert").filter({ hasText: "Источник обновлений временно недоступен; репозиторий ещё не опубликован" }).waitFor();
  checks.push("bottom-left update affordance", "single install request without a dialog", "inline ring progress", "private source failure visible");

  const downloads = [{ id: "qa-download", name: "report.txt", state: "failed", error: "Целевой каталог временно недоступен для записи", retryable: true }];
  let retries = 0, editorRestarts = 0, componentUpdates = 0;
  await page.route("**/api/browser/tabs", (route) => route.fulfill({ json: { tabs: state.tabs, active: state.active, downloads } }));
  await page.route("**/api/browser/download-retry", (route) => {
    assert.deepEqual(route.request().postDataJSON(), { id: "qa-download" });
    retries++;
    Object.assign(downloads[0], { state: "saved", retryable: false, error: "", path: "/Users/you/Cage/Downloads/report.txt" });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/browser/editor-restart", (route) => {
    assert.equal(route.request().postDataJSON().workspace, state.settings.workspace);
    editorRestarts++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/environment/versions", (route) => route.fulfill({ json: {
    vm_running: true, controller: { version: "0.2.0-alpha.2" }, components: { status: "update_required", update_required: true },
    tools: { chromium: { current: "156", required: "обновление безопасности системы" }, code_server: { current: "4.100", required: "4.144.0" } }, tools_update_allowed: false,
  } }));
  await page.route("**/api/environment/update", (route) => { componentUpdates++; return route.fulfill({ json: { id: "qa-components" } }); });
  await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).click();
  await page.getByRole("heading", { name: "Среда Cage готова", exact: true }).waitFor();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  await page.getByRole("button", { name: "Загрузки браузера", exact: true }).click();
  await page.getByRole("dialog", { name: "Скачать файл" }).getByText("Целевой каталог временно недоступен для записи", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Повторить сохранение", exact: true }).click();
  await page.getByText("Сохранено на этот компьютер", { exact: true }).waitFor();
  assert.equal(retries, 1);
  await page.screenshot({ path: join(output, "download-recovery.png") });
  await page.getByRole("dialog", { name: "Скачать файл" }).getByRole("button", { name: "Закрыть панель" }).click();
  await page.getByRole("button", { name: "Открыть редактор проекта Рабочая область по умолчанию", exact: true }).click();
  await page.getByRole("button", { name: "Меню браузера", exact: true }).click();
  await page.getByRole("menuitem", { name: "Восстановить редактор", exact: true }).click();
  await page.getByRole("dialog", { name: "Перезапустить редактор?" }).getByRole("button", { name: "Перезапустить редактор", exact: true }).click();
  await page.getByText("Редактор восстановлен", { exact: true }).waitFor();
  assert.equal(editorRestarts, 1);
  assert.equal(state.status.vm_running, true);
  checks.push("download retry reports durable save", "editor recovery leaves VM running");
  await page.getByRole("button", { name: "Настройки", exact: false }).first().click();
  await page.getByRole("button", { name: "Среда и восстановление", exact: true }).click();
  await page.getByRole("region", { name: "Версии среды" }).getByText("Требуется обновление", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Обновить инструменты среды", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Обновить инструменты среды", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "environment-versions.png") });
  await page.getByRole("button", { name: "Обновить компоненты среды", exact: true }).click();
  await page.getByRole("dialog", { name: "Обновить компоненты среды?" }).getByRole("button", { name: "Обновить компоненты", exact: true }).click();
  await page.waitForTimeout(50);
  assert.equal(componentUpdates, 1);
  assert.ok(calls.some((call) => call.action === "workbenchReady"), "successful initialized workbench did not acknowledge launch");
  assert.deepEqual(errors, []);
  checks.push("environment versions and guarded tool update", "explicit component update", "initialized workbench launch acknowledgement");
} finally { await browser.close(); }

let prematureReady = false;
const broken = await createWorkbench({ startupFailure: true, nativeRequest: async (body) => {
  if (body.action === "workbenchReady") prematureReady = true;
  return { phase: "current", currentVersion: "0.2.0-alpha.2" };
} });
try {
  await broken.page.waitForResponse((response) => response.url().endsWith("/api/status") && response.status() === 503);
  await broken.page.waitForTimeout(100);
  assert.equal(prematureReady, false, "failed API initialization acknowledged update success");
  checks.push("startup failure never acknowledges upgrade");
} finally { await broken.browser.close(); }
await fs.writeFile(join(output, "ui-checks.json"), JSON.stringify({ checks }, null, 2));
console.log(JSON.stringify({ checks }));
