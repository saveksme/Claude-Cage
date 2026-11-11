import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createWorkbench } from "./workbench-fixture.mjs";
const output = new URL(
  "../../docs/test-reports/2026-11-02-claude-desktop/",
  import.meta.url,
);
await fs.mkdir(output, { recursive: true });
const { browser, page, state, errors } = await createWorkbench();
await page.addInitScript(() => {
  window.EventSource = class extends EventTarget {
    constructor() { super(); window.desktopBrowserEvents = this; }
    close() {}
  };
});
const desktop = {
  installed: false,
  running: false,
  version: "",
  failed: false,
};
let failInstall = true;
const actions = [];
await page.route("**/api/claude-desktop**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/vnc-credentials"))
    return route.fulfill({ json: { password: "fixture-only" } });
  if (route.request().method() === "GET")
    return route.fulfill({ json: desktop });
  if (path.endsWith("/resize")) return route.fulfill({ json: { ok: true } });
  const action = path.split("/").at(-1);
  actions.push(action);
  const job = {
    id: "desktop-" + actions.length,
    kind: "claude-desktop-" + action,
    running: false,
    message: "Завершено",
  };
  if (action === "install" && failInstall)
    job.error = "Тест: источник установки временно недоступен; повторите";
  else if (action === "install")
    Object.assign(desktop, { installed: true, version: "4.4212.0" });
  else if (action === "start") desktop.running = true;
  else if (action === "stop") desktop.running = false;
  state.status.job = job;
  await route.fulfill({ json: job });
});
try {
  state.status.vm_running = true;
  state.status.ready = true;
  await page.reload();
  await page.getByRole("button", { name: "claude.ai", exact: true }).click();
  assert.equal(
    state.requests.find((x) => x.path === "/browser/new").body.url,
    "https://claude.ai/",
  );
  await page
    .getByRole("button", { name: "Claude Desktop", exact: true })
    .click();
  await page.getByRole("button", { name: "Скачать и установить", exact: true }).waitFor();
  assert.deepEqual(
    actions,
    [],
    "opening the entry must not download without clicking install",
  );
  await page.screenshot({
    path: fileURLToPath(new URL("desktop-install.png", output)),
  });
  await page.getByRole("button", { name: "Скачать и установить", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "источник установки временно недоступен" })
    .waitFor();
  assert.equal(desktop.installed, false);
  failInstall = false;
  await page.getByRole("button", { name: "Скачать и установить", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть приложение", exact: true }).waitFor();
  assert.deepEqual(actions, ["install", "install", "start"]);
  const desktopToolbar = page.locator(".claude-desktop-toolbar");
  const sendBrowserState = (focus) => page.evaluate((snapshot) => {
    window.desktopBrowserEvents.onmessage({ data: JSON.stringify(snapshot) });
  }, { tabs: state.tabs, active: state.active, focus });
  await sendBrowserState(false);
  await desktopToolbar.waitFor();
  const loginTab = { id: "desktop-login", kind: "web", title: "Desktop sign in", url: "https://claude.com/cai/login/app-google-auth" };
  state.tabs.push(loginTab);
  state.active = loginTab.id;
  await sendBrowserState(true);
  await desktopToolbar.waitFor({ state: "hidden" });
  assert.equal(desktop.running, true, "opening an external login page must preserve Desktop");
  await page.getByRole("button", { name: "Claude Desktop", exact: true }).click();
  await sendBrowserState(false);
  await desktopToolbar.waitFor();
  state.tabs.push({ ...loginTab, id: "desktop-login-poll" });
  state.active = "desktop-login-poll";
  await desktopToolbar.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("textbox", { name: "Адрес страницы или поисковый запрос" }).inputValue(), loginTab.url);
  await page.getByRole("button", { name: "Открыть браузер", exact: true }).click();
  assert.equal(
    desktop.running,
    true,
    "changing views must not stop the desktop",
  );
  await page
    .getByRole("button", { name: "Claude Desktop", exact: true })
    .click();
  await page.getByRole("button", { name: "Закрыть приложение", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть приложение", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть Claude Desktop", exact: true })
    .waitFor();
  assert.equal(desktop.running, false);
  const stoppedActions = actions.length;
  await page.getByRole("button", { name: "Обновить состояние Claude Desktop" }).click();
  assert.equal(
    actions.length,
    stoppedActions,
    "refresh must not reopen a stopped app",
  );
  await page.getByRole("button", { name: /Настройки/ }).click();
  await page
    .getByLabel("Команда запуска терминала Claude", { exact: true })
    .fill("claude --continue --model sonnet");
  await page.getByRole("button", { name: "Сохранить настройки", exact: true }).click();
  await page
    .getByLabel("Команда запуска терминала Claude", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    state.settings.claude_terminal_command,
    "claude --continue --model sonnet",
  );
  await page.getByRole("button", { name: /^Создать терминал в проекте / }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Терминал Claude", exact: true })
    .waitFor();
  await page.screenshot({
    path: fileURLToPath(new URL("terminal-choice.png", output)),
  });
  await page
    .getByRole("menuitem", { name: "Терминал Claude", exact: true })
    .click();
  const terminalRequests = () =>
    state.requests.filter(
      (x) => x.path === "/terminals" && x.method === "POST",
    );
  assert.equal(terminalRequests().at(-1).body.kind, "claude");
  assert.equal(
    terminalRequests().at(-1).body.workspace,
    state.settings.workspace,
  );
  const before = terminalRequests().length;
  await page.reload();
  await page.getByRole("button", { name: /^Создать терминал в проекте / }).waitFor();
  assert.equal(
    terminalRequests().length,
    before,
    "reconnect must not relaunch Claude",
  );
  await page.getByRole("button", { name: /^Создать терминал в проекте / }).click();
  await page.getByRole("menuitem", { name: "Обычный терминал", exact: true }).click();
  assert.equal(terminalRequests().at(-1).body.kind, "shell");
  await page.setViewportSize({ width: 820, height: 558 });
  await page
    .getByRole("button", { name: "Claude Desktop", exact: true })
    .click();
  await page.screenshot({
    path: fileURLToPath(new URL("desktop-small.png", output)),
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: sidebar, optional installation, failure/retry, Desktop login handoff via events and polling, background updates, lifecycle, terminal choice, settings and reconnect",
  );
} catch (error) {
  console.error(JSON.stringify({ actions, desktop, status: state.status, errors, body: await page.locator("body").innerText() }));
  throw error;
} finally {
  await browser.close();
}
