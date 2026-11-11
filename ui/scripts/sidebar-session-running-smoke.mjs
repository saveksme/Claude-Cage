import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const output = process.env.CAGE_TEST_CAPTURE || "/tmp/cage-sidebar-session-running";
await mkdir(output, {recursive:true});
for (const platform of ["darwin", "windows", "linux"]) {
  const sessions = [
    {id:"external",title:"Сеанс в другом окне",running:true},
    {id:"owned",title:"Сеанс, открытый в Cage",running:true},
    {id:"waiting",title:"Сеанс, ожидающий открытия"},
    {id:"available",title:"Сеанс, который можно продолжить"},
  ];
  const releases = [], opens = [];
  let behavior = "hold", state;
  const fixture = await createWorkbench({
    url:process.env.CAGE_UI_URL || "http://127.0.0.1:5228",
    clientContext:{mode:"local",connection_id:"local",client_platform:platform,server_platform:platform},
    beforeNavigate:async (_page, value) => {
      state = value;
      state.status.ready = state.status.vm_running = true;
      sessions.forEach(session=>{session.workspace=state.settings.workspace;});
      state.terminals = [{id:"owned-terminal",kind:"claude",workspace:state.settings.workspace,title:sessions[1].title,cli_session_id:"owned"}];
    },
    cliRequest:async (route,path) => {
      if (path === "/cli/sessions") return route.fulfill({json:{sessions}});
      if (path.endsWith("/account")) return route.fulfill({json:{session:{},supported:false,candidates:[]}});
      if (path.endsWith("/open")) {
        const session = sessions.find(item=>path.includes("/"+item.id+"/"));
        opens.push(session.id);
        const mode = behavior;
        if (mode === "hold") await new Promise(resolve=>releases.push(resolve));
        if (mode === "error") return route.fulfill({status:409,contentType:"text/plain; charset=utf-8",body:"Исходный сеанс всё ещё выполняется в другом окне; сначала выйдите из него"});
        const terminal = {id:"terminal-"+session.id,kind:"claude",workspace:session.workspace,title:session.title,cli_session_id:session.id};
        state.terminals.push(terminal);
        return route.fulfill({json:{desktop_terminal_id:terminal.id}});
      }
      return route.fulfill({json:{}});
    },
  });
  const {page,browser,errors} = fixture;
  try {
    const external = page.getByRole("button",{name:sessions[0].title,exact:true});
    const waiting = page.getByRole("button",{name:sessions[2].title,exact:true});
    const available = page.getByRole("button",{name:sessions[3].title,exact:true});
    const owned = page.getByRole("tab",{name:sessions[1].title,exact:true});
    await external.waitFor();
    await owned.waitFor();
    assert.equal(await external.isDisabled(),true,"external running history must be disabled before clicking");
    await external.getByRole("img",{name:"Работает в другом окне",exact:true}).waitFor();
    assert.match(await external.getAttribute("title"),/Исходный сеанс всё ещё выполняется/);
    const box = await external.boundingBox();
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    assert.deepEqual(opens,[],"disabled external session sent an open request");
    assert.equal(await owned.isEnabled(),true,"owned live terminal was disabled");
    await owned.click();
    await owned.press("ArrowDown");
    assert.equal(await waiting.evaluate(element=>element===document.activeElement),true,"keyboard focus got stuck at a disabled session");
    assert.equal(await available.isEnabled(),true);
    await page.locator(".sidebar-scroll").screenshot({path:`${output}/${platform}-initial.png`});

    await waiting.click();
    await waiting.getByRole("img",{name:"Открытие сеанса",exact:true}).waitFor();
    assert.equal(await waiting.isDisabled(),true);
    assert.equal(await available.isEnabled(),true,"unrelated history flickered disabled");
    assert.equal(await owned.isEnabled(),true);
    const sent = opens.length;
    await page.mouse.click((await waiting.boundingBox()).x+20,(await waiting.boundingBox()).y+20);
    assert.equal(opens.length,sent,"pending session sent a duplicate open");
    behavior = "error";
    await available.focus();
    await page.keyboard.press("Enter");
    const failure = page.getByRole("alert").filter({hasText:"Исходный сеанс всё ещё выполняется"});
    await failure.waitFor();
    assert.equal(await waiting.isEnabled(),true,"cancelled request kept its row disabled");
    assert.equal(await available.isEnabled(),true,"failed open kept its row disabled");
    releases.shift()();
    await page.waitForFunction(id=>Boolean(document.querySelector(`[data-tab-id="${id}"]`)),"terminal:terminal-waiting");
    assert.equal(await owned.getAttribute("aria-selected"),"true","a cancelled response stole focus");

    // Exit the external process, then refresh using the production list event.
    sessions[0].running = false;
    await page.evaluate(()=>window.dispatchEvent(new Event("cage-cli-sessions-changed")));
    await page.waitForFunction(()=>document.querySelector('[aria-label="Сеанс в другом окне"]')?.disabled === false);
    assert.equal(await external.getByRole("img",{name:"Работает в другом окне"}).count(),0);
    behavior = "success";
    await external.click();
    await page.getByRole("tab",{name:sessions[0].title,exact:true}).waitFor();
    assert.equal(await failure.count(),0);

    // A lost receipt is bounded and leaves the same history available to retry.
    behavior = "hold";
    await page.clock.install();
    await available.click();
    await available.getByRole("img",{name:"Открытие сеанса",exact:true}).waitFor();
    await page.clock.fastForward(60001);
    await page.getByRole("alert").filter({hasText:"Истекло время ожидания открытия сеанса; история сохранена"}).waitFor();
    assert.equal(await available.isEnabled(),true);
    assert.deepEqual(errors,[]);
    await page.locator(".sidebar-scroll").screenshot({path:`${output}/${platform}-timeout.png`});
    console.log(`${platform}: initial disabled/spinner, owned terminal, isolated pending state, cancellation, error, exit/reopen and timeout passed`);
  } finally {
    releases.forEach(release=>release());
    await browser.close();
  }
}
