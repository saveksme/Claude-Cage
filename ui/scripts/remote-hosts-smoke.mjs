// Real client service and browser interaction, using only a fresh temp profile.
// No cloud host or personal Cage configuration is accessed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CAGE_PLAYWRIGHT_MODULE || "playwright");
const executable = process.env.CAGE_CLIENT_BINARY;
if (!executable) throw new Error("Set CAGE_CLIENT_BINARY to the newly built client binary");
const profile = await mkdtemp(join(tmpdir(), "cage-remote-host-ui-"));
const artifacts = resolve(process.env.CAGE_REMOTE_QA_DIR || join(profile, "artifacts"));
await mkdir(artifacts, { recursive: true });
const service = spawn(executable, ["serve"], { env: { ...process.env, CLAUDE_CAGE_CONFIG: join(profile, "config.json") }, stdio: "ignore" });
let browser;
let page;
try {
  let control;
  for (let i = 0; i < 200; i++) {
    try { control = JSON.parse(await readFile(join(profile, "control.json"), "utf8")); break; }
    catch { if (service.exitCode !== null) throw new Error("Client service exited before publishing its private control record"); await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(control, "client service did not start");
  const origin = `http://localhost:${control.port}`;
  const launched = await fetch(`${origin}/api/launch`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ token: control.token }) });
  assert.equal(launched.status, 200);
  const entry = await launched.json();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CAGE_TEST_BROWSER_PATH });
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(entry.url);
  await page.getByRole("complementary", { name: "SSH-хосты", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Войти в локальную рабочую среду" }).count(), 0, "thin client must not offer local workloads");
  assert.equal(await page.getByRole("button", { name: "Создать локальный аккаунт" }).count(), 0, "local account must not block remote setup");
  await page.getByRole("button", { name: "Добавить удалённый хост" }).click();
  await page.getByLabel("Название хоста", { exact: true }).fill("Изолированный тестовый хост UI");
  await page.getByLabel("Адрес сервера", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Порт SSH", { exact: true }).fill("9");
  await page.getByLabel("Имя пользователя SSH", { exact: true }).fill("cage-test");
  const auth = page.getByRole("combobox", { name: "Способ входа SSH" });
  const keyField = page.getByLabel("Файл закрытого ключа на этом компьютере", { exact: true });
  // Opening the floating list keeps both the dialog and its fields in place.
  const gap = async () => (await keyField.boundingBox()).y - (await auth.boundingBox()).y;
  const before = await gap();
  await auth.click();
  await page.getByRole("option", { name: "SSH-агент на этом компьютере" }).waitFor();
  const expanded = await keyField.boundingBox();
  assert.ok(Math.abs(await gap() - before) < 1, "floating choices must not move subsequent fields");
  const list = await page.getByRole("listbox").boundingBox();
  assert.ok(list.height > 0 && Math.abs(expanded.y - (await keyField.boundingBox()).y) < 1);
  await auth.press("Escape");
  assert.equal(await auth.getAttribute("aria-expanded"), "false");
  await page.getByRole("listbox").waitFor({state:"hidden"});
  assert.ok(Math.abs(await gap() - before) < 1, "closing choices restores layout");
  await auth.press("ArrowDown");
  await auth.press("ArrowDown");
  await auth.press("Enter");
  assert.equal(await auth.getAttribute("aria-expanded"), "false");
  assert.equal(await keyField.count(), 0, "keyboard selection switches authentication method");
  await auth.click();
  await page.getByRole("option", { name: "Файл ключа на этом компьютере" }).click();
  await page.screenshot({ path: join(artifacts, "remote-host-form-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "mobile form should not overflow horizontally");
  await page.screenshot({ path: join(artifacts, "remote-host-form-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByLabel("Файл закрытого ключа на этом компьютере", { exact: true }).fill(join(profile, "missing-test-key"));
  await page.getByRole("button", { name: "Сохранить хост", exact: true }).click();
  await page.getByText("Изолированный тестовый хост UI", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Изолированный тестовый хост UI", { exact: true }).waitFor();
  const saved = JSON.parse(await readFile(join(profile, "remote-hosts.json"), "utf8"));
  assert.equal(saved.hosts.length, 1); assert.equal(saved.hosts[0].port, 9);
  await page.getByRole("button", { name: "Подключиться к этому хосту" }).click();
  await page.getByText("SSH-ключ не существует или права на файл небезопасны", { exact: true }).waitFor();
  assert.equal(await page.getByRole("complementary", { name: "SSH-хосты", exact: true }).count(), 1, "failed remote connection must retain host management");
  assert.equal(await page.getByRole("button", { name: "Создать локальный аккаунт" }).count(), 0, "failure must not fall back to a local account");
  await page.screenshot({ path: join(artifacts, "remote-host-error.png"), fullPage: true });
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel("Название хоста", { exact: true }).fill("Изменённый тестовый хост");
  await page.getByRole("button", { name: "Сохранить хост", exact: true }).click();
  await page.getByText("Изменённый тестовый хост", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Удалить подключение", exact: true }).click();
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(await page.getByText("Изменённый тестовый хост", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Удалить подключение", exact: true }).click();
  await page.getByRole("button", { name: "Подтвердить удаление", exact: true }).click();
  await page.getByText("Удалённых хостов пока нет", { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await readFile(join(profile, "remote-hosts.json"), "utf8")).hosts, []);
  assert.deepEqual(errors, []);
  const result = { ok: true, scope: "Реальный локальный сервис cage-client и Chromium; отдельная временная конфигурация; путь ошибки подключения", checks: ["thin-client-no-local-account", "host-crud-and-persistence", "inline-dropdown-layout", "keyboard-choice", "mobile-layout", "connection-error-no-local-fallback", "remove-cancel-and-confirm"], notTested: ["Подключение к реальному облачному серверу и контейнерные нагрузки", "Взаимодействие с нативными окнами macOS, Windows и Linux"], pageErrors: errors };
  await writeFile(join(artifacts, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, artifacts }));
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  console.error(`UI evidence: ${artifacts}`);
  throw error;
} finally {
  await browser?.close();
  service.kill("SIGTERM");
}
