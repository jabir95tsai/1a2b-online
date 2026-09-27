import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createSolver, applyFeedback } from '../src/core/solver.ts';
import assert from 'node:assert/strict';
const base=process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';
const output = base === 'http://127.0.0.1:8787' ? 'reports/browser-local' : 'reports/browser-production';
const browser=await chromium.launch({channel:'chrome',headless:true});
const report={base,date:new Date().toISOString(),checks:[],frames:0,httpViews:0,activePrivateViews:0,errors:[]};
const states=new Map();const solos=new Map();const frames=[];const contexts=[];
async function page(context) {
  const p=await context.newPage();
  p.on('pageerror',e=>report.errors.push(e.message));
  p.on('websocket',ws=>ws.on('framereceived',event=>{
    if(event.payload==='pong')return;
    try{const m=JSON.parse(String(event.payload));if(m.type==='room'){states.set(p,m.room);frames.push(m.room);report.frames++;}}catch{}
  }));
  p.on('response',async r=>{if(r.url().includes('/api/solo')&&r.ok()){try{const d=await r.json();if(d.game)solos.set(p,d.game);}catch{}}});
  p.on('response',async r=>{if(r.url().includes('/api/rooms')&&!r.url().endsWith('/ws')&&r.ok()){try{const d=await r.json();if(d.room){frames.push(d.room);report.httpViews++;}}catch{}}});
  await p.goto(base);await expect(p.locator('#notice')).toBeEmpty();
  // Wait for bootstrap before navigation; session cookie is shared across tabs.
  await expect.poll(async()=> (await context.cookies()).some(c=>c.name==='__Host-1a2b-session')).toBe(true);
  return p;
}
async function click(p,text){await p.getByRole('button',{name:text,exact:true}).click();}
async function home(p){if(await p.locator('.back').count())await p.locator('.back').click();}
async function choose(p,name,value){await p.locator(`[name="${name}"][value="${value}"]`).check();}
async function form(p,name,values,submit){for(const [key,value] of Object.entries(values)){const field=p.locator(`form[data-form="${name}"] [name="${key}"]`);if(await field.first().getAttribute('type')==='radio')await field.and(p.locator(`[value="${value}"]`)).check();else await field.fill(String(value));}await p.locator(`form[data-form="${name}"] button[type="submit"]`).click();if(submit)await submit();}
async function roomReady(p){await expect.poll(()=>states.get(p)?.connectionEpoch??0).toBeGreaterThan(0);await expect(p.locator('.badge').first()).toContainText('已連線');}
async function openRoom(p,q,kind){
  await home(p);await click(p,'好友對戰');await choose(p,'kind',kind);await p.locator('[data-form="room-create"] button').click();await roomReady(p);
  const code=states.get(p).code;
  if(kind==='race'){
    await p.context().grantPermissions(['clipboard-read','clipboard-write']);
    await click(p,'複製邀請');await expect(p.locator('#notice')).toContainText('已複製');
    const link=await p.evaluate(()=>navigator.clipboard.readText());assert.match(link,/#join=[A-Z2-9]{8}\.[a-f0-9]{64}$/);
    await q.goto(link);await expect(q.locator('[name="code"]')).toHaveValue(code);assert.equal(new URL(q.url()).hash,'');
    await q.locator('[data-form="room-join"] button').click();report.checks.push('長 token 分享連結加入、讀取後清除 fragment');
  }else{await click(q,'好友對戰');await form(q,'room-join',{code});}
  await roomReady(q);await expect.poll(()=>states.get(p)?.life).toBe('active');
}
async function move(p,guess){const before=states.get(p);await form(p,'room-guess',{guess});await expect.poll(()=>states.get(p)?.revision??0).toBeGreaterThan(before.revision);}
async function restart(p,q){await p.locator('[data-form="rematch"] button').click();await q.locator('[data-form="rematch"] button').click();await expect.poll(()=>states.get(p)?.life).toBe('active');await expect.poll(()=>states.get(q)?.life).toBe('active');}
try{
  await mkdir(output,{recursive:true});
  const c0=await browser.newContext({viewport:{width:1280,height:900}}),c1=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(c0,c1);
  let p=await page(c0),q=await page(c1);
  await p.screenshot({path:output + "/home-desktop.png",fullPage:true});
  await p.setViewportSize({width:375,height:812});await p.screenshot({path:output + "/home-mobile.png",fullPage:true});assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.setViewportSize({width:1280,height:900});
  await click(p,'電腦猜');await p.locator('[name="answer"]').fill('8590');await p.locator('[data-form="solo-create"] button').click();await expect.poll(()=>solos.get(p)?.kind).toBe('B-honest');
  for(let i=0;i<10&&solos.get(p).status!=='finished';i++){const rev=solos.get(p).revision;await p.locator('[data-form="solo-next"] button').click();await expect.poll(()=>solos.get(p)?.revision??0).toBeGreaterThan(rev);}
  assert.equal(solos.get(p).answer,'8590');assert.equal(solos.get(p).steps,8);report.checks.push('Mode B 誠實模式 8590：8 步完成');await p.screenshot({path:output + "/solver-finished.png",fullPage:true});
  await click(p,'再來一局');await choose(p,'kind','B-oral');await p.locator('[data-form="solo-create"] button').click();await expect.poll(()=>solos.get(p)?.kind).toBe('B-oral');
  await form(p,'feedback',{a:0,b:0});await expect.poll(()=>solos.get(p)?.steps).toBe(1);await form(p,'feedback',{a:0,b:0});await expect(p.locator('#notice')).toContainText('矛盾');assert.equal(solos.get(p).steps,1);
  await click(p,'修正回饋');await p.locator('[data-turn="1"]').click();await form(p,'correct',{a:1,b:0});await expect.poll(()=>solos.get(p)?.history[0]?.feedback.a).toBe(1);report.checks.push('Mode B 口述矛盾拒絕、不計步，修正舊回饋後重新推理');
  await home(p);await click(p,'我來猜');await choose(p,'limit','custom');await p.locator('[name="count"]').fill('1');await p.locator('[data-form="solo-create"] button').click();await expect.poll(()=>solos.get(p)?.kind).toBe('A');await form(p,'solo-guess',{guess:'0123'});await expect.poll(()=>solos.get(p)?.status).toBe('finished');assert.equal(solos.get(p).history.length,1);report.checks.push('Mode A 限制次數與最終揭曉');
  await openRoom(p,q,'duel');
  const inviteResponse=await p.evaluate(async()=>{const code=localStorage.getItem('room');const response=await fetch(`/api/rooms/${code}/invite`);return response.json();});assert.match(inviteResponse.inviteToken,/^[a-f0-9]{64}$/);report.checks.push('重新登入房間後可取得長邀請 token');
  await form(p,'answer',{answer:'0123'});await form(q,'answer',{answer:'9876'});await expect.poll(()=>states.get(p)?.game?.phase).toBe('playing');
  const first=states.get(p).game.firstPlayer;const firstPage=first===0?p:q,secondPage=first===0?q:p;
  await move(firstPage,'4567');await move(secondPage,'4567');await expect.poll(()=>states.get(p)?.game?.round).toBe(2);
  await q.close();q=await page(c1);await roomReady(q);assert.equal(states.get(q).game.round,2);
  await move(first===0?p:q,first===0?'9876':'0123');assert.equal(states.get(first===0?p:q).game.phase,'playing');
  await move(first===0?q:p,first===0?'0123':'9876');await expect.poll(()=>states.get(p)?.life).toBe('retained');assert.equal(states.get(p).game.result.reason,'draw');report.checks.push('C-1 完整對局、中途關頁重連、後手同回合和局');
  await p.screenshot({path:output + "/duel-finished.png",fullPage:true});await restart(p,q);assert.equal(states.get(p).game.firstPlayer,first===0?1:0);report.checks.push('C-1 再戰交換先手、保留身分席位');
  const old=p;p=await page(c0);await roomReady(p);await expect(old.locator('#notice')).toContainText('已在其他視窗開啟');await old.close();report.checks.push('同身分新分頁接管，舊分頁停止操作');
  p.on('dialog',d=>d.accept());await click(p,'離開並結束對戰');await expect.poll(()=>states.get(q)?.life).toBe('retained');await click(q,'離開房間');
  await home(p);await click(p,'好友對戰');await choose(p,'kind','race');await p.locator('[data-form="room-create"] button').click();await roomReady(p);assert.equal(states.get(p).life,'waiting');
  const leaveResponse=p.waitForResponse(r=>r.url().endsWith('/actions'));await click(p,'離開並結束對戰');const left=await leaveResponse;assert.equal(left.status(),200);assert.equal((await left.json()).room.life,'expired');
  await expect(p.locator('.waiting-card')).toHaveCount(0);await p.waitForTimeout(500);await expect(p.locator('#notice')).toBeEmpty();assert.equal(await p.evaluate(()=>localStorage.getItem('room')),null);report.checks.push('等待中房主離開：動作成功、無錯誤提示並清除房間');
  await openRoom(p,q,'race');
  // Same guesses force a draw without ever reading the server's answer.
  let solver=createSolver();
  for(let i=0;i<10;i++){
    const guess=solver.pendingGuess;await move(p,guess);const pending=states.get(p);assert.equal(pending.game.myHistory.length,i);assert(!('answers'in pending.game));
    if(i===1){await q.close();q=await page(c1);await roomReady(q);}
    await move(q,guess);await expect.poll(()=>states.get(p)?.game?.myHistory.length).toBe(i+1);
    const v=states.get(p);if(v.life==='retained'){assert.equal(v.game.result.reason,'draw');break;}
    const result=applyFeedback(solver,v.game.myHistory.at(-1).feedback);assert(result.ok);solver=result.state;
  }
  assert.equal(states.get(p).life,'retained');report.checks.push('C-2 同步回饋、完整和局、中途關頁重連');
  await p.screenshot({path:output + "/race-finished.png",fullPage:true});await restart(p,q);
  solver=createSolver();let gotSingle=false;
  for(let i=0;i<10;i++){
    await move(p,solver.pendingGuess);await move(q,'0123');await expect.poll(()=>states.get(p)?.game?.myHistory.length).toBe(i+1);
    const v=states.get(p);if(v.life==='retained'){if(v.game.result.reason==='draw'){await restart(p,q);solver=createSolver();i=-1;continue;}assert.equal(v.game.result.winner,0);gotSingle=true;break;}
    const result=applyFeedback(solver,v.game.myHistory.at(-1).feedback);assert(result.ok);solver=result.state;
  }
  assert(gotSingle);report.checks.push('C-2 單方命中，結束後公開雙方完整歷程');
  await restart(p,q);await move(p,'0123');
  console.log('正在等待真實 60 秒回合逾時…');
  await expect.poll(()=>states.get(p)?.life,{timeout:75000,intervals:[1000]}).toBe('retained');assert.deepEqual(states.get(p).game.result,{winner:0,reason:'timeout'});report.checks.push('C-2 真實 60 秒逾時，未提交者判負');
  const allowed=['phase','round','deadline','result','firstPlayer','turn','answerReady','canSetAnswer','canGuess','myPending','myHistory','opponentSteps','opponentHistory','answers'];
  for(const v of frames){assert(!('data'in v));assert(!('receipts'in v));assert(!('inviteHash'in v));if(v.game)for(const key of Object.keys(v.game))assert(allowed.includes(key),`unexpected public key: ${key}`);if(v.game?.phase!=='finished'&&v.game){assert(!('answers'in v.game));if(v.kind==='race'){assert(!('opponentHistory'in v.game));report.activePrivateViews++;}}}
  await writeFile(output + "/packet-samples.json",JSON.stringify({note:'擷取實際公開 game 欄位，省略房碼與身分相關外層欄位。',racePending:frames.find(v=>v.kind==='race'&&v.game?.myPending)?.game,raceOpponent:frames.find(v=>v.kind==='race'&&v.game?.opponentSteps===1&&v.game?.myHistory.length===0&&!v.game.myPending)?.game,raceFinished:frames.find(v=>v.kind==='race'&&v.game?.phase==='finished')?.game},null,2));
  assert.deepEqual(report.errors,[]);report.checks.push('逐一檢查所有進行中 WebSocket 投影：無答案欄位、C-2 無對手歷程');
  report.ok=true;
}catch(error){report.ok=false;report.failure=String(error.stack??error);throw error;}
finally{await writeFile(output + "/verification.json",JSON.stringify(report,null,2));for(const c of contexts)await c.close();await browser.close();console.log(JSON.stringify(report,null,2));}

