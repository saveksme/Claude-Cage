import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const evidence = process.env.CAGE_INITIALIZATION_EVIDENCE;
if (evidence) await fs.mkdir(evidence, { recursive: true });

{
  const ip = "203.0.113.10";
  let bindings = 0, stops = 0, starts = 0;
  let rejectBinding = true, disconnectOnStop = false, disconnected = false;
  const savedMessage = "Фиксированный выход сохранён. Перезапустите гостевую систему macOS, войдите и повторите проверку.";
  const f = await createWorkbench({
    initialization: { required: true, tracked: true, started: true },
    beforeNavigate: async (page, state) => {
      state.account.guest_system = "macos";
      Object.assign(state.status, { guest_system: "macos", ready: true, vm_running: true, safety: { gate: { mode: "closed" } } });
      await page.route("**/api/status", route => disconnected
        ? route.fulfill({ status: 503, contentType: "text/plain; charset=utf-8", body: "Тест: соединение прервано после остановки" })
        : route.fulfill({ json: { ...state.status, workspace: state.settings.workspace } }));
      await page.route("**/api/macos/exit-policy", route => {
        assert.equal(route.request().method(), "POST");
        assert.deepEqual(route.request().postDataJSON(), { ip });
        bindings++;
        if (rejectBinding) return route.fulfill({ status: 409, contentType: "text/plain; charset=utf-8", body: "Выборка выхода устарела или узел изменился; повторите проверку доступа к сети" });
        state.status.job = { id: `bind-${bindings}`, kind: "settings", running: true, message: "Сохранение фиксированного выхода" };
        return route.fulfill({ json: state.status.job });
      });
      await page.route("**/api/stop", route => {
        stops++;
        state.status.job = { id: `stop-${stops}`, kind: "stop", running: true, message: "Остановка гостевой системы" };
        if (disconnectOnStop) disconnected = true;
        return route.fulfill({ json: state.status.job });
      });
      await page.route("**/api/start", route => {
        assert.equal(state.status.vm_running, false, "start must wait for the accepted stop to finish");
        assert.equal(state.status.job.kind, "stop");
        assert.equal(state.status.job.running, false);
        assert.ok(!state.status.job.error);
        starts++;
        Object.assign(state.status, { ready: true, vm_running: true, job: { id: `start-${starts}`, kind: "start", running: true, message: "Запуск и проверка гостевой системы" } });
        // The backend accepted the start, but its response did not reach the UI.
        return route.fulfill({ status: 502, contentType: "text/plain; charset=utf-8", body: "Передача ответа на запрос запуска прервана" });
      });
    },
  });
  const { page, state } = f;
  page.setDefaultTimeout(5000);
  const bind = page.getByRole("button", { name: `Привязать обнаруженный фиксированный выход ${ip}`, exact: true });
  const restart = () => page.getByRole("button", { name: /^(Перезапустить|Запустить) гостевую систему и проверить снова$/ });
  const confirm = async (name) => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name, exact: true }).click();
  };
  try {
    await page.getByRole("heading", { name: "Среда запущена, ожидается проверка сети", exact: true }).waitFor();
    assert.equal(await bind.count(), 0, "no candidate must offer no binding");
    state.status.safety.macos_exit_candidate = { ip };
    await bind.waitFor(); // Red against the original initialization screen: the entry is missing.
    if (evidence) await page.screenshot({ path: `${evidence}/macos-exit-candidate.png`, fullPage: true });
    await bind.click();
    await page.getByRole("dialog").getByText(/После сохранения перезапустите гостевую систему и повторите проверку/).waitFor();
    await confirm("Отмена");
    assert.equal(bindings, 0, "cancel must not bind an exit");
    await bind.click(); await confirm("Привязать выход");
    await page.getByRole("alert").filter({ hasText: "Выборка выхода устарела" }).first().waitFor();
    assert.equal(bindings, 1);
    assert.equal(stops + starts, 0);

    rejectBinding = false;
    await bind.click(); await confirm("Привязать выход");
    await page.getByText("Сохранение фиксированного выхода", { exact: true }).waitFor();
    assert.ok(await bind.isDisabled());
    assert.equal(await restart().count(), 0, "an accepted settings job is not a saved exit");
    state.status.job = { ...state.status.job, running: false, error: "Фиксированный выход не сохранён: служба геолокации недоступна" };
    await page.getByRole("alert").filter({ hasText: "Фиксированный выход не сохранён" }).first().waitFor();
    assert.equal(stops + starts, 0, "save failure must not restart");

    await bind.evaluate(button => { button.click(); button.click(); });
    await confirm("Привязать выход");
    await page.getByText("Сохранение фиксированного выхода", { exact: true }).waitFor();
    await bind.evaluate(button => { button.click(); button.click(); });
    assert.equal(bindings, 3, "duplicate clicks must not submit another binding");
    state.status.job = { ...state.status.job, running: false, message: "Завершено" };
    delete state.status.safety.macos_exit_candidate;
    state.status.safety.error = savedMessage;
    await restart().waitFor();
    assert.equal(await page.getByRole("button", { name: "Войти в рабочую среду", exact: true }).count(), 0);
    await page.setViewportSize({ width: 600, height: 650 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (evidence) await page.screenshot({ path: `${evidence}/macos-exit-saved-compact.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 850 });
    await restart().click(); await confirm("Отмена");
    assert.equal(stops, 0, "cancel must preserve the running guest");
    await restart().click(); await confirm("Перезапустить и проверить");
    await page.getByText("Остановка гостевой системы", { exact: true }).waitFor();
    assert.equal(starts, 0, "a running stop job must not start the guest");
    state.status.job = { ...state.status.job, running: false, error: "Не удалось остановить гостевую систему" };
    await page.getByRole("alert").filter({ hasText: "Не удалось остановить гостевую систему" }).first().waitFor();
    assert.equal(starts, 0, "stop failure must not start the guest");

    disconnectOnStop = true;
    await restart().click(); await confirm("Перезапустить и проверить");
    await page.getByRole("alert").filter({ hasText: "Соединение прервано после остановки" }).first().waitFor();
    assert.equal(starts, 0, "lost status must not authorize a start");
    disconnected = false;
    disconnectOnStop = false;
    state.status.job = { id: "stop-2", kind: "stop", running: false, error: "Запрос остановки прерван; гостевая система всё ещё работает" };
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "Перезапустить гостевую систему и проверить снова" && !button.disabled));
    await restart().click(); await confirm("Перезапустить и проверить");
    await page.getByText("Остановка гостевой системы", { exact: true }).waitFor();
    assert.equal(starts, 0);
    Object.assign(state.status, { ready: false, vm_running: false, job: { id: "stop-3", kind: "stop", running: false } });
    await page.getByText("Запуск и проверка гостевой системы", { exact: true }).waitFor();
    assert.equal(starts, 1);
    assert.equal(stops, 3);
    await page.getByRole("alert").filter({ hasText: "Передача ответа прервана" }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Войти в рабочую среду", exact: true }).count(), 0);
    state.status.job = { ...state.status.job, running: false };
    state.status.safety = { gate: { mode: "open", until: new Date(Date.now() + 3600000).toISOString() } };
    await page.getByRole("button", { name: "Войти в рабочую среду", exact: true }).waitFor();
    assert.equal(await restart().count(), 0, "a lost start response must not hide a later verified open gate");
    await page.reload();
    await page.getByRole("button", { name: "Войти в рабочую среду", exact: true }).click();
    await page.getByRole("complementary", { name: "Проекты и терминалы" }).waitFor();
    assert.deepEqual(f.errors, []);
    console.log("PASS macOS exit: explicit binding, cancellation, save failures, stop-before-start, disconnect recovery, lost start response and network completion gate");
  } finally { await f.browser.close(); }
}

for (const [platform, system] of [["darwin", "macos"], ["windows", "windows-11"], ["linux", "ubuntu-22.04"]]) {
  let starts = 0, rejectComplete = true;
  let directory = "/preview/cage-state";
  const initialDirectory = platform === "windows" ? "/preview/Cage/CageData" : directory;
  const fixture = await createWorkbench({
    initialization: { required: true, tracked: true, started: false },
    clientContext: { mode: "local", connection_id: "local", client_platform: platform, server_platform: platform },
    beforeNavigate: async (page, state) => {
      // Audio is outside this initialization flow; avoid unrelated in-flight audio requests during reload.
      await page.addInitScript(() => localStorage.setItem("cage.audio", JSON.stringify({ muted: true })));
      state.status.local_vm_storage = true;
      await page.route("**/api/environment/storage", route => {
        if (route.request().method() === "POST") {
          assert.equal(route.request().postDataJSON().previous, directory);
          directory = route.request().postDataJSON().directory;
          state.status.job = { id: "storage-default", kind: "storage", running: false };
          return route.fulfill({ json: state.status.job });
        }
        return route.fulfill({ json: { directory, has_environment: false, suggested_directory: directory === "/preview/cage-state" ? initialDirectory : undefined } });
      });
      await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: { fresh: true, available: true, system, linux_systems: ["ubuntu-22.04"] } }));
      await page.route("**/api/environment/guest-systems/clone", route => route.fulfill({ json: { key: "matched-image", enough_space: true, minimum_free_gib: 51, free_gib: 120, download_bytes: 19769944180, plan: { host: { system, version: system === "windows-11" ? "25H2" : "26.5", build: "123", edition: "Professional", language: "zh-CN" }, version: "26.5", build: "456", bytes: 19769944180 } } }));
      await page.route("**/api/start", route => {
        starts++;
        const submitted = route.request().postDataJSON();
        assert.equal(submitted.guest_system, system);
        if (starts === 1) assert.equal(submitted.clone_key, "matched-image");
        state.status.job = { id: "install-" + starts, running: true, kind: "guest-install", setup_progress: { system, phase: "image", operation: "download", label: "Загружается системный образ", received: 25 * 1048576, total: 100 * 1048576, bytes_per_second: 1048576 }, log: "Загрузка образа начата" };
        return route.fulfill({ json: state.status.job });
      });
      await page.route("**/api/environment/initialization", route => {
        const action = route.request().method() === "POST" ? route.request().postDataJSON()?.action : "";
        if (action === "complete" && rejectComplete) return route.fulfill({ status: 400, contentType: "text/plain; charset=utf-8", body: "Сетевая проверка среды ещё не пройдена. Проверьте заново" });
        if (action === "install") state.initialization.started = true;
        if (action === "complete") state.initialization.required = false;
        return route.fulfill({ json: state.initialization });
      });
    },
  });
  const { page, state, errors, browser } = fixture;
  try {
    assert.equal(await page.getByRole("complementary", { name: "Проекты и терминалы" }).count(), 0);
    const picker = page.getByRole("combobox", { name: "Гостевая система" });
    const storage = page.getByRole("region", { name: "Каталог хранения среды" });
    await storage.getByLabel("Каталог хранения", { exact: true }).waitFor();
    assert.equal(await storage.getByLabel("Каталог хранения", { exact: true }).inputValue(), initialDirectory);
    await storage.getByText("Это каталог данных среды Cage. Обновление, переустановка или удаление приложения не затрагивают эти данные; не удаляйте их вручную.").waitFor();
    assert.equal(await storage.getByText("Текущий каталог среды", { exact: true }).count(), 0);
    assert.equal(await storage.getByText("Новое место хранения", { exact: true }).count(), 0);
    await page.locator(".initialization-content").evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter(animation => animation.animationName === "initialization-enter")
        .map(animation => animation.finished));
    });
    const before = await storage.boundingBox();
    await picker.click();
    const option = page.getByRole("option", { name: "Автоматически подобрать версию системы этого компьютера", exact: true });
    await option.waitFor();
    for (const name of [/^Debian/, /^Ubuntu/, /^macOS/, /^Windows/]) assert.equal(await page.getByRole("option", { name }).count(), 1);
    const expanded = await storage.boundingBox();
    assert.ok(Math.abs(expanded.y - before.y) < 1, "floating system choices must not move storage");
    const menu = await page.getByRole("listbox").boundingBox();
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= 1280 && menu.y + menu.height <= 850, "floating menu must stay inside the viewport");
    if (evidence) await page.screenshot({ path: `${evidence}/${platform}-systems-floating.png`, fullPage: true });
    await picker.press("Home"); await picker.press("Enter");
    await page.getByText("Cage определит версию системы этого компьютера и на следующем шаге покажет подходящий официальный образ, объём загрузки и требования к месту.").waitFor();
    await page.getByText(/Системный образ загружается через сеть хоста.*системному прокси или настройкам TUN/).waitFor();
    if (system === "windows-11") await page.getByRole("checkbox").check();
    if (evidence) await page.screenshot({ path: `${evidence}/${platform}-system.png`, fullPage: true });
    await page.getByRole("button", { name: "Далее: настройка прокси" }).click();
    await page.getByRole("heading", { name: "Подключите сетевой прокси" }).waitFor();
    await page.getByText("Официальный образ подбирается по версии системы этого компьютера и устанавливается в отдельную гостевую систему.").waitFor();
    await page.getByRole("button", { name: "Назад", exact: true }).click();
    await page.getByRole("combobox", { name: "Гостевая система" }).getByText("Автоматически подобрать версию системы этого компьютера").waitFor();
    await page.getByRole("button", { name: "Далее: настройка прокси" }).click();
    await page.getByRole("button", { name: "Начать установку", exact: true }).click();
    const progress = page.getByRole("region", { name: "Ход установки среды" });
    await progress.getByText("25 MiB / 100 MiB", { exact: true }).waitFor();
    assert.equal(await progress.getByRole("progressbar").getAttribute("aria-valuenow"), "25");
    assert.equal(await page.getByRole("complementary", { name: "Проекты и терминалы" }).count(), 0);
    await page.reload();
    await progress.getByText("25 MiB / 100 MiB", { exact: true }).waitFor();
    assert.equal(starts, 1, "refresh must not restart the accepted installation");
    state.status.job = { ...state.status.job, running: false, error: "Загрузка прервана; часть файлов сохранена" };
    await progress.getByRole("alert").waitFor();
    if (evidence) await page.screenshot({ path: `${evidence}/${platform}-failed.png`, fullPage: true });
    await progress.getByRole("button", { name: "Продолжить установку", exact: true }).click();
    await progress.getByRole("progressbar").waitFor();
    assert.equal(starts, 2);
    await page.setViewportSize({ width: 600, height: 650 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (evidence) await page.screenshot({ path: `${evidence}/${platform}-progress-compact.png`, fullPage: true });
    state.status.job = { id: "install-2", kind: "start", running: false, message: "Среда запущена, проверка доступа к сети не пройдена", error: "Проверка «Браузер»: канал проверки вернул HTTP 503. Внешняя сеть остаётся закрытой" };
    Object.assign(state.status, { ready: true, vm_running: true, safety: { gate: { mode: "closed" } } });
    await page.getByRole("heading", { name: "Среда запущена, ожидается проверка сети", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Продолжить установку", exact: true }).count(), 0);
    let networkChecks = 0;
    await page.route("**/api/safety/check", route => {
      networkChecks++;
      state.status.job = { id: "retry-network", kind: "safety", running: true, message: "Проверка условий сети" };
      return route.fulfill({ json: state.status.job });
    });
    await page.getByRole("button", { name: "Выполнить проверку сети и изоляции", exact: true }).click();
    await page.getByText("Проверка условий сети", { exact: true }).waitFor();
    assert.equal(networkChecks, 1);
    assert.equal(starts, 2, "network recovery must not restart installation");
    state.status.job = { id: "install-2", kind: "start", running: false };
    Object.assign(state.status, { ready: true, vm_running: true, safety: { gate: { mode: "open", until: new Date(Date.now() + 3600000).toISOString() } } });
    await page.getByRole("button", { name: "Войти в рабочую среду", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Проверка сети" }).waitFor();
    assert.equal(await page.getByRole("complementary", { name: "Проекты и терминалы" }).count(), 0, "server completion rejection must keep initialization visible");
    rejectComplete = false;
    await page.getByRole("button", { name: "Войти в рабочую среду", exact: true }).click();
    await page.getByRole("complementary", { name: "Проекты и терминалы" }).waitFor();
    await page.evaluate(() => window.cageNativeAction("settings"));
    await page.getByRole("region", { name: "Настройки", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("complementary", { name: "Проекты и терминалы" }).waitFor();
    await page.evaluate(() => window.cageNativeAction("quit"));
    const quitDialog = page.getByRole("dialog", { name: "Выйти из Cage", exact: true });
    await quitDialog.getByRole("button", { name: "Отмена", exact: true }).click();
    assert.equal(await page.getByRole("heading", { name: "Подготовьте отдельную среду для Cage" }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${platform}: independent initialization, inline keyboard selection, back navigation, progress, refresh, retry, completion gate and reopen`);
  } finally { await browser.close(); }
}

{
  let location = { directory: "/preview/default-state", has_environment: false }, writes = 0, fail = true;
  const f = await createWorkbench({ initialization: { required: true, tracked: true }, beforeNavigate: async (page, state) => {
    state.status.local_vm_storage = true;
    await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: { fresh: true, available: true, system: "macos", linux_systems: ["ubuntu-22.04"] } }));
    await page.route("**/api/environment/storage", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: location });
      const body = route.request().postDataJSON();
      writes++;
      assert.equal(body.previous, "/preview/default-state");
      assert.equal(body.migrate, false);
      if (fail) return route.fulfill({ status: 400, contentType: "text/plain; charset=utf-8", body: "Выберите отдельную пустую папку" });
      location = { ...location, directory: body.directory };
      state.status.job = { id: "save-storage", kind: "storage", running: false };
      return route.fulfill({ json: state.status.job });
    });
  } });
  try {
    const input = f.page.getByLabel("Каталог хранения", { exact: true });
    assert.equal(await input.inputValue(), "/preview/default-state");
    await input.fill("/preview/chosen-state");
    assert.equal(writes, 0, "editing must not save before Next");
    await f.page.getByRole("button", { name: "Далее: настройка прокси" }).click();
    await f.page.getByRole("alert").filter({ hasText: "Выберите отдельную пустую папку" }).waitFor();
    assert.equal(await input.inputValue(), "/preview/chosen-state");
    assert.equal(await f.page.getByRole("heading", { name: "Подключите сетевой прокси" }).count(), 0);
    fail = false;
    await f.page.getByRole("button", { name: "Далее: настройка прокси" }).click();
    await f.page.getByRole("heading", { name: "Подключите сетевой прокси" }).waitFor();
    assert.equal(location.directory, "/preview/chosen-state");
    assert.equal(writes, 2);
    await f.page.getByRole("button", { name: "Назад", exact: true }).click();
    assert.equal(await input.inputValue(), "/preview/chosen-state");
    assert.deepEqual(f.errors, []);
    console.log("PASS storage: one default-filled directory, save on Next, rejected path preserved, retry and back navigation");
  } finally { await f.browser.close(); }
}

