// Runs the actual workbench with isolated API fixtures. Real core forwarding is
// covered by proxy-chain-smoke.mjs; this script covers user input and recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkbench, chooseInline } from './workbench-fixture.mjs';

const output = path.resolve(process.env.CAGE_CHAIN_QA_OUTPUT || 'ui/.oil-ui/proxy-chain-20261105/shots');
await fs.mkdir(output, { recursive: true });
const f = await createWorkbench();
const { page, state, browser, errors } = f;
const saved = {
 sources: [
  { id:'airport', name:'Туристическая подписка', nodes:[{id:'entry',name:'🇺🇸 USA Los Angeles 02',type:'anytls'}, {id:'extra',name:'Tokyo Transit',type:'trojan'}]},
  { id:'home',name:'Резидентный прокси',nodes:[{id:'exit',name:'LoopsForge · AI резидентный IP · узел 001',type:'vless'}]},
 ], selected:'entry',route:['entry'],active:true,running:true,core_available:true,port:17896,state_label:'Ожидает запуска среды',route_error:'',
};
let failRoute = false, submissions = [];
await page.route('**/api/proxy', r=>r.fulfill({json:saved}));
await page.route('**/api/proxy/route', r=>{
 const body=r.request().postDataJSON();
 submissions.push(body);
 const available=saved.sources.flatMap(s=>s.nodes.map(n=>n.id));
 const valid=body.node_ids.length>0 && body.node_ids.every(id=>available.includes(id)) && new Set(body.node_ids).size===body.node_ids.length;
 const error=failRoute ? 'Ядро прокси отклонило конфигурацию; исходная конфигурация сохранена' : !valid ? 'Узел цепочки прокси недействителен' : '';
 if (!error) { saved.route=[...body.node_ids];saved.selected=body.node_ids.at(-1); }
 state.status.job={id:`route-${submissions.length}`,kind:'proxy',running:false,error,message:error?'':'Узел применён; запустите среду Cage, чтобы завершить проверку доступа к сети'};
 return r.fulfill({json:{id:state.status.job.id}});
});
const enter = async()=>{
 await page.getByRole('button',{name:/Настройки/}).click();
 await page.getByRole('button',{name:'Сеть и прокси',exact:true}).click();
 await page.getByRole('heading',{name:'Встроенный прокси',exact:true}).waitFor();
 await page.getByRole('combobox',{name:'Финальный выход',exact:true}).waitFor();
};
const idle = ()=>page.waitForFunction(()=>!document.querySelector('.proxy-progress'));
try {
 await page.getByRole('button',{name:'Проверка сети и изоляции',exact:true}).click();
 await page.getByRole('button',{name:'Правила выхода',exact:true}).click();
 await page.getByRole('heading',{name:'Встроенный прокси',exact:true}).waitFor();
 await page.getByRole('region',{name:'Правила изменения IP',exact:true}).waitFor();
 await page.getByRole('button',{name:'Цепочка прокси',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Применить прокси',exact:true}).isDisabled(),true);
 await chooseInline(page.getByRole('combobox',{name:'Финальный выход',exact:true}),'exit');
 const exit = page.getByRole('combobox',{name:'Финальный выход',exact:true});
 const via = page.getByRole('combobox',{name:'Промежуточный узел',exact:true});
 const relativeExit = async () => (await exit.boundingBox()).y - (await page.locator(".proxy-route").boundingBox()).y;
 const before=await relativeExit();
 await via.click();
 const after=await relativeExit();
 assert.ok(Math.abs(after-before)<1,'floating dropdown must not move the following exit');
 const list=await page.getByRole('listbox',{name:'Промежуточный узел — варианты'}).boundingBox();
 const container=await page.locator('.proxy-route').boundingBox();
 assert.ok(list.x>=container.x && list.x+list.width<=container.x+container.width,'dropdown escapes its container');
 await page.screenshot({path:path.join(output,'inline-options.png')});
 await via.press('Home'); await via.press('Enter');
 assert.match(await via.innerText(), /Los Angeles/);
 assert.equal(await via.getAttribute('aria-expanded'),'false');
 assert.equal(await via.evaluate(el=>el===document.activeElement),true);
 assert.ok(Math.abs((await relativeExit())-before)<2,'collapsed dropdown did not restore layout');
 assert.equal(submissions.length,0,'editing a chain applied it early');
 await page.getByText('Изменения прокси ожидают применения. Нажмите «Применить прокси»',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Вернуться в рабочую среду',exact:true}).last().click();
 await page.getByRole('dialog',{name:'Отменить несохранённые изменения?',exact:true}).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();
 assert.equal(await page.locator('.proxy-route-hop').count(),2);
 await page.getByRole('button',{name:'Основные',exact:true}).click();
 await page.getByRole('dialog',{name:'Отменить неприменённые изменения прокси?',exact:true}).waitFor();
 await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();
 assert.equal(await page.locator('.proxy-route-hop').count(),2);
 assert.equal(await page.getByRole('button',{name:'Выбрать узел 🇺🇸 USA Los Angeles 02',exact:true}).isDisabled(),true,'transit can also be selected as exit');
 await page.getByLabel('Шифрованный DNS',{exact:true}).fill('https://dns.google/dns-query');
 await page.getByRole('button',{name:'Сохранить настройки',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.settings-footer button.primary')?.disabled===true);
 assert.equal(await page.locator('.proxy-route-hop').count(),2,'saving other settings discarded the proxy draft');
 assert.equal(submissions.length,0,'saving other settings implicitly applied the route');

 await page.locator('.settings-content').evaluate(el=>el.scrollTop=0);
 await page.screenshot({path:path.join(output,'chain-draft.png')});
 await page.getByRole('button',{name:'Применить прокси',exact:true}).click(); await idle();
 await page.getByText('Текущая конфигурация применена',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Применить заново',exact:true}).waitFor();
 assert.deepEqual(saved.route,['entry','exit']);
 assert.deepEqual(submissions[0],{node_ids:['entry','exit'],port:17896});
 await page.reload();await enter();
 assert.match(await page.getByRole('combobox',{name:'Промежуточный узел',exact:true}).innerText(),/Los Angeles/);
 assert.match(await page.getByRole('combobox',{name:'Финальный выход',exact:true}).innerText(),/LoopsForge/);
 await page.getByRole('button',{name:'Добавить промежуточный узел',exact:true}).click();
 const extra=page.getByRole('combobox',{name:'Промежуточный узел 2',exact:true});
 await extra.focus();await extra.press('ArrowDown');await extra.press('End');await extra.press('Enter');
 assert.match(await extra.innerText(),/Tokyo/);
 failRoute=true;
 await page.getByRole('button',{name:'Применить прокси',exact:true}).click(); await idle();
 await page.getByRole('alert').filter({hasText:'Ядро прокси отклонило конфигурацию'}).waitFor();
 assert.deepEqual(saved.route,['entry','exit'],'failed route replaced persisted selection');
 assert.match(await extra.innerText(),/Tokyo/,'failed save lost the draft');
 await page.screenshot({path:path.join(output,'failed-apply.png')});
 failRoute=false;
 await page.getByRole('button',{name:'Применить прокси',exact:true}).click(); await idle();
 await page.getByText('Текущая конфигурация применена',{exact:true}).waitFor();
 assert.deepEqual(saved.route,['entry','extra','exit']);
 await page.getByRole('button',{name:'Удалить: Промежуточный узел 2',exact:true}).click();
 await page.getByRole('button',{name:'Отменить изменения',exact:true}).click();
 assert.equal(await page.locator('.proxy-route-hop').count(),3);
 await page.getByRole('button',{name:'Один узел',exact:true}).click();
 assert.equal(await page.locator('.proxy-route-hop').count(),1);
 await page.getByRole('button',{name:'Применить прокси',exact:true}).click(); await idle();
 await page.getByText('Текущая конфигурация применена',{exact:true}).waitFor();
 assert.deepEqual(saved.route,['exit']);
 // A changed backend list cannot silently shorten a pending route.
 saved.sources[0].nodes=saved.sources[0].nodes.filter(n=>n.id!=='extra');
 await page.getByRole('button',{name:'Цепочка прокси',exact:true}).click();
 await chooseInline(page.getByRole('combobox',{name:'Промежуточный узел',exact:true}),'entry');
 await page.getByRole('button',{name:'Применить прокси',exact:true}).click(); await idle();
 await page.getByText('Текущая конфигурация применена',{exact:true}).waitFor();
 await page.locator('.settings-content').evaluate(el=>el.scrollTop=0);
 await page.waitForFunction(()=>[...document.querySelectorAll('.proxy-route-hop')].every(el=>getComputedStyle(el).opacity==='1'));
 await page.screenshot({path:path.join(output,'chain-applied.png')});
 await page.locator('.proxy-route').screenshot({path:path.join(output,'chain-panel.png'),animations:'disabled'});
 await page.setViewportSize({width:760,height:900});
 await page.locator('.settings-content').evaluate(el=>el.scrollTop=0);
 const bounds=await page.locator('.proxy-route').boundingBox();
 assert.ok(bounds.x>=0 && bounds.x+bounds.width<=760,'route panel overflows the narrow viewport');
 await page.waitForFunction(()=>innerHeight===900 && innerWidth===760);
 assert.equal(await page.getByRole('heading',{name:'Встроенный прокси',exact:true}).count(),1);
 assert.equal(await page.locator('.settings-page').count(),1);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.screenshot({path:path.join(output,'narrow.png'),animations:'disabled'});
 await page.setViewportSize({width:1280,height:850});
 await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.screenshot({path:path.join(output,'dark.png'),animations:'disabled'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,submissions:submissions.length,checks:['network-check exit-rules entry','cross-source route draft','floating options keep layout fixed','keyboard selection and focus','explicit atomic apply','reload persistence','failed apply keeps draft','retry','multiple transit nodes','undo','leave and section-change confirmation','saving DNS preserves route draft','single-node mode','narrow viewport'],browserErrors:errors}));
} finally {await browser.close();}
