import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const base = process.env.CAGE_UI_URL || "http://127.0.0.1:5209";
const engine = process.env.CAGE_TEST_BROWSER || "chromium";
const output = process.env.CAGE_TEST_CAPTURE || "../output/archive-bulk-20261108";
const alpha = "/fixture/alpha", beta = "/fixture/beta";
const seed = [
  {id:"a1",workspace:alpha,title:"План проекта",pinned:true},
  {id:"a2",workspace:alpha,title:"Проверка интерфейса"},
  {id:"b1",workspace:beta,title:"Проверка мобильной версии"},
  {id:"b2",workspace:beta,title:"Незавершённое удаление",deleting:true},
].map(s => ({...s,archived:true,updated_at:"2026-11-08T00:00:00Z"}));
let sessions = structuredClone(seed), failID = "", holdID = "", release;
const operations = [];
const handle = async (route, path, body) => {
  if (path === "/cli/sessions") return route.fulfill({json:{sessions:sessions.filter(s => s.archived === (new URL(route.request().url()).searchParams.get("archived") === "true"))}});
  const [, id, operation] = path.match(/\/sessions\/([^/]+)\/(restore|purge)$/) || [];
  if (!id) return route.fulfill({json:{}});
  operations.push({id,operation});
  if (operation === "purge") assert.equal(body.confirm,true);
  if (id === holdID) await new Promise(resolve => { release = resolve; });
  if (id === failID) return route.fulfill({status:503,contentType:"text/plain; charset=utf-8",body:"Тест: соединение прервано"});
  const session = sessions.find(s => s.id === id);
  if (operation === "restore") session.archived = false;
  else sessions = sessions.filter(s => s.id !== id);
  return route.fulfill({json:{ok:true}});
};
const desktop = await createWorkbench({url:base,cliRequest:handle});
const {page,browser,state,errors} = desktop;
const checkbox = (scope,name) => scope.getByRole("checkbox",{name,exact:true});
const allName = "Выбрать все результаты текущего фильтра";
const projectName = path => `Выбрать все результаты текущего фильтра в проекте ${path}`;
try {
  state.status.ready = state.status.vm_running = true;
  await page.getByRole("button",{name:"Настройки",exact:true}).click();
  await page.getByRole("navigation",{name:"Разделы настроек"}).getByRole("button",{name:"Архивные сеансы",exact:true}).click();
  const panel = page.getByRole("region",{name:"Архивные сеансы",exact:true});
  await checkbox(panel,allName).waitFor();
  const inputBox = await checkbox(panel,allName).boundingBox();
  const labelBox = await panel.locator(".archive-selection").first().locator("span").boundingBox();
  assert.ok(labelBox.x > inputBox.x && Math.abs(labelBox.y + labelBox.height / 2 - inputBox.y - inputBox.height / 2) < 2,"select-all label did not align with its checkbox");
  // Keyboard selection and mixed states must match the visible project and total.
  await checkbox(panel,"Выбрать сеанс План проекта").focus(); await page.keyboard.press("Space");
  assert.equal(await checkbox(panel,projectName(alpha)).evaluate(el => el.indeterminate),true);
  assert.equal(await checkbox(panel,allName).evaluate(el => el.indeterminate),true);
  await checkbox(panel,projectName(alpha)).check();
  assert.equal(await checkbox(panel,"Выбрать сеанс Проверка интерфейса").isChecked(),true);
  assert.equal(await checkbox(panel,"Выбрать сеанс Проверка мобильной версии").isChecked(),false);
  await checkbox(panel,allName).check();
  assert.equal(await panel.getByRole("button",{name:"Восстановить выбранные",exact:true}).isDisabled(),true);
  await panel.getByRole("button",{name:"Снять выделение",exact:true}).click();
  assert.equal(await checkbox(panel,allName).isChecked(),false);
  const search = panel.getByRole("searchbox");
  await checkbox(panel,allName).check();
  await search.fill("интерфейс");
  assert.equal(await checkbox(panel,allName).isChecked(),false,"filter kept hidden selections");
  await checkbox(panel,allName).check();
  await panel.getByRole("button",{name:"Восстановить выбранные",exact:true}).click();
  await panel.getByRole("status").filter({hasText:"Сеансов восстановлено из архива: 1"}).waitFor();
  assert.deepEqual(operations.splice(0),[{id:"a2",operation:"restore"}],"filtered select all affected hidden sessions");
  await search.fill("");
  // Changing filters clears selection; its floating list keeps content in place.
  await checkbox(panel,allName).check();
  const filter = panel.getByRole("combobox",{name:"Фильтр проектов"});
  const toolbar = panel.getByRole("group",{name:"Массовая обработка сеансов"});
  const before = await toolbar.boundingBox();
  await filter.click();
  const list = await page.getByRole("listbox",{name:"Фильтр проектов — варианты"}).boundingBox();
  assert.ok(Math.abs((await toolbar.boundingBox()).y-before.y)<1 && list.height>0);
  await filter.press("Escape");
  assert.ok(Math.abs((await toolbar.boundingBox()).y-before.y)<2);
  await filter.press("End"); await filter.press("Enter");
  assert.equal(await checkbox(panel,allName).isChecked(),false);
  await filter.press("Home"); await filter.press("Enter");
  // Partial restore keeps only the failed selection and allows retry.
  sessions = structuredClone(seed);
  // A polling refresh brings the externally restored session back into the list.
  await panel.getByRole("heading",{name:"Проверка интерфейса",exact:true}).waitFor();
  failID = "a2"; holdID = "a1";
  await checkbox(panel,projectName(alpha)).check();
  await panel.getByRole("button",{name:"Восстановить выбранные",exact:true}).click();
  await panel.getByRole("status").filter({hasText:"Обработка сеансов"}).waitFor();
  assert.equal(await search.isDisabled(),true);
  assert.equal(await checkbox(panel,allName).isDisabled(),true);
  assert.equal(await panel.getByRole("button",{name:"Удалить выбранные",exact:true}).isDisabled(),true);
  release(); holdID = "";
  await panel.getByRole("alert").filter({hasText:"Не удалось обработать сеансов: 1"}).waitFor();
  assert.equal(await panel.getByRole("heading",{name:"План проекта",exact:true}).count(),0);
  assert.equal(await checkbox(panel,"Выбрать сеанс Проверка интерфейса").isChecked(),true);
  assert.equal(await checkbox(panel,"Выбрать сеанс Проверка мобильной версии").isChecked(),false);
  failID = "";
  await panel.getByRole("button",{name:"Восстановить выбранные",exact:true}).click();
  await panel.getByRole("heading",{name:"Проверка интерфейса",exact:true}).waitFor({state:"hidden"});
  // Batch purge requires confirmation. Partial purge retains failures for a fresh confirmation.
  await checkbox(panel,projectName(beta)).check();
  await panel.getByRole("button",{name:"Удалить выбранные",exact:true}).click();
  let confirm = panel.getByRole("group",{name:"Подтверждение массового безвозвратного удаления",exact:true});
  await confirm.getByRole("button",{name:"Отмена",exact:true}).click();
  assert.equal(operations.filter(o => o.operation === "purge").length,0);
  failID = "b2";
  await panel.getByRole("button",{name:"Удалить выбранные",exact:true}).click();
  await confirm.getByRole("button",{name:"Удалить выбранные навсегда",exact:true}).click();
  await panel.getByRole("alert").filter({hasText:"Незавершённое удаление"}).waitFor();
  assert.equal(await checkbox(panel,"Выбрать сеанс Незавершённое удаление").isChecked(),true);
  assert.equal(await panel.getByRole("heading",{name:"Проверка мобильной версии",exact:true}).count(),0);
  failID = "";
  await panel.getByRole("button",{name:"Удалить выбранные",exact:true}).click();
  await confirm.getByText(/Безвозвратно удалить выбранные сеансы (1)/).waitFor();
  await confirm.getByRole("button",{name:"Удалить выбранные навсегда",exact:true}).click();
  await panel.getByText("Архивных сеансов пока нет.",{exact:true}).waitFor();
  assert.deepEqual(operations.filter(o => o.operation === "purge").map(o => o.id),["b1","b2","b2"]);
  // Phone uses the same component and host API, including offline restore and deletion restrictions.
  sessions = structuredClone(seed);
  const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:"CageMobile/1"});
  const phone = await context.newPage();
  const phoneErrors = []; phone.on("pageerror",e => phoneErrors.push(e.message));
  let ready = false;
  await phone.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/mobile/cli","/cli");
    if (path.endsWith("/projects")) return route.fulfill({json:{host:"Изолированный тестовый хост",ready,shared_sessions:true,projects:[{path:alpha,name:"alpha"},{path:beta,name:"beta"}]}});
    return handle(route,path,route.request().postDataJSON());
  });
  await phone.goto(base+"/mobile.html");
  await phone.getByRole("dialog",{name:"Боковая панель рабочей области"}).getByRole("button",{name:"Настройки",exact:true}).click();
  await phone.getByRole("button",{name:"Архивные сеансы",exact:true}).click();
  await checkbox(phone,projectName(alpha)).check();
  assert.equal(await phone.getByRole("button",{name:"Удалить выбранные",exact:true}).isDisabled(),true);
  assert.equal(await phone.getByRole("button",{name:"Восстановить выбранные",exact:true}).isEnabled(),true);
  await phone.getByRole("button",{name:"Восстановить выбранные",exact:true}).click();
  await phone.getByRole("heading",{name:"Проверка интерфейса",exact:true}).waitFor({state:"hidden"});
  ready = true;
  await phone.getByRole("button",{name:"Вернуться в настройки",exact:true}).click();
  await phone.getByRole("button",{name:"Архивные сеансы",exact:true}).click();
  await checkbox(phone,allName).check();
  await phone.getByRole("button",{name:"Удалить выбранные",exact:true}).click();
  await phone.getByRole("group",{name:"Подтверждение массового безвозвратного удаления"}).waitFor();
  await mkdir(output,{recursive:true});
  await phone.screenshot({path:`${output}/${engine}-mobile.png`,fullPage:true});
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,"mobile layout overflowed");
  await phone.getByRole("button",{name:"Удалить выбранные навсегда",exact:true}).click();
  await phone.getByText("Архивных сеансов пока нет.",{exact:true}).waitFor();
  await phone.reload();
  await phone.getByRole("heading",{name:"Архивные сеансы",exact:true}).waitFor();
  await phone.getByText("Архивных сеансов пока нет.",{exact:true}).waitFor();
  assert.equal(sessions.filter(s => s.archived).length,0);
  // Capture the desktop controls with selections for visual review.
  sessions = structuredClone(seed);
  await checkbox(panel,projectName(alpha)).check();
  await page.screenshot({path:`${output}/${engine}-desktop.png`});
  assert.deepEqual(errors,[]); assert.deepEqual(phoneErrors,[]);
  console.log(`${engine}: item/project/all selection, mixed state, keyboard, filter scope, progress/locking, restore/purge partial failure and retry, delete cancellation, mobile/offline/reload passed`);
} finally { await browser.close(); }
