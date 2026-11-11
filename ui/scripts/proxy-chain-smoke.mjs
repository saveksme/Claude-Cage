// Real authenticated workbench, bundled Mihomo and local HTTP CONNECT servers.
// Uses a new private profile. Never touches the user's Cage, VM or subscriptions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CAGE_PLAYWRIGHT_MODULE || 'playwright');
const run=promisify(execFile);
const root=path.resolve(import.meta.dirname,'../..');
const executable=process.env.CAGE_CHAIN_QA_EXECUTABLE || path.join(root,'_output/proxy-chain-20261105/bin/cage');
const output=path.join(root,'docs/test-reports/2026-11-05-proxy-chain');
await fs.mkdir(output,{recursive:true});
const profile=await fs.mkdtemp('/private/tmp/cage-chain-qa-');
const env={...process.env,CLAUDE_CAGE_CONFIG:path.join(profile,'config.json')};
await run(executable,['init'],{env});
const sockets=new Set();
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
async function upstream(){
 const destinations=[];
 const server=http.createServer();
 server.on('connect',(req,client,head)=>{
  destinations.push(req.url);
  const destination=new URL(`http://${req.url}`);
  const remote=net.connect(Number(destination.port),destination.hostname,()=>{
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if(head.length)remote.write(head);
   remote.pipe(client);client.pipe(remote);
  });
  for(const socket of [client,remote]){sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{client.destroy();remote.destroy();});}
 });
 await listen(server);
 return {server,port:server.address().port,destinations};
}
const entry=await upstream(),exit=await upstream();
let targetRequests=0;
const target=http.createServer((_req,res)=>{targetRequests++;res.end('residential-exit-verified');});
await listen(target);
const reserve=net.createServer();await listen(reserve);const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const log=await fs.open(path.join(profile,'server.log'),'w',0o600);
const server=spawn(executable,['serve'],{env,stdio:['ignore',log.fd,log.fd]});
let browser;
const errors=[];
try{
 let control;
 for(let i=0;i<100;i++){try{control=JSON.parse(await fs.readFile(path.join(profile,'control.json')));break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.ok(control,'private service did not start');
 const origin=`http://localhost:${control.port}`;
 assert.equal((await fetch(origin+'/api/proxy')).status,401);
 const launch=await fetch(origin+'/api/launch',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:control.token})}).then(r=>r.json());
 browser=await chromium.launch({headless:true,executablePath:process.env.CAGE_TEST_BROWSER_PATH});
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(launch.url);
 await page.getByLabel('Имя пользователя',{exact:true}).fill('Proxy Chain QA');
 await page.getByLabel('Задать пароль',{exact:true}).fill('isolated-chain-test-password');
 await page.getByLabel('Подтвердите пароль',{exact:true}).fill('isolated-chain-test-password');
 await page.getByRole('button',{name:'Создать локальный аккаунт',exact:true}).click();
 const enter=async()=>{
  await page.getByRole('button',{name:/Настройки/}).click();
  await page.getByRole('button',{name:'Сеть и прокси',exact:true}).click();
  await page.getByRole('heading',{name:'Встроенный прокси',exact:true}).waitFor();
 };
 await enter();
 const idle=()=>page.waitForFunction(()=>!document.querySelector('.proxy-progress'));
 for(const [name,node,upstreamPort] of [['Транзитный источник','Локальный транзит',entry.port],['Резидентный источник','Резидентный выход',exit.port]]){
  await page.getByRole('tab',{name:'Подписки',exact:true}).click();
  await page.getByRole('button',{name:'Добавить источник',exact:true}).click();
  await page.getByRole('button',{name:'Локальный YAML',exact:true}).click();
  await page.getByLabel('Название источника',{exact:true}).fill(name);
  await page.getByLabel('YAML узлов',{exact:true}).fill(`proxies:\n - {name: ${node}, type: http, server: 127.0.0.1, port: ${upstreamPort}}\n`);
  await page.getByRole('button',{name:'Импортировать и проверить',exact:true}).click();await idle();
  await page.getByText(name,{exact:true}).waitFor();
 }
 await page.getByRole('tab',{name:'Диагностика',exact:true}).click();
 await page.getByLabel('Отдельный порт прокси',{exact:true}).fill(String(port));
 await page.getByRole('tab',{name:'Узлы',exact:true}).click();
 await page.getByRole('button',{name:'Цепочка прокси',exact:true}).click();
 const choose=async(label,name)=>{
  await page.getByRole('combobox',{name:label,exact:true}).click();
  await page.getByRole('option',{name,exact:true}).click();
 };
 await choose('Финальный выход','Резидентный выход');
 await choose('Промежуточный узел','Локальный транзит');
 await page.getByRole('button',{name:'Применить прокси',exact:true}).click();await idle();
 await page.getByText('Текущая конфигурация применена',{exact:true}).waitFor();
 const state=()=>page.evaluate(()=>fetch('/api/proxy').then(r=>r.json()));
 const applied=await state();assert.equal(applied.active,true);assert.equal(applied.running,true);assert.equal(applied.route.length,2);
 const stored=JSON.parse(await fs.readFile(path.join(profile,'proxy/sources.json')));
 const curlConfig=path.join(profile,'curl.conf');
 await fs.writeFile(curlConfig,`proxy = "socks5h://cage:${stored.auth}@127.0.0.1:${stored.port}"\n`,{mode:0o600});
 const through=()=>run('curl',['--config',curlConfig,'--noproxy','','--fail','--silent','--show-error','--max-time','6',`http://127.0.0.1:${target.address().port}/probe`]);
 assert.equal((await through()).stdout,'residential-exit-verified');
 assert.deepEqual(entry.destinations,[`127.0.0.1:${exit.port}`]);
 assert.deepEqual(exit.destinations,[`127.0.0.1:${target.address().port}`]);
 await page.reload();await enter();
 assert.equal((await state()).route.join(','),applied.route.join(','));
 assert.match(await page.getByRole('combobox',{name:'Промежуточный узел',exact:true}).innerText(),/Локальный транзит/);
 await page.locator('.settings-content').evaluate(el=>el.scrollTop=0);
 await page.waitForFunction(()=>[...document.querySelectorAll('.proxy-route-hop')].every(el=>getComputedStyle(el).opacity==='1'));
 await page.screenshot({path:path.join(output,'real-chain.png')});
 // Single-node explicitly bypasses the intermediate, without editing its source.
 const entryCount=entry.destinations.length;
 await page.getByRole('button',{name:'Один узел',exact:true}).click();
 await page.getByRole('button',{name:'Применить прокси',exact:true}).click();await idle();
 await page.getByText('Текущая конфигурация применена',{exact:true}).waitFor();
 assert.equal((await through()).stdout,'residential-exit-verified');
 assert.equal(entry.destinations.length,entryCount);
 // Re-enable the chain, then break its exit: no direct target request may occur.
 await page.getByRole('button',{name:'Цепочка прокси',exact:true}).click();await choose('Промежуточный узел','Локальный транзит');
 await page.getByRole('button',{name:'Применить прокси',exact:true}).click();await idle();
 await page.getByText('Текущая конфигурация применена',{exact:true}).waitFor();
 for(const socket of sockets)socket.destroy();
 await new Promise(resolve=>exit.server.close(resolve));
 const beforeFailure=targetRequests;
 await assert.rejects(through());
 assert.equal(targetRequests,beforeFailure,'broken chain fell back to target directly');
 const final=await state();assert.deepEqual(final.route,applied.route);
 assert.deepEqual(errors,[]);
 const result={passed:true,realWorkbench:true,realMihomo:true,crossSourceChain:true,entryReachedExit:entry.destinations.length>0,exitReachedTarget:true,reloadPersistence:true,singleNodeBypassesTransit:true,brokenExitHasNoDirectFallback:true,targetRequests,browserErrors:errors,guestVMTested:false,platform:process.platform};
 await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}catch(e){await fs.writeFile(path.join(output,'failure.txt'),String(e));throw e;}
finally{
 if(browser)await browser.close();
 await run(executable,['proxy-stop'],{env}).catch(()=>{});
 server.kill('SIGTERM');await log.close();
 for(const socket of sockets)socket.destroy();
 entry.server.closeAllConnections();exit.server.closeAllConnections();target.closeAllConnections();
 entry.server.close();exit.server.close();target.close();
 console.log('Private QA profile retained at '+profile);
}
