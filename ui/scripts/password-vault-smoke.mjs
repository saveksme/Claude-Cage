import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createWorkbench } from "./workbench-fixture.mjs";
const output = process.env.CAGE_VAULT_CAPTURE || fileURLToPath(new URL("../../docs/test-reports/2026-11-05-password-vault/", import.meta.url));
await fs.mkdir(output, { recursive: true });
let clipboard = "";
const { browser, page, state, errors } = await createWorkbench({ nativeRequest: async ({ action, text }) => {
  if (action === "clipboardWrite") { clipboard = text; return true; }
  return null;
} });
let entries = [], blocked = [], candidate = null, filled = null, sequence = 0;
await page.route("**/api/vault**", async route => {
  const req = route.request(), input = req.method() === "POST" ? req.postDataJSON() : {};
  if (!state.account.unlocked) return route.fulfill({ status: 423, body: "Cage заблокирован" });
  const redacted = value => { const { password, ...rest } = value; return rest; };
  if (new URL(req.url()).pathname === "/api/vault/browser") {
    if (input.action === "status") return route.fulfill({ json: {
      available: true, origin: "https://mail.example.test", document: "fixture-document",
      entries: entries.filter(e => e.origin === "https://mail.example.test").map(redacted),
      candidates: candidate ? [{ ...redacted(candidate), update: entries.some(e => e.origin === candidate.origin && e.username === candidate.username) }] : [],
    } });
    if (input.action === "fill") { assert.equal(input.document, "fixture-document"); filled = input.id; }
    if (input.action === "save") {
      const existing = entries.find(e => e.origin === candidate.origin && e.username === candidate.username);
      if (existing) existing.password = candidate.password;
      else entries.push({ ...candidate, id: `saved-${++sequence}` });
      candidate = null;
    }
    if (input.action === "never") { blocked.push(candidate.origin); candidate = null; }
    if (input.action === "dismiss") candidate = null;
    return route.fulfill({ json: { ok: true } });
  }
  if (req.method() === "GET") return route.fulfill({ json: { entries: entries.map(redacted), blocked } });
  if (input.action === "save") {
    const entry = input.entry;
    const existing = entries.find(e => e.id === entry.id);
    if (existing) Object.assign(existing, entry, { password: entry.password || existing.password });
    else entries.push({ ...entry, id: `saved-${++sequence}` });
  }
  if (input.action === "reveal") {
    if (input.account_password !== state.accountPassword) return route.fulfill({ status: 400, body: "Неверный пароль" });
    return route.fulfill({ json: { password: entries.find(e => e.id === input.id).password } });
  }
  if (input.action === "delete") entries = entries.filter(e => e.id !== input.id);
  if (input.action === "unblock") blocked = blocked.filter(e => e !== input.origin);
  return route.fulfill({ json: { ok: true } });
});
const settings = async () => {
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Хранилище паролей", exact: true }).click();
  await page.getByRole("heading", { name: "Хранилище паролей", exact: true }).waitFor();
};
try {
  await settings();
  await page.getByText("Пароли ещё не сохранены", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Добавить пароль", exact: true }).click();
  await page.getByLabel("Адрес сайта", { exact: true }).fill("https://mail.example.test");
  await page.getByLabel("Аккаунт или эл. почта").fill("alice@example.test");
  await page.getByLabel("Пароль сайта", { exact: true }).fill("fixture-mail-secret");
  await page.getByRole("button", { name: "Сохранить запись", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Запись пароля сохранена" }).waitFor();
  assert.equal(entries.length, 1);
  assert.equal(await page.getByText("fixture-mail-secret", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Показать пароль", exact: true }).click();
  await page.getByLabel("Пароль аккаунта Cage", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Подтвердить и показать" }).click();
  await page.getByRole("alert").filter({ hasText: "Неверный пароль" }).waitFor();
  assert.equal(await page.getByLabel("Сохранённый пароль сайта").count(), 0);
  await page.getByLabel("Пароль аккаунта Cage", { exact: true }).fill(state.accountPassword);
  await page.getByRole("button", { name: "Подтвердить и показать" }).click();
  await page.getByLabel("Сохранённый пароль сайта").waitFor();
  assert.equal(await page.getByLabel("Сохранённый пароль сайта").textContent(), "fixture-mail-secret");
  await page.getByRole("button", { name: "Скрыть пароль" }).click();
  await page.getByRole("button", { name: "Скопировать пароль", exact: true }).click();
  await page.getByLabel("Пароль аккаунта Cage", { exact: true }).fill(state.accountPassword);
  await page.getByRole("button", { name: "Подтвердить и скопировать" }).click();
  await page.getByRole("status").filter({ hasText: "Пароль скопирован в буфер обмена этого компьютера" }).waitFor();
  assert.equal(clipboard, "fixture-mail-secret");
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel("Аккаунт или эл. почта").fill("work@example.test");
  await page.getByRole("button", { name: "Сохранить запись", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Запись пароля сохранена" }).waitFor();
  assert.equal(entries[0].password, "fixture-mail-secret");
  await page.getByLabel("Поиск сайта или аккаунта").fill("missing");
  await page.getByText("Подходящие аккаунты не найдены").waitFor();
  await page.getByLabel("Поиск сайта или аккаунта").fill("");
  await page.screenshot({ path: output + "vault-settings.png" });
  await page.setViewportSize({ width: 820, height: 558 });
  await page.screenshot({ path: output + "vault-settings-small.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  state.status.ready = true; state.status.vm_running = true;
  state.tabs = [{ id: "web-vault", title: "Почта", kind: "web", url: "https://mail.example.test/login" }]; state.active = "web-vault";
  await page.reload();
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  await page.getByRole("button", { name: "Меню браузера", exact: true }).click();
  await page.getByRole("menuitem", { name: /Пароли · аккаунтов: 1/ }).waitFor();
  const trigger = page.getByRole("menuitem", { name: /Пароли · аккаунтов: 1/ });
  const before = await page.locator(".browser-chrome").boundingBox();
  await trigger.press("Enter");
  const picker = page.getByRole("region", { name: "Пароли текущего сайта" });
  await picker.waitFor();
  const after = await page.locator(".browser-chrome").boundingBox();
  assert.ok(after.height > before.height + 60, "password picker did not occupy layout space");
  await picker.getByRole("button", { name: /work@example.test/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("status").filter({ hasText: "Заполнено" }).waitFor();
  assert.equal(filled, entries[0].id);
  const filledHeight = (await page.locator(".browser-chrome").boundingBox()).height;
  const pickerHeight = (await picker.boundingBox()).height;
  await trigger.press("Escape");
  await picker.waitFor({ state: "hidden" });
  assert.equal(Math.round((await page.locator(".browser-chrome").boundingBox()).height), Math.round(filledHeight - pickerHeight),
    "closing the password picker releases its space while preserving the fill confirmation");
  candidate = { id: "pending", tab: "web-vault", origin: "https://mail.example.test", username: "work@example.test", password: "new-fixture-secret" };
  await page.getByText("Обновить пароль этого аккаунта?", { exact: true }).waitFor();
  await page.screenshot({ path: output + "vault-save-prompt.png" });
  await page.getByRole("button", { name: "Обновить пароль", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Пароль сохранён" }).waitFor();
  assert.equal(entries[0].password, "new-fixture-secret");
  candidate = { id: "ignored", tab: "web-vault", origin: "https://mail.example.test", username: "other", password: "ignored" };
  await page.getByRole("button", { name: "Не предлагать для этого сайта", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Для этого сайта сохранение больше не предлагается" }).waitFor();
  await settings();
  await page.getByRole("button", { name: "Восстановить предложение", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Предложение сохранения для этого сайта восстановлено" }).waitFor();
  assert.deepEqual(blocked, []);
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.getByRole("button", { name: "Удалить пароль", exact: true }).click();
  await page.getByText("Пароли ещё не сохранены", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Вернуться в рабочую среду", exact: true }).click();
  await page.getByRole("button", { name: /Меню аккаунта,/ }).click();
  await page.getByRole("menuitem", { name: /Заблокировать Cage/ }).click();
  await page.getByRole("region", { name: "Разблокировать Cage", exact: true }).waitFor();
  assert.equal(await page.locator(".vault-browser").count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: vault UI CRUD, search, reauthentication, clipboard, inline keyboard picker, save/update/never, lock and small viewport");
} finally { await browser.close(); }
