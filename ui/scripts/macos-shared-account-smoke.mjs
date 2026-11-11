import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const evidence = process.env.CAGE_SHARED_ACCOUNT_EVIDENCE;
if (evidence) await fs.mkdir(evidence, { recursive:true });
for (const platform of ["darwin", "windows", "linux"]) {
  let creates = 0, installs = 0;
  const fixture = await createWorkbench({
    waitForReady:false,
    initialization:{required:true,tracked:true,started:false},
    clientContext:{mode:"local",desktop_gateway:true,connection_id:"local",client_platform:platform,server_platform:platform,connection:{state:"connected"}},
    async beforeNavigate(page,state) {
      Object.assign(state.account,{exists:false,unlocked:false,username:"",macos_account_host:platform === "darwin"});
      await page.route("**/api/environment/storage",route => route.fulfill({json:{directory:"/preview/shared-account-state",has_environment:false}}));
      await page.route("**/api/environment/guest-systems",route => route.fulfill({json:{fresh:true,available:true,system:platform === "darwin" ? "macos" : platform === "windows" ? "windows-11" : "ubuntu-22.04",linux_systems:["debian","ubuntu-22.04"]}}));
      await page.route("**/api/account/create",route => {
        const input = route.request().postDataJSON(); creates++;
        assert.equal(input.username,"shared_qa");
        assert.equal(input.password,"Shared test-'\"\\$! 2026");
        assert.equal(input.confirm_password,input.password);
        Object.assign(state.account,{exists:true,unlocked:true,username:input.username,macos_credentials_ready:platform === "darwin"});
        return route.fulfill({json:state.account});
      });
      await page.route("**/api/client/trusted-login",route => {
        assert.ok(["enable","disable"].includes(route.request().postDataJSON().action),"registration was bypassed by a trusted creation");
        return route.fulfill({json:{ok:true}});
      });
      await page.route("**/api/start",route => { installs++; return route.fulfill({json:{}}); });
    },
  });
  const {page,state,browser,errors} = fixture;
  try {
    page.setDefaultTimeout(10000);
    await page.getByRole("heading",{name:"Регистрация аккаунта Cage",exact:true}).waitFor();
    assert.equal(await page.getByRole("combobox",{name:"Гостевая система"}).count(),0);
    assert.equal(await page.getByRole("button",{name:"Доверять этому компьютеру",exact:true}).count(),0);
    await page.getByLabel("Имя пользователя",{exact:true}).fill("shared_qa");
    await page.getByLabel("Задать пароль",{exact:true}).fill("Shared test-'\"\\$! 2026");
    await page.getByLabel("Подтвердите пароль",{exact:true}).fill("different-password");
    await page.getByRole("button",{name:"Создать локальный аккаунт",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"Пароли не совпадают"}).waitFor();
    assert.equal(creates,0); assert.equal(installs,0);
    await page.getByLabel("Подтвердите пароль",{exact:true}).fill("Shared test-'\"\\$! 2026");
    if (evidence) await page.screenshot({path:`${evidence}/${platform}-register.png`});
    await page.getByRole("button",{name:"Создать локальный аккаунт",exact:true}).click();
    await page.getByRole("heading",{name:"Подготовьте отдельную среду для Cage",exact:true}).waitFor();
    assert.equal(creates,1); assert.equal(installs,0);
    await page.reload();
    await page.getByRole("heading",{name:"Подготовьте отдельную среду для Cage",exact:true}).waitFor();
    assert.equal(state.account.username,"shared_qa"); assert.equal(creates,1);
    assert.deepEqual(errors,[]);
    console.log(`${platform}: registration precedes initialization; confirmation and reload passed`);
  } catch (error) {
    console.error(platform,errors,state.requests.filter(item => item.path === "/diagnostics/events"),await page.locator("body").innerText()); throw error;
  } finally { await browser.close(); }
}

const legacy = await createWorkbench({
  waitForReady:false,
  async beforeNavigate(page,state) {
    Object.assign(state.account,{exists:true,unlocked:true,trusted_local:true,username:"Пользователь этого компьютера",guest_system:"macos",initial_mac_setup:true,macos_guest_user:"cage",macos_account_host:true});
    await page.route("**/api/account/prepare-macos",route => {
      const input = route.request().postDataJSON();
      assert.equal(input.username,"cage"); assert.equal(input.password,input.confirm_password);
      Object.assign(state.account,{username:"cage",trusted_local:false,macos_credentials_ready:true,initial_mac_setup:false});
      return route.fulfill({json:state.account});
    });
  },
});
try {
  const {page,errors} = legacy; page.setDefaultTimeout(10000);
  await page.getByRole("heading",{name:"Настройте общие учётные данные Cage и macOS",exact:true}).waitFor();
  assert.equal(await page.getByLabel("Имя пользователя",{exact:true}).inputValue(),"cage");
  assert.equal(await page.getByLabel("Имя пользователя",{exact:true}).getAttribute("readonly"),"");
  await page.getByLabel("Задать пароль",{exact:true}).fill("Shared-test-2026");
  await page.getByLabel("Подтвердите пароль",{exact:true}).fill("Shared-test-2026");
  await page.getByRole("button",{name:"Сохранить учётные данные и продолжить",exact:true}).click();
  await page.getByRole("button",{name:/Меню аккаунта,/}).waitFor();
  assert.deepEqual(errors,[]);
  console.log("legacy: shared credentials preserve the existing guest username and resume the workspace");
} finally { await legacy.browser.close(); }
