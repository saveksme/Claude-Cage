import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";
for (const failure of ["http", "native"]) {
  const user = "cage";
  const permissions = { screen:false, input:false, projects:false, managed_credential:true };
  const calls = []; let finishFailed = false;
  const {page, browser, errors} = await createWorkbench({
    async beforeNavigate(page, state) {
      Object.assign(state.account, {initial_mac_setup:true, guest_system:"macos", macos_guest_user:user});
      Object.assign(state.status, {ready:true, vm_running:true});
      const frame = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 160; canvas.height = 100;
        return canvas.toDataURL("image/png").split(",")[1];
      });
      await page.route("**/api/macos/first-setup", async r => {
        const q = r.request().postDataJSON(); calls.push(q.action);
        if (q.action === "permissions") return r.fulfill({json:permissions});
        if (q.action === "open") return r.fulfill({json:{session:"setup-fixture"}});
        if (q.action === "frame") return r.fulfill({json:{image:frame}});
        if (q.action === "scroll") {
          assert.equal(q.session,"setup-fixture");
          assert.ok(Number.isInteger(q.x) && q.x >= 0 && q.x < 1024);
          assert.ok(Number.isInteger(q.y) && q.y >= 0 && q.y < 640);
          assert.ok(q.delta_y > 0 && q.delta_y <= 512);
        }
        if (q.action === "fill-password") {
          assert.equal(q.password,undefined,"browser sent a credential");
          assert.equal(q.session,"setup-fixture");
        }
        if (q.action === "finish") {
          assert.ok(permissions.screen && permissions.input && permissions.projects);
          if (!finishFailed) {
            finishFailed=true;
            return failure === "http"
              ? r.fulfill({status:409,body:"Временный аккаунт настройки не закрыт; повторите завершение настройки"})
              : r.fulfill({json:{error:"Не удалось сохранить первоначальную настройку; повторите попытку"}});
          }
          state.account.initial_mac_setup = false; return r.fulfill({json:{closed:true}});
        }
        return r.fulfill({json:{}});
      });
    },
  });
  async function waitCall(action) {
    for(let i=0; !calls.includes(action) && i<200; i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(calls.includes(action),`missing ${action}`);
  }
  try {
    await page.getByRole("dialog",{name:"Первичная настройка виртуального Mac"}).waitFor();
    await waitCall("screen");
    await page.getByRole("dialog",{name:"Первичная настройка виртуального Mac"}).getByText(/Включите запись окна для Cage Guest Window/).waitFor();
    const image = page.getByRole("dialog",{name:"Первичная настройка виртуального Mac"}).getByRole("img");
    await image.waitFor();
    if (process.env.CAGE_INITIALIZATION_EVIDENCE) await page.screenshot({ path: `${process.env.CAGE_INITIALIZATION_EVIDENCE}/setup-window-${failure}.png`, fullPage: true });
    const box = await image.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.wheel(0,400);
    await waitCall("scroll");
    const tools=page.getByRole("toolbar",{name:"Инструменты изображения"});
    await tools.getByRole("button",{name:"Заполнить пароль авторизации"}).click();
    await waitCall("fill-password");
    permissions.screen=true;
    await waitCall("input");
    await page.getByRole("dialog",{name:"Первичная настройка виртуального Mac"}).getByText(/Включите универсальный доступ для Cage Guest Window/).waitFor();
    permissions.input=true;
    await waitCall("projects");
    await page.getByRole("dialog",{name:"Первичная настройка виртуального Mac"}).getByText(/оба переключателя macFUSE и macFUSE \(local\)/).waitFor();
    assert.ok(!calls.includes("finish"),"finished before filesystem permission");
    permissions.projects=true;
    await page.getByRole("button",{name:"Вернуться к руководству"}).click();
    const retry=page.getByRole("button",{name:"Повторить завершение настройки"});
    await retry.waitFor();
    await page.getByText("Пароль администратора и помощь, если страница настроек не найдена",{exact:true}).click();
    await page.getByRole("button",{name:"Открыть заново: Расширения файловой системы",exact:true}).click();
    await page.getByRole("alert").waitFor({state:"hidden"});
    assert.ok(await retry.isVisible(), "checking permissions hid the completion retry");
    await retry.click();
    await page.getByRole("heading",{name:"Завершите настройку разрешений виртуального Mac"}).waitFor({state:"hidden"});
    await page.getByRole("complementary", { name: "Проекты и терминалы" }).waitFor();
    await page.evaluate(() => window.cageNativeAction("settings"));
    await page.getByRole("region", { name: "Настройки", exact: true }).waitFor();
    await page.evaluate(() => window.cageNativeAction("quit"));
    await page.getByRole("dialog", { name: "Выйти из Cage", exact: true }).getByRole("button", { name: "Отмена", exact: true }).click();
    assert.equal(calls.filter(c=>c==="finish").length,2);
    assert.equal(calls.filter(c=>c==="verify-projects").length,0);
    assert.deepEqual(errors, []);
    console.log(user,failure,"automatic setup view, permission progression, credential fill, completion and failure recovery passed");
  } finally { await browser.close(); }
}
