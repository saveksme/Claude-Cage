import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const base = process.env.CAGE_UI_URL || "http://127.0.0.1:5209";
const output = process.env.CAGE_TEST_CAPTURE || "../docs/test-reports/2026-11-07-cli-session-sync";
const workspace = "/Users/shihao/.claude-cage-workspace";
const id = "12345678-1234-4321-aaaa-123456789abc";
const otherID = "12345678-1234-4321-aaaa-123456789abd";
const otherProject = "/Users/shihao/Projects/mobile";
const sessions = [
  {id, workspace, title:"История с компьютера", terminal_available:true, revision:1, updated_at:"2026-11-07T08:00:00Z",
    turns:[{id:"turn-1", prompt:"Исходный вопрос", text:"Исходный ответ", status:"completed"}]},
  {id:otherID, workspace, title:"Другой сеанс", revision:1, updated_at:"2026-11-07T07:00:00Z", turns:[]},
  {id:"12345678-1234-4321-aaaa-123456789abe", workspace, title:"Подготовка примечаний к выпуску", archived:true, pinned:true, updated_at:"2026-11-06T09:00:00Z", turns:[]},
  {id:"12345678-1234-4321-aaaa-123456789abf", workspace, title:"Проверка интерфейса", archived:true, updated_at:"2026-11-05T08:00:00Z", turns:[]},
  {id:"12345678-1234-4321-aaaa-123456789ac0", workspace:otherProject, title:"Проверка мобильной вёрстки", archived:true, updated_at:"2026-11-04T08:00:00Z", turns:[]},
];
let state, failPurge = true, failOpen = true, opens = 0, releaseOpen;
const handle = async (route, path, body) => {
  const archived = new URL(route.request().url()).searchParams.get("archived") === "true";
  if (path === "/cli/sessions") return route.fulfill({json:{sessions:sessions.filter(s => Boolean(s.archived) === archived),notice:""}});
  const session = sessions.find(s => path.includes(s.id));
  if (!session) return route.fulfill({status:404});
  if (path.endsWith("/open")) {
    opens++;
    if (failOpen) return route.fulfill({status:409,contentType:"text/plain; charset=utf-8",body:"Тест: исходный терминал ещё работает; сначала выйдите из Claude Code в нём"});
    await new Promise(resolve => { releaseOpen = resolve; });
    const terminal = {id:"restored-terminal", kind:"claude", workspace, title:session.title, cli_session_id:session.id};
    state.terminals = [terminal];
    return route.fulfill({json:{...session,desktop_terminal_id:terminal.id}});
  }
  if (path.endsWith("/archive")) {
    session.archived = true; session.revision++;
    state.terminals = state.terminals.filter(t => t.cli_session_id !== session.id);
  } else if (path.endsWith("/restore")) {
    session.archived = false; session.revision++;
  } else if (path.endsWith("/purge")) {
    assert.equal(body.confirm,true);
    if (failPurge) return route.fulfill({status:503,contentType:"text/plain; charset=utf-8",body:"Не удалось удалить сеанс: соединение прервано. Повторите"});
    sessions.splice(sessions.indexOf(session),1);
  } else if (path.endsWith("/metadata")) Object.assign(session,body);
  return route.fulfill({json:session});
};
const desktop = await createWorkbench({url:base, cliRequest:handle});
state = desktop.state;
const {page,browser,errors} = desktop;
try {
  state.status.ready = state.status.vm_running = true;
  state.status.projects = [workspace, otherProject];
  const history = page.getByRole("button",{name:"История с компьютера",exact:true});
  await history.waitFor();
  await history.click();
  await page.getByRole("status").filter({hasText:"Тест: исходный терминал ещё работает"}).waitFor();
  assert.equal(await page.getByRole("dialog",{name:"История с компьютера"}).count(),0,"session click opened an intermediate preview");
  assert.equal(await history.isEnabled(),true,"failed session open could not be retried");
  failOpen = false;
  await history.click();
  await page.waitForFunction(() => document.querySelector('.sidebar-session[aria-busy="true"]')?.disabled);
  assert.equal(await page.getByRole("button",{name:"Другой сеанс",exact:true}).isDisabled(),true,"another open was allowed during terminal restore");
  releaseOpen();
  await page.getByRole("tab",{name:"История с компьютера",exact:true}).waitFor();
  assert.equal(await history.count(),0,"history duplicated its live terminal");
  assert.equal(opens,2,"clicking one session sent duplicate open requests");
  assert.equal(state.terminalConnections,1,"restored terminal did not connect");
  assert.equal(state.requests.filter(r => r.path === "/cli/sessions/" + id).length,0,"desktop fetched a history preview");
  await page.getByRole("tab",{name:"История с компьютера",exact:true}).hover();
  await page.getByRole("group",{name:"Действия для История с компьютера"}).getByRole("button",{name:"Архивировать",exact:true}).click();
  await page.getByRole("dialog",{name:"Заархивировать этот сеанс?"}).getByRole("button",{name:"Заархивировать сеанс",exact:true}).click();
  await page.getByRole("tab",{name:"История с компьютера",exact:true}).waitFor({state:"hidden"});
  assert.deepEqual(errors,[],"desktop archive");

  const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:"CageMobile/1"});
  const phone = await context.newPage();
  const phoneErrors = [];
  phone.on("pageerror",error => phoneErrors.push(error.message));
  await phone.route("**/api/**",async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/mobile/cli","/cli");
    if (path.endsWith("/projects")) return route.fulfill({json:{host:"Тестовый компьютер",ready:true,shared_sessions:true,projects:[{path:workspace,name:"Рабочая область по умолчанию"},{path:otherProject,name:"mobile"}]}});
    return handle(route,path,route.request().postDataJSON());
  });
  await phone.goto(base+"/mobile.html");
  const drawer = phone.getByRole("dialog",{name:"Боковая панель рабочей области"});
  await drawer.getByRole("button",{name:"Настройки",exact:true}).click();
  await phone.getByRole("button",{name:"Архивные сеансы",exact:true}).click();
  let archived = phone.getByRole("article").filter({has:phone.getByRole("heading",{name:"История с компьютера",exact:true})});
  await archived.getByRole("button",{name:"Восстановить из архива"}).click();
  await history.waitFor();
  await phone.getByRole("button",{name:"Вернуться в настройки"}).click();
  await phone.getByRole("button",{name:"Вернуться к сеансу"}).click();
  const row = drawer.locator(".swipe-session").filter({has:phone.getByRole("button",{name:"История с компьютера",exact:true})});
  await row.getByRole("button",{name:"История с компьютера: другие действия"}).click();
  await row.getByRole("button",{name:"Архивировать",exact:true}).click();
  await phone.getByRole("dialog",{name:"Заархивировать сеанс",exact:true}).getByRole("button",{name:"Заархивировать сеанс",exact:true}).click();
  await history.waitFor({state:"hidden"});
  assert.deepEqual(errors,[],"phone archive");

  await page.getByRole("button",{name:"Настройки",exact:true}).click();
  await page.getByRole("navigation",{name:"Разделы настроек"}).getByRole("button",{name:"Архивные сеансы",exact:true}).click();
  const panel = page.getByRole("region",{name:"Архивные сеансы",exact:true});
  const projectFilter = panel.getByRole("combobox",{name:"Фильтр проектов"});
  const group = panel.locator(".archive-project").first();
  await group.waitFor();
  const before = await group.boundingBox();
  await projectFilter.click();
  const options = page.getByRole("listbox",{name:"Фильтр проектов — варианты"});
  const opened = await options.boundingBox();
  const shifted = await group.boundingBox();
  assert.ok(Math.abs(shifted.y-before.y)<1 && opened.height>0,"floating project filter moved content");
  await projectFilter.press("Escape");
  assert.ok(Math.abs((await group.boundingBox()).y - before.y) < 2,"filter did not restore layout");
  await projectFilter.press("End"); await projectFilter.press("Enter");
  await panel.getByRole("heading",{name:"Проверка мобильной вёрстки",exact:true}).waitFor();
  assert.equal(await panel.getByRole("heading",{name:"История с компьютера",exact:true}).count(),0);
  await projectFilter.press("Home"); await projectFilter.press("Enter");
  const filter = panel.getByRole("combobox",{name:"Фильтр сеансов"});
  await filter.click(); await page.getByRole("option",{name:"Закреплённые",exact:true}).click();
  assert.equal(await panel.getByRole("article").count(),1);
  await filter.press("Home"); await filter.press("Enter");
  const search = panel.getByRole("searchbox",{name:"Поиск архивных сеансов"});
  await search.fill("интерфейс");
  assert.equal(await panel.getByRole("article").count(),1);
  await search.fill("");
  await panel.getByRole("heading",{name:".claude-cage-workspace",exact:true}).click();
  await mkdir(output,{recursive:true});
  await page.screenshot({path:output+"/"+(process.env.CAGE_TEST_BROWSER||"chromium")+"-archive-layout.png"});
  const target = panel.getByRole("article").filter({has:page.getByRole("heading",{name:"История с компьютера",exact:true})});
  await target.getByRole("button",{name:"Удалить сеанс",exact:true}).click();
  await target.getByRole("button",{name:"Удалить навсегда",exact:true}).click();
  await panel.getByRole("alert").filter({hasText:"Не удалось удалить сеанс: соединение прервано"}).waitFor();
  assert.equal(sessions.length,5,"failed purge removed history");
  await mkdir(output,{recursive:true});
  await page.screenshot({path:output+"/"+(process.env.CAGE_TEST_BROWSER||"chromium")+"-archived-desktop.png"});
  failPurge = false;
  await target.getByRole("button",{name:"Удалить навсегда",exact:true}).click();
  await target.waitFor({state:"hidden"});
  await phone.evaluate(() => window.dispatchEvent(new Event("cage-open-archives")));
  await drawer.waitFor({state:"hidden"});
  await phone.getByRole("heading",{name:"Подготовка примечаний к выпуску",exact:true}).waitFor();
  assert.equal(await phone.getByRole("heading",{name:"История с компьютера",exact:true}).count(),0);
  const phoneGroup = phone.locator(".archive-project").first();
  const phoneBefore = await phoneGroup.boundingBox();
  const phoneFilter = phone.getByRole("combobox",{name:"Фильтр проектов"});
  await phoneFilter.click();
  const phoneOptions = await phone.getByRole("listbox",{name:"Фильтр проектов — варианты"}).boundingBox();
  assert.ok(Math.abs((await phoneGroup.boundingBox()).y-phoneBefore.y)<1 && phoneOptions.height>0,"floating phone filter moved content");
  await phoneFilter.press("Escape");
  assert.ok(Math.abs((await phoneGroup.boundingBox()).y-phoneBefore.y)<2);
  await phone.getByRole("heading",{name:"Архивные сеансы",exact:true}).click();
  await phone.screenshot({path:output+"/"+(process.env.CAGE_TEST_BROWSER||"chromium")+"-archived-mobile.png"});
  assert.deepEqual(errors,[],"before reload");
  await page.waitForLoadState("networkidle");
  await page.reload();
  await page.getByRole("button",{name:"Другой сеанс",exact:true}).waitFor();
  assert.equal(await history.count(),0);
  assert.equal(sessions.length,4);
  assert.equal(sessions[0].id,otherID);
  assert.deepEqual(errors,[]);
  assert.deepEqual(phoneErrors,[]);
  console.log("Persistent desktop history, terminal resume, bidirectional archive/restore, purge confirmation/failure/retry, reload passed");
} finally { await browser.close(); }
