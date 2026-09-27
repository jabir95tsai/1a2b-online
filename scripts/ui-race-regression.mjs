import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.E2E_BASE_URL??'http://127.0.0.1:8787';
const browser=await chromium.launch({channel:'chrome',headless:true});
const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
const pages=await Promise.all(contexts.map(c=>c.newPage()));
const views=new Map();
try{
  for(const p of pages){p.on('websocket',ws=>ws.on('framereceived',e=>{try{const m=JSON.parse(String(e.payload));if(m.room)views.set(p,m.room);}catch{}}));await p.goto(base);await expect.poll(async()=>(await p.context().cookies()).length).toBeGreaterThan(0);await p.getByRole('button',{name:'好友對戰',exact:true}).click();}
  const [host,guest]=pages;
  await guest.route('**/api/rooms/*/actions',async route=>{
    if(route.request().postDataJSON().type!=='set-answer')return route.continue();
    const response=await route.fetch();
    // Reproduce WebSocket arriving substantially before this HTTP response.
    await new Promise(resolve=>setTimeout(resolve,2000));await route.fulfill({response});
  });
  await host.locator('[data-form="room-create"] button').click();await expect.poll(()=>views.get(host)?.code).toBeTruthy();
  await guest.locator('[name="code"]').fill(views.get(host).code);await guest.locator('[data-form="room-join"] button').click();
  await expect(guest.locator('[data-form="answer"] input')).toBeEnabled();
  for(const [p,answer] of [[host,'0123'],[guest,'9876']]){await p.locator('[name="answer"]').fill(answer);await p.locator('[data-form="answer"] button').click();}
  await expect.poll(()=>views.get(host)?.game?.phase).toBe('playing');
  if(views.get(host).game.firstPlayer===0){await host.locator('[name="guess"]').fill('4567');await host.locator('[data-form="room-guess"] button').click();await expect.poll(()=>views.get(guest)?.game?.turn).toBe(1);}
  await expect(guest.locator('[name="guess"]')).toBeDisabled();
  await guest.locator('[name="guess"]').fill('4567');
  await guest.locator('[data-form="room-guess"] button').click();
  await expect.poll(()=>views.get(guest)?.game?.myHistory.length).toBe(1);
  assert.equal(views.get(guest).game.myHistory[0].guess,'4567');
  const result={base,checkedAt:new Date().toISOString(),ok:true,scenario:'HTTP set-answer response delayed 2000ms after WebSocket; next input locked until completion; typed guess preserved'};
  await writeFile('reports/ui-race-regression.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
