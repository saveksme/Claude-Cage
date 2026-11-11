// Both real UIs share one isolated host fixture. No request reaches personal data.
import assert from "node:assert/strict";
import { join } from "node:path";
import { smokeCaptureDirectory } from "./smoke-captures.mjs";
import { createWorkbench } from "./workbench-fixture.mjs";

const base = process.env.CAGE_UI_URL || "http://127.0.0.1:5178";
const engine = process.env.CAGE_TEST_BROWSER || "chromium";
const output = await smokeCaptureDirectory("session-actions-" + engine);
const desktop = await createWorkbench({url:base});
const {page, state, browser, errors} = desktop;
const workspace = state.settings.workspace;
const id = "12345678-1234-4321-aaaa-123456789abc";
const sessions = [
  {id, workspace, title:"Ожидающий сеанс", revision:1, generation:id, updated_at:"2026-11-07T08:00:00Z", pinned:false},
  {id:"12345678-1234-4321-aaaa-123456789abd", workspace, title:"Другой сеанс", revision:1, generation:id, updated_at:"2026-11-07T09:00:00Z", pinned:false},
];
let failSave = false;
const update = (target, body) => {
  if (body.title) target.title = target.custom_title = body.title;
  if (body.pinned !== undefined) target.pinned = body.pinned;
  target.metadata_set = true; target.revision++;
  state.terminals = state.terminals.map(t => t.cli_session_id === target.id ? {...t, title:target.title, custom_title:target.custom_title, pinned:target.pinned, metadata_set:true} : t);
  return {...target, turns:[]};
};
const remove = target => {
  sessions.splice(sessions.indexOf(target),1);
  state.terminals = state.terminals.filter(t => t.cli_session_id !== target.id);
};
try {
  state.status.ready = state.status.vm_running = true;
  await page.evaluate(({workspace,title}) => localStorage.setItem("cage-tab-layout",JSON.stringify({[workspace]:{"terminal:fixture-shared":{title,pinned:false}}})),{workspace,title:sessions[0].title});
  state.terminals = [{id:"fixture-shared", kind:"claude", workspace, title:sessions[0].title, cli_session_id:id, metadata_set:false, pinned:false}];
  await page.route("**/api/terminals/*/metadata", async route => route.fulfill({json:update(sessions[0],route.request().postDataJSON())}));
  await page.route("**/api/terminals/*", async route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    remove(sessions[0]); await route.fulfill({json:{ok:true}});
  });
  await page.route("**/api/cli/sessions/*/archive", async route => {
    const target = sessions.find(s => route.request().url().includes(s.id));
    remove(target); await route.fulfill({json:{ok:true}});
  });
  await page.getByRole("tab",{name:/Ожидающий сеанс/}).first().hover();
  await page.getByRole("group",{name:"Действия для Ожидающий сеанс"}).waitFor();
  assert.equal(sessions[0].metadata_set,true,"desktop local label was not imported into host metadata");
  const phoneContext = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:"CageMobile/1"});
  const phone = await phoneContext.newPage();
  const phoneErrors = [];
  phone.on("pageerror",error => phoneErrors.push(error.message));
  await phone.route("**/api/**",async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/projects")) return route.fulfill({json:{host:"Изолированный тестовый хост",ready:true,shared_sessions:true,projects:[{path:workspace,name:"Тестовый проект"}]}});
    if (path.endsWith("/sessions")) return route.fulfill({json:{sessions,notice:""}});
    const target = sessions.find(s => path.includes(s.id));
    if (!target) return route.fulfill({status:404});
    if (path.endsWith("/account")) return route.fulfill({ json: { session: target, supported: false, candidates: [] } });
    if (path.endsWith("/metadata")) {
      if (failSave) return route.fulfill({status:500,contentType:"text/plain",body:"Тест: диск временно недоступен для записи"});
      return route.fulfill({json:update(target,route.request().postDataJSON())});
    }
    if (path.endsWith("/archive")) { remove(target); return route.fulfill({json:{ok:true}}); }
    return route.fulfill({json:{...target,turns:[]}});
  });
  await phone.goto(base+"/mobile.html");
  const drawer = phone.getByRole("dialog",{name:"Боковая панель рабочей области"});
  await drawer.getByRole("button",{name:"Ожидающий сеанс",exact:true}).waitFor();
  await phone.waitForFunction(() => document.querySelector(".workspace-drawer")?.dataset.visible === "true" && document.querySelector(".workspace-drawer").getBoundingClientRect().left >= 0);
  const row = phone.locator(".swipe-session").filter({has:phone.getByRole("button",{name:"Ожидающий сеанс",exact:true})});
  const box = await row.boundingBox();
  // A vertical drag must keep the toolbar closed.
  await phone.mouse.move(box.x+30,box.y+20); await phone.mouse.down();
  await phone.mouse.move(box.x+31,box.y+65,{steps:8}); await phone.mouse.up();
  assert.equal(await row.getByRole("group").count(),0);
  // Drag left on the actual row, then ensure it did not navigate into chat.
  if (engine === "chromium") {
    const touch = await phoneContext.newCDPSession(phone);
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:box.x+box.width-24,y:box.y+20}]});
    for(let dx=24;dx<=154;dx+=13) await touch.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:box.x+box.width-dx,y:box.y+20}]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    await touch.detach();
  } else {
    await phone.mouse.move(box.x+box.width-40,box.y+20); await phone.mouse.down();
    await phone.mouse.move(box.x+box.width-170,box.y+20,{steps:12}); await phone.mouse.up();
  }
  await row.getByRole("button",{name:"Закрепить",exact:true}).waitFor();
  await row.locator(".session-slide").evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  assert.equal(await phone.getByRole("textbox",{name:"Сообщение"}).count(),0,"swipe opened chat");
  await phone.screenshot({path:join(output,engine+"-swipe.png")});
  await row.getByRole("button",{name:"Закрепить",exact:true}).click();
  await row.getByRole("button",{name:"Открепить",exact:true}).waitFor();
  assert.match(await phone.locator(".swipe-session").first().innerText(),/Ожидающий сеанс/);
  await page.getByRole("group",{name:"Действия для Ожидающий сеанс"}).getByRole("button",{name:"Открепить",exact:true}).waitFor();
  await row.getByRole("button",{name:"Переименовать",exact:true}).click();
  let dialog = phone.getByRole("dialog",{name:"Переименовать сеанс"});
  await dialog.getByRole("textbox",{name:"Название сеанса"}).fill("Переименование с телефона");
  failSave = true;
  await dialog.getByRole("button",{name:"Сохранить имя"}).click();
  await dialog.getByRole("alert").filter({hasText:"диск временно недоступен для записи"}).waitFor();
  assert.equal(sessions[0].title,"Ожидающий сеанс");
  failSave = false;
  await dialog.getByRole("button",{name:"Сохранить имя"}).click();
  await dialog.waitFor({state:"hidden"});
  const desktopActions = page.getByRole("group",{name:"Действия для Переименование с телефона"});
  await desktopActions.waitFor();
  await desktopActions.getByRole("button",{name:"Переименовать",exact:true}).click();
  await page.getByRole("textbox",{name:"Имя вкладки"}).fill("Переименование с компьютера");
  await page.getByRole("button",{name:"Сохранить имя",exact:true}).click();
  await phone.getByRole("button",{name:"Переименование с компьютера",exact:true}).waitFor();
  await phone.reload();
  await drawer.getByRole("button",{name:"Переименование с компьютера",exact:true}).waitFor();
  const currentRow = phone.locator(".swipe-session").filter({has:phone.getByRole("button",{name:"Переименование с компьютера",exact:true})});
  await currentRow.getByRole("button",{name:"Переименование с компьютера",exact:true}).focus();
  await phone.keyboard.press("ArrowLeft");
  await currentRow.getByRole("button",{name:"Открепить",exact:true}).waitFor();
  await phone.keyboard.press("Escape");
  assert.equal(await currentRow.getByRole("group").count(),0);
  await currentRow.getByRole("button",{name:/другие действия/}).click();
  await currentRow.getByRole("button",{name:"Архивировать",exact:true}).click();
  dialog=phone.getByRole("dialog",{name:"Заархивировать сеанс"});
  await dialog.getByRole("button",{name:"Отмена",exact:true}).click();
  assert.equal(sessions.length,2);
  await currentRow.getByRole("button",{name:"Архивировать",exact:true}).click();
  await dialog.getByRole("button",{name:"Заархивировать сеанс",exact:true}).click();
  await currentRow.waitFor({state:"hidden"});
  await page.getByRole("group",{name:"Действия для Переименование с компьютера"}).waitFor({state:"hidden"});
  await phone.reload();
  await drawer.getByRole("button",{name:"Другой сеанс",exact:true}).waitFor();
  assert.equal(await drawer.getByRole("button",{name:"Переименование с компьютера",exact:true}).count(),0);
  // Archiving the selected conversation on the desktop exits the phone chat.
  state.terminals = [{id:"fixture-second",kind:"claude",workspace,title:sessions[0].title,cli_session_id:sessions[0].id,closed:true}];
  await drawer.getByRole("button",{name:"Другой сеанс",exact:true}).click();
  await phone.getByRole("textbox",{name:"Сообщение"}).waitFor();
  await page.getByRole("tab",{name:"Другой сеанс",exact:true}).hover();
  await page.getByRole("group",{name:"Действия для Другой сеанс"}).getByRole("button",{name:"Архивировать",exact:true}).click();
  await page.getByRole("dialog",{name:"Заархивировать этот сеанс?"}).getByRole("button",{name:"Заархивировать сеанс"}).click();
  await drawer.waitFor();
  await drawer.getByText("Сеансов пока нет",{exact:true}).waitFor();
  assert.equal(await phone.getByRole("textbox",{name:"Сообщение"}).count(),0);
  assert.deepEqual(errors,[]); assert.deepEqual(phoneErrors,[]);
  console.log(engine+": left swipe, vertical scroll, keyboard, pin, bidirectional rename, failure/retry, archive/cancel, peer archive, label migration, reload passed");
} finally { await browser.close(); }
