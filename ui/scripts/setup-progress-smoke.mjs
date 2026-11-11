import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const { browser, page, state, errors } = await createWorkbench();
try {
  let starts = 0;
  await page.route("**/api/start", (route) => {
    starts++;
    state.status.job = { id: "setup-" + starts, kind: "start", running: true, message: "Подготовка базовой среды",
      setup_progress: { phase: "image", label: "Загрузка базового образа Debian 13", received: 25 * 1048576, total: 100 * 1048576 } };
    return route.fulfill({ json: state.status.job });
  });
  await page.getByRole("button", { name: "Запустить среду Cage", exact: true }).click();
  const panel = page.getByRole("region", { name: "Ход установки среды" });
  const bar = panel.getByRole("progressbar");
  await panel.getByText("25 MiB / 100 MiB").waitFor();
  assert.equal(await bar.getAttribute("aria-valuenow"), "25");
  assert.equal(await panel.locator('[aria-current="step"]').textContent(), "Системный образ");
  await panel.getByRole("button", { name: "Подробности операции" }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  if (process.env.CAGE_SETUP_SCREENSHOT) await page.screenshot({ path: process.env.CAGE_SETUP_SCREENSHOT, animations: "disabled" });
  state.status.job.setup_progress = { phase: "tools", label: "Загрузка code-server", received: 8 * 1048576 };
  await panel.getByText("Получено 8 MiB").waitFor();
  assert.equal(await bar.getAttribute("aria-valuenow"), null);
  state.status.job.setup_progress = { phase: "services", label: "Настройка браузера и терминала" };
  await panel.getByRole("heading", { name: "Настройка браузера и терминала" }).waitFor();
  assert.equal(await bar.getAttribute("aria-valuenow"), null);
  assert.equal(await panel.locator(".setup-transfer-bytes").count(), 0);
  await panel.getByRole("button", { name: "Остановить установку" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Отмена" }).click();
  assert.equal(state.requests.filter(r => r.path === "/stop").length, 0);
  await page.setViewportSize({ width: 600, height: 600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  state.status.job = { ...state.status.job, running: false, error: "Попытки загрузки исчерпаны; незавершённые файлы сохранены" };
  await panel.getByRole("alert").waitFor();
  assert.equal(await bar.count(), 0);
  await panel.getByText("Можно продолжить установку вручную; сохранённые загрузки будут возобновлены.").waitFor();
  assert.equal(starts, 1);
  await panel.getByRole("button", { name: "Продолжить установку" }).click();
  await panel.getByText("25 MiB / 100 MiB").waitFor();
  assert.equal(starts, 2);
  state.status.job = { ...state.status.job, running: false, error: "Загрузка снова прервана; незавершённые файлы сохранены" };
  await panel.getByRole("alert").waitFor();
  await panel.getByRole("button", { name: "Продолжить установку" }).click();
  await panel.getByText("25 MiB / 100 MiB").waitFor();
  assert.equal(starts, 3);
  await panel.getByRole("button", { name: "Остановить установку" }).click();
  const stopped = page.waitForRequest("**/api/stop");
  await page.getByRole("dialog").getByRole("button", { name: "Остановить установку" }).click();
  await stopped;
  assert.deepEqual(errors, []);
  console.log("PASS: measured bytes and percent, unknown size, phase only, details, compact layout, cancel and retry.");
} finally { await browser.close(); }

{
  const {browser,page,state,errors} = await createWorkbench();
  try {
    state.status.job = {id:"mac-install",kind:"guest-install",running:true,message:"Установка выбранной гостевой системы…",setup_progress:{system:"macos",operation:"download",phase:"image",label:"Загружается macOS (системный образ)",received:8*1024**3,total:20*1024**3,bytes_per_second:26*1024**2}};
    const panel = page.getByRole("region",{name:"Ход установки среды"});
    const bar = panel.getByRole("progressbar");
    await panel.getByText("8 GiB / 20 GiB",{exact:true}).waitFor();
    await panel.getByText("· 26 MiB/s",{exact:true}).waitFor();
    assert.equal(await bar.getAttribute("aria-valuenow"),"40");
    if (process.env.CAGE_SETUP_NATIVE_SCREENSHOT) await page.screenshot({path:process.env.CAGE_SETUP_NATIVE_SCREENSHOT,animations:"disabled"});
    await page.reload();
    await panel.getByText("8 GiB / 20 GiB",{exact:true}).waitFor();
    assert.equal(await bar.getAttribute("aria-valuenow"),"40");
    state.status.job.setup_progress = {...state.status.job.setup_progress,operation:"verify",label:"Проверяется macOS (системный образ)",received:0};
    await panel.getByRole("heading",{name:"Проверяется macOS (системный образ)"}).waitFor();
    assert.equal(await bar.getAttribute("aria-valuenow"),"0");
    assert.equal(await panel.getByText(/MiB\/s/).count(),0);
    state.status.job.setup_progress = {system:"macos",phase:"packages",label:"Устанавливается система macOS"};
    await panel.getByRole("heading",{name:"Устанавливается система macOS"}).waitFor();
    assert.equal(await panel.locator('[aria-current="step"]').textContent(),"Установка системы");
    assert.equal(await bar.getAttribute("aria-valuenow"),null);
    await page.setViewportSize({width:375,height:812});
    await page.getByRole("button",{name:"Свернуть боковую панель",exact:true}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if (process.env.CAGE_SETUP_MOBILE_SCREENSHOT) await page.screenshot({path:process.env.CAGE_SETUP_MOBILE_SCREENSHOT,animations:"disabled"});
    state.status.job = {...state.status.job,running:false,error:"Установка прервана; исходные файлы и диск сохранены"};
    await panel.getByRole("alert").waitFor();
    let submitted;
    await page.route("**/api/start",route=>{
      submitted = route.request().postDataJSON();
      state.status.job = {...state.status.job,running:true,error:""};
      return route.fulfill({json:state.status.job});
    });
    const response = page.waitForResponse("**/api/start");
    await panel.getByRole("button",{name:"Продолжить установку"}).click();
    await response;
    assert.equal(submitted.guest_system,"macos");
    assert.deepEqual(errors,[]);
    console.log("PASS: native image bytes, percent, measured rate, refresh, separate verification, install stage, 375px layout and native retry.");
  } finally {await browser.close();}
}

{
  const { browser, page, state, errors } = await createWorkbench({
    initialization: { required: true, tracked: true, started: true },
    clientContext: { mode: "local", connection_id: "local", client_platform: "windows", server_platform: "windows" },
    beforeNavigate: async (page, state) => {
      state.status.job = { id: "windows-install", kind: "guest-install", running: false,
        setup_progress: { system: "windows-11", phase: "packages", operation: "oobe", label: "Завершите первичную настройку Windows в окне подключения виртуальной машины" } };
    },
  });
  try {
    const panel = page.getByRole("region", { name: "Ход установки среды" });
    await panel.getByText(/окне подключения виртуальной машины/).waitFor();
    assert.equal(await panel.getByRole("progressbar").count(), 0);
    assert.equal(await panel.getByRole("button", { name: "Остановить установку" }).count(), 0);
    await page.reload();
    const resume = panel.getByRole("button", { name: "Рабочий стол открыт, продолжить установку" });
    await resume.waitFor();
    let submitted;
    await page.route("**/api/start", route => {
      submitted = route.request().postDataJSON();
      state.status.job = { ...state.status.job, running: true,
        setup_progress: { system: "windows-11", phase: "packages", operation: "credentials", label: "Введите учётную запись администратора гостевой системы в окне установки" } };
      return route.fulfill({ json: state.status.job });
    });
    await resume.click();
    await panel.getByText(/и введите аккаунт администратора гостевой системы в окне установки PowerShell/).waitFor();
    assert.equal(submitted.guest_system, "windows-11");
    assert.equal(await resume.count(), 0);
    for (const [operation, phase, label] of [["media", "image", "Идёт загрузка и проверка компонентов разработки гостевой системы"], ["tools", "tools", "Идёт установка приложений и инструментов разработки гостевой системы"], ["services", "services", "Идёт завершение настройки гостевой системы"]]) {
      state.status.job.setup_progress = { system: "windows-11", phase, operation, label };
      await panel.getByRole("heading", { name: label }).waitFor();
      await panel.getByText(/Не закрывайте окно установки PowerShell/).waitFor();
    }
    await page.setViewportSize({ width: 600, height: 650 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (process.env.CAGE_SETUP_WINDOWS_SCREENSHOT) await page.screenshot({ path: process.env.CAGE_SETUP_WINDOWS_SCREENSHOT, animations: "disabled" });
    state.status.job.setup_progress = { system: "macos", phase: "tools", label: "Идёт установка приложений и инструментов разработки гостевой системы" };
    await panel.getByText(/Не закрывайте окно установки PowerShell/).waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    console.log("PASS: Windows OOBE resume, refresh, guest credentials, component phases and platform-specific guidance.");
  } finally { await browser.close(); }
}
