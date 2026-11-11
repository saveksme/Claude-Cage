import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

for (const system of ["macos", "windows-11", "debian"]) {
  const calls = [];
  const native = system !== "debian";
  const fixture = await createWorkbench({ beforeNavigate: async (page, state) => {
    state.account.guest_system = state.status.guest_system = system;
    state.status.vm_running = state.status.ready = true;
    await page.route("**/api/environment/versions", route => route.fulfill({ json: {
      vm_running: true, tools_update_allowed: true,
      components: { status: "update_required", update_required: true },
      controller: { version: "fixture-controller" },
      tools: { claude: { current: "2.1.300", required: "2.1.311" }, node: { current: "v24.22.2", required: "24.22.2" } },
      maintenance: native ? { native: true, guest_system: system, requires_closed_terminals: true } : undefined,
    } }));
    for (const operation of ["update", "tools"]) {
      await page.route(`**/api/environment/${operation}`, route => {
        calls.push(operation);
        return route.fulfill({ status: 409, contentType: "text/plain; charset=utf-8", body: "Сначала сохраните данные и завершите работающие терминалы и сеансы Claude Code. Обновление перезапустит браузер, редактор и подключение к общим файлам; история чатов, файлы проектов и данные входа сохранятся." });
      });
    }
  } });
  const { page, browser, errors } = fixture;
  try {
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.getByRole("navigation", { name: "Разделы настроек" }).getByRole("button", { name: "Среда и восстановление", exact: true }).click();
    const panel = page.getByRole("region", { name: "Версии среды", exact: true });
    await panel.getByText("2.1.300", { exact: true }).waitFor();
    await panel.getByText("2.1.311", { exact: true }).waitFor();
    for (const [buttonLabel, dialogLabel, confirmLabel] of [["Обновить компоненты среды", "Обновить компоненты среды?", "Обновить компоненты"], ["Обновить инструменты среды", "Обновить инструменты среды?", "Обновить инструменты"]]) {
      await panel.getByRole("button", { name: buttonLabel, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: dialogLabel, exact: true });
      const text = await dialog.innerText();
      if (native) {
        assert.ok(text.includes("завершите работающие терминалы и сеансы Claude Code"));
        assert.ok(text.includes("история чатов, файлы проектов и данные входа сохранятся"));
        assert.equal(text.includes("проверьте учётную запись администратора, привязанную к гостевой системе"), system === "windows-11");
      } else {
        assert.ok(text.includes("терминалы рабочей среды, файлы проектов и состояние входа сохранятся"));
      }
      await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
      await panel.getByRole("alert").filter({ hasText: "завершите работающие терминалы" }).waitFor();
    }
    assert.deepEqual(calls, ["update", "tools"]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ system, passed: true, calls }));
  } finally {
    await browser.close();
  }
}