{
  let imported = false, applied = false;
  const f = await createWorkbench({ initialization: { required: true, tracked: true }, beforeNavigate: async (page, state) => {
    state.status.local_vm_storage = true;
    await page.route("**/api/environment/storage", route => route.fulfill({ json: { directory: "/preview/cage-state", has_environment: false } }));
    await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: { fresh: true, available: true, system: "macos" } }));
    await page.route("**/api/proxy", route => route.fulfill({ json: { active: applied, selected: applied ? "node" : "", sources: imported ? [{ id: "source", name: "Собственный узел", nodes: [{ id: "node", name: "Локальный тестовый прокси", type: "socks5" }] }] : [], port: 17896, core_available: true } }));
    for (const action of ["import", "route"]) await page.route(`**/api/proxy/${action}`, route => {
      if (action === "import") imported = true;
      else applied = true;
      state.status.job = { id: action, kind: "proxy", running: false, message: "Завершено" };
      return route.fulfill({ json: state.status.job });
    });
  } });
  try {
    const { page } = f;
    await page.getByRole("button", { name: "Далее: настройка прокси" }).click();
    const start = page.getByRole("button", { name: "Начать установку", exact: true });
    assert.ok(await start.isDisabled());
    await page.getByRole("button", { name: "Добавить источник", exact: true }).click();
    await page.getByRole("button", { name: "Ручной узел", exact: true }).click();
    await page.getByLabel("Название источника", { exact: true }).fill("Собственный узел");
    await page.getByLabel("Название узла", { exact: true }).fill("Локальный тестовый прокси");
    await page.getByLabel("Журналы сервера", { exact: true }).fill("127.0.0.1");
    await page.getByRole("button", { name: "Импортировать и проверить", exact: true }).click();
    await page.getByRole("tab", { name: "Узлы", exact: true }).click();
    await page.getByRole("button", { name: "Выбрать узел Локальный тестовый прокси", exact: true }).click();
    await page.getByRole("button", { name: "Применить прокси", exact: true }).click();
    await page.getByText("Завершено", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Начать установку' && !button.disabled));
    assert.deepEqual(f.errors, []);
    console.log("PASS first proxy: manual import, node selection and explicit apply unlock installation inside initialization");
  } finally { await f.browser.close(); }
}
