import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";
const evidence = process.env.CAGE_INITIALIZATION_EVIDENCE;
if (evidence) await fs.mkdir(evidence, { recursive: true });

for (const mode of ["project-approval", "legacy", "guest-login", "filesystem-permission", "network", "restart"]) {
  let connected = false, checks = 0, starts = 0, stopped = false, stopFinished = false;
  const workspace = "/preview/shared-workspace";
  const fixture = await createWorkbench({ initialization: { required: true, tracked: true, started: true, prepared: true }, beforeNavigate: async (page, state) => {
    Object.assign(state.account, { guest_system: "macos" });
    state.settings.workspace = workspace;
    Object.assign(state.status, { guest_system: "macos", ready: true, vm_running: true, workspace, environment_directory: "/preview/other-directory", safety: { gate: { mode: "closed" }, error: "Доступ к рабочей области ещё не разрешён", report: { checks: [{ id: "filesystem_boundary", title: "Общие файлы и приватный каталог хоста", state: "unknown", evidence: "Гостевая система ещё не авторизовала доступ к папкам; проверка не выполнена", remedy: "Разрешите доступ к рабочей области и продолжите" }] } }, network_error: "Встроенный прокси не готов; внешняя сеть остаётся закрытой", job: { id: "failed-check", kind: "safety", running: false, message: "ошибка проверки условий доступа к сети", error: "Разрешите этот проект в окне авторизации гостевой системы, которое показывает Cage, затем проверьте авторизацию.", ...(mode === "legacy" ? {} : { recovery: mode === "restart" ? "environment-restart" : mode, workspace }) }, project_errors: [] });
    if (mode === "project-approval") state.status.project_errors = [{ path: workspace, recovery: "project-approval", message: "Разрешите доступ к рабочей области" }];
    await page.route("**/api/projects/open", route => {
      assert.equal(route.request().postDataJSON().workspace, workspace);
      assert.equal(route.request().postDataJSON().add, false);
      return route.fulfill({ json: connected ? { workspace } : { workspace, approval: "scoped-grant" } });
    });
    await page.route("**/api/macos/project-approval", route => route.fulfill({ json: { error: "waiting" } }));
    await page.route("**/api/safety/check", route => {
      checks++;
      state.status.job = { id: "checking", kind: "safety", running: false, message: "Завершено" };
      state.status.safety = { gate: { mode: "open", until: new Date(Date.now() + 600000).toISOString() } };
      state.status.project_errors = [];
      return route.fulfill({ json: state.status.job });
    });
    await page.route("**/api/stop", route => {
      stopped = true; state.status.job = { id: "stop-once", kind: "stop", running: true, message: "Останавливается" };
      setTimeout(() => { stopFinished = true; state.status.job.running = false; state.status.vm_running = false; }, 300);
      return route.fulfill({ json: state.status.job });
    });
    await page.route("**/api/start", route => {
      assert.ok(stopped && stopFinished, "start ran before stop completed"); starts++; state.status.vm_running = true;
      state.status.job = { id: "restarted", kind: "start", running: false, message: "Завершено" };
      return route.fulfill({ json: state.status.job });
    });
  }});
  const { page, state, browser, errors } = fixture;
  try {
    await page.getByRole("heading", { name: "Среда запущена, ожидается проверка сети", exact: true }).waitFor();
    await page.getByRole("button", { name: "Посмотреть подробности операции", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Подробности инициализации" });
    await details.getByText("Разрешите этот проект в окне авторизации гостевой системы, которое показывает Cage, затем проверьте авторизацию.", { exact: true }).waitFor();
    await details.getByText("Гостевая система ещё не авторизовала доступ к папкам; проверка не выполнена", { exact: true }).waitFor();
    await details.getByRole("button", { name: "Закрыть панель" }).click();
    if (mode === "guest-login") await page.getByRole("button", { name: "Войти в аккаунт гостевой системы", exact: true }).waitFor();
    if (mode === "filesystem-permission") await page.getByRole("button", { name: "Открыть настройки авторизации гостевой системы", exact: true }).waitFor();
    if (["project-approval", "legacy"].includes(mode)) {
      const action = mode === "project-approval" ? "Открыть авторизацию рабочей области" : "Подключить рабочую область и продолжить проверку";
      if (evidence) await page.screenshot({ path: `${evidence}/${mode}.png`, fullPage: true });
      await page.reload();
      await page.getByRole("button", { name: action, exact: true }).click();
      const approval = page.getByRole("dialog", { name: "Разрешить гостевой системе доступ к выбранному проекту" });
      await approval.getByRole("button", { name: "Отмена", exact: true }).click();
      assert.equal(checks, 0, "cancel must not start network verification");
      await page.getByRole("button", { name: action, exact: true }).click();
      await approval.getByRole("button", { name: "Проверить авторизацию", exact: true }).waitFor();
      connected = true;
      await approval.getByRole("button", { name: "Проверить авторизацию", exact: true }).click();
      await page.getByRole("button", { name: "Войти в рабочую среду", exact: true }).waitFor();
      assert.equal(checks, 1);
    } else if (mode === "restart") {
      await page.getByRole("button", { name: "Сохранить, перезапустить и проверить", exact: true }).click();
      await page.getByRole("dialog", { name: "Перезапустить виртуальный Mac и проверить?" }).getByRole("button", { name: "Перезапустить и проверить", exact: true }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('[role="dialog"]')].length);
      await page.getByRole("button", { name: "Посмотреть подробности операции" }).waitFor();
      await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === 'Остановить установку'));
      assert.equal(starts, 1);
    } else {
      await page.getByRole("button", { name: "Выполнить проверку сети и изоляции", exact: true }).click();
      await page.getByRole("button", { name: "Войти в рабочую среду", exact: true }).waitFor();
    }
    await page.setViewportSize({ width: 390, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(`PASS macOS initialization: ${mode}, precise details and recovery without reinstalling`);
  } finally { await browser.close(); }
}
