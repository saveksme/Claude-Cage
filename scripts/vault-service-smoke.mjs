// Full UI -> real Go service -> encrypted disk round trip in a new temp profile.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CAGE_PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "cage-vault-e2e-"));
await fs.writeFile(path.join(profile, "config.json"), JSON.stringify({ proxy_url: "socks5://127.0.0.1:1", dns_url: "https://1.1.1.1/dns-query", timezone: "Etc/UTC", locale: "en_US.UTF-8", browser_language: "en-US" }), { mode: 0o600 });
await fs.writeFile(path.join(profile, "workbench.json"), JSON.stringify({ workspace: path.join(profile, "workspace") }), { mode: 0o600 });
let service, browser, page;
async function start() {
  await fs.rm(path.join(profile, "control.json"), { force: true });
  service = spawn(path.join(root, "_output/vault-qa/cage"), ["serve"], { env: { ...process.env, CLAUDE_CAGE_CONFIG: path.join(profile, "config.json") }, stdio: "ignore" });
  let control;
  for (let i = 0; i < 100; i++) {
    try { control = JSON.parse(await fs.readFile(path.join(profile, "control.json"), "utf8")); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(control, "isolated service did not start");
  const origin = `http://localhost:${control.port}`;
  const response = await fetch(origin + "/api/launch", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: control.token }) });
  assert.ok(response.ok);
  return (await response.json()).url;
}
async function stop() {
  if (service && service.exitCode === null) await new Promise(resolve => { service.once("exit", resolve); service.kill("SIGTERM"); });
}
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(await start());
  await page.getByLabel("Имя пользователя", { exact: true }).fill("vault-qa");
  await page.getByLabel("Задать пароль", { exact: true }).fill("isolated-vault-account-password");
  await page.getByLabel("Подтвердите пароль", { exact: true }).fill("isolated-vault-account-password");
  await page.getByRole("button", { name: "Создать локальный аккаунт", exact: true }).click();
  const openVault = async () => {
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Хранилище паролей", exact: true }).click();
    await page.getByRole("heading", { name: "Хранилище паролей", exact: true }).waitFor();
  };
  await openVault();
  await page.getByRole("button", { name: "Добавить пароль", exact: true }).click();
  await page.getByLabel("Адрес сайта", { exact: true }).fill("https://mail.example.test/login");
  await page.getByLabel("Аккаунт или эл. почта").fill("real-service@example.test");
  await page.getByLabel("Пароль сайта", { exact: true }).fill("isolated-website-secret");
  await page.getByRole("button", { name: "Сохранить запись", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Запись пароля сохранена" }).waitFor();
  const raw = await fs.readFile(path.join(profile, "password-vault.json"), "utf8");
  for (const value of ["real-service@example.test", "isolated-website-secret", "mail.example.test"]) assert.ok(!raw.includes(value), "plaintext persisted");
  const list = await page.evaluate(async () => (await fetch("/api/vault")).json());
  assert.equal(list.entries[0].origin, "https://mail.example.test");
  assert.equal(list.entries[0].password, undefined);
  await stop();
  await page.goto(await start());
  await page.getByLabel("Пароль аккаунта", { exact: true }).fill("isolated-vault-account-password");
  await page.getByRole("button", { name: "Разблокировать Cage", exact: true }).click();
  await openVault();
  await page.getByText("real-service@example.test", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Показать пароль", exact: true }).click();
  await page.getByLabel("Пароль аккаунта Cage", { exact: true }).fill("isolated-vault-account-password");
  await page.getByRole("button", { name: "Подтвердить и показать" }).click();
  await page.getByLabel("Сохранённый пароль сайта").waitFor();
  assert.equal(await page.getByLabel("Сохранённый пароль сайта").textContent(), "isolated-website-secret");
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  await page.getByRole("button", { name: /Меню аккаунта,/ }).click();
  await page.getByRole("menuitem", { name: /Заблокировать Cage/ }).click();
  await page.getByRole("region", { name: "Разблокировать Cage", exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await fetch("/api/vault")).status), 423);
  assert.equal(await fs.readFile(path.join(profile, "password-vault.json"), "utf8"), raw, "restart/lock modified vault data");
  assert.deepEqual(errors, []);
  console.log("PASS: real UI and Go service create/save, encrypted disk, redacted API, service restart, unlock/reveal, lock and data preservation");
} catch (error) {
  console.error((await page?.locator("body").innerText())?.slice(0, 3000));
  throw error;
} finally {
  await browser?.close(); await stop();
  await fs.rm(profile, { recursive: true, force: true });
}
