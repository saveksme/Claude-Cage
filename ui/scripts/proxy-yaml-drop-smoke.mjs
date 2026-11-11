// Frontend interaction checks with synthetic files and isolated API fixtures.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createWorkbench } from "./workbench-fixture.mjs";

const engine = process.env.CAGE_TEST_BROWSER || "chromium";
const output = path.resolve(process.env.CAGE_YAML_QA_OUTPUT || "/tmp/cage-yaml-drop-qa", engine);
await fs.mkdir(output, { recursive: true });
const { browser, page, state, errors } = await createWorkbench({ viewport: { width: 1280, height: 1000 } });
const yaml = "proxies:\n  - {name: Локальный тест, type: socks5, server: 127.0.0.1, port: 1080}\n";
const proxy = { active: false, sources: [], port: 17896, core_available: true };
const imports = [];
try {
  await page.route("**/api/proxy", (route) => route.fulfill({ json: proxy }));
  await page.route("**/api/proxy/import", (route) => {
    const body = route.request().postDataJSON();
    imports.push(body);
    const job = { id: "yaml-drop-import", running: false, message: "Импортировано" };
    state.status.job = job;
    proxy.sources.push({ id: "drop-source", name: body.name, nodes: [{ id: "drop-node", name: "Локальный тест", type: "socks5" }], remote: false, updated_at: new Date().toISOString() });
    return route.fulfill({ json: job });
  });
  const open = async () => {
    await page.getByRole("button", { name: /Настройки/ }).click();
    await page.getByRole("button", { name: "Сеть и прокси", exact: true }).click();
    await page.getByRole("tab", { name: "Подписки", exact: true }).click();
    await page.getByRole("button", { name: "Добавить источник", exact: true }).click();
    await page.getByRole("button", { name: "Локальный YAML", exact: true }).click();
  };
  await open();
  const region = page.locator(".proxy-yaml-input");
  const dropzone = page.locator(".proxy-yaml-dropzone");
  const editor = page.getByRole("textbox", { name: "YAML узлов", exact: true });
  const name = page.getByLabel("Название источника", { exact: true });
  const submit = page.getByRole("button", { name: "Импортировать и проверить", exact: true });
  const expectText = async (locator, value) => {
    await locator.filter({ hasText: value }).waitFor();
  };
  const dataTransfer = async (files) => page.evaluateHandle((entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([entry.content || ""], entry.name, { type: entry.type || "application/yaml" }));
    return transfer;
  }, files);
  const drop = async (files, target = dropzone) => {
    const transfer = await dataTransfer(files);
    await target.dispatchEvent("dragenter", { dataTransfer: transfer });
    await target.dispatchEvent("dragover", { dataTransfer: transfer });
    await target.dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
  };
  const payload = (filename = "повседневный прокси.yaml", content = yaml) => ({ name: filename, mimeType: "application/yaml", buffer: Buffer.from(content) });
  const fileInput = region.locator('input[type="file"]');
  assert.equal(await submit.isDisabled(), true);
  await dropzone.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, "empty.png"), fullPage: true });

  // Keyboard activation reaches the actual file input, including same-file reselection.
  await dropzone.focus();
  const firstChooser = page.waitForEvent("filechooser");
  await dropzone.press("Enter");
  await (await firstChooser).setFiles(payload());
  await expectText(region.getByRole("status"), "Файл прочитан");
  assert.equal(await editor.inputValue(), yaml);
  assert.equal(await name.inputValue(), "повседневный прокси.yaml");
  assert.equal(await submit.isEnabled(), true);
  await editor.fill(yaml + "# ручная правка\n");
  await expectText(region.getByRole("status"), "Содержимое изменено");
  await dropzone.focus();
  const secondChooser = page.waitForEvent("filechooser");
  await dropzone.press("Space");
  await (await secondChooser).setFiles(payload());
  await page.waitForFunction((expected) => document.querySelector('[aria-label="YAML узлов"]').value === expected, yaml);
  await name.fill("Мой источник");

  // Nested drag events must keep the highlight until the pointer leaves the region.
  const transfer = await dataTransfer([{ name: "замена.YML", content: yaml + "# перетащено\n" }]);
  await dropzone.dispatchEvent("dragenter", { dataTransfer: transfer });
  await dropzone.locator("strong").dispatchEvent("dragenter", { dataTransfer: transfer });
  await dropzone.dispatchEvent("dragleave", { dataTransfer: transfer });
  assert.match(await region.getAttribute("class"), /is-dragging/);
  await expectText(dropzone, "Отпустите, чтобы прочитать файл конфигурации");
  await page.screenshot({ path: path.join(output, "dragging.png"), fullPage: true });
  await editor.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await expectText(dropzone, "замена.YML");
  assert.equal(await editor.inputValue(), yaml + "# перетащено\n");
  assert.equal(await name.inputValue(), "Мой источник", "replacement preserves the explicit source name");
  assert.doesNotMatch(await region.getAttribute("class"), /is-dragging/);

  const preserved = await editor.inputValue();
  for (const [files, message] of [
    [[{ name: "image.png", content: "image" }], "Выберите файл конфигурации .yaml, .yml или .json."],
    [[{ name: "a.yaml", content: yaml }, { name: "b.yml", content: yaml }], "За один раз можно импортировать только один файл конфигурации"],
    [[{ name: "empty.yaml", content: "  " }], "Файл пуст"],
  ]) {
    await drop(files);
    await expectText(region.getByRole("alert"), message);
    assert.equal(await editor.inputValue(), preserved);
  }
  await fileInput.setInputFiles(payload("large.yaml", "x".repeat(8 * 1024 * 1024 + 1)));
  await expectText(region.getByRole("alert"), "Файл больше 8 MiB");
  assert.equal(await editor.inputValue(), preserved);
  await page.screenshot({ path: path.join(output, "error.png"), fullPage: true });
  await page.evaluate(() => {
    window.originalFileText = File.prototype.text;
    File.prototype.text = function () { return Promise.reject(new Error("Synthetic read failure")); };
  });
  await drop([{ name: "unreadable.yaml", content: yaml }]);
  await expectText(region.getByRole("alert"), "Не удалось прочитать файл");
  assert.equal(await editor.inputValue(), preserved);
  await page.evaluate(() => { File.prototype.text = window.originalFileText; });

  // A newer file must win even if an earlier asynchronous read completes later.
  await page.evaluate(() => {
    File.prototype.text = function () {
      if (this.name === "slow.yaml") return new Promise((resolve) => { window.finishSlowRead = resolve; });
      return window.originalFileText.call(this);
    };
  });
  await drop([{ name: "slow.yaml", content: yaml }]);
  await expectText(region.getByRole("status"), "Чтение файла, подождите.");
  assert.equal(await submit.isDisabled(), true);
  await drop([{ name: "последний.json", content: '{"proxies": []}' }]);
  await expectText(dropzone, "последний.json");
  await page.evaluate(() => window.finishSlowRead("stale content"));
  assert.equal(await editor.inputValue(), '{"proxies": []}');
  await drop([{ name: "slow.yaml", content: yaml }]);
  await expectText(region.getByRole("status"), "Чтение файла, подождите.");
  await page.getByRole("button", { name: "Ссылка на подписку", exact: true }).click();
  await page.evaluate(() => window.finishSlowRead("stale content"));
  await page.getByRole("button", { name: "Локальный YAML", exact: true }).click();
  assert.equal(await editor.inputValue(), "");
  await page.evaluate(() => { File.prototype.text = window.originalFileText; });

  const origin = page.url();
  await drop([{ name: "outside.yaml", content: yaml }], page.locator("h4").filter({ hasText: "Добавить источник узлов" }));
  assert.equal(page.url(), origin);
  assert.equal(await editor.inputValue(), "");
  await drop([{ name: "итоговая-конфигурация.yaml", content: yaml }]);
  await expectText(dropzone, "итоговая-конфигурация.yaml");
  await editor.fill(yaml + "# изменено\n");
  await page.locator(".proxy-import").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(output, "selected.png"), fullPage: true });
  await page.locator(".proxy-import").screenshot({ path: path.join(output, "preview.png") });

  // Test the component's narrow layout in the existing settings shell.
  await page.setViewportSize({ width: 375, height: 1000 });
  await dropzone.scrollIntoViewIfNeeded();
  const box = await dropzone.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 376, "dropzone stays within the narrow viewport");
  await page.screenshot({ path: path.join(output, "narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.locator(".proxy-import").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(output, "dark.png"), fullPage: true });
  await submit.click();
  await expectText(page.locator(".proxy-notice"), "Импортировано узлов: 1");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].content, yaml + "# изменено\n");
  assert.equal(imports[0].name, "Мой источник");
  assert.equal(imports[0].interval_hours, 0);
  await expectText(page.locator(".proxy-source"), "Мой источник");
  assert.deepEqual(errors, []);
  const result = { engine, passed: true, imports: imports.length, browserErrors: errors, scope: "Synthetic browser file drops and file chooser; mocked API. Native OS drag and backend validation are outside this check." };
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
