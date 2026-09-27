import { env } from 'cloudflare:workers';
import { runInDurableObject, evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { expect,it } from 'vitest';
import type { RoomView } from '../../src/protocol/room.ts';
import type { RoomState } from '../../src/server/rooms/host.ts';
async function fixture(kind:'duel'|'race'='race') {
  const stub=env.GAME_ROOMS.getByName(crypto.randomUUID());const owner=crypto.randomUUID(),peer=crypto.randomUUID();
  const created=await stub.create(owner,{code:'ABCDEFGH',requestId:crypto.randomUUID(),kind,inviteHash:'test-invite',revealOpponentHistory:false});expect(created.status).toBe(201);
  const first=await stub.fetch('https://room.internal/ws',{headers:{Upgrade:'websocket','X-Room-Owner':owner}});expect(first.status).toBe(101);first.webSocket!.accept();
  expect((await stub.join(peer,null)).status).toBe(200);
  const second=await stub.fetch('https://room.internal/ws',{headers:{Upgrade:'websocket','X-Room-Owner':peer}});expect(second.status).toBe(101);second.webSocket!.accept();
  const view=async(who=owner)=>{const result=await stub.view(who);if(!('room'in result.body))throw new Error(result.body.error.code);return result.body.room as RoomView;};
  const act=async(who:string,input:Record<string,unknown>,old?:RoomView)=>{const v=old??await view(who);return stub.action(who,{requestId:crypto.randomUUID(),incarnation:v.incarnation,gameId:v.gameId,connectionEpoch:v.connectionEpoch,...input});};
  const edit=async(fn:(s:RoomState)=>void)=>runInDurableObject(stub,(_i,ctx)=>{const s:RoomState=JSON.parse(ctx.storage.sql.exec<{snapshot:string}>('SELECT snapshot FROM room').one().snapshot);fn(s);ctx.storage.sql.exec('UPDATE room SET snapshot=?',JSON.stringify(s));});
  const close=()=>{first.webSocket!.close();second.webSocket!.close();};
  return{stub,owner,peer,view,act,edit,close,socket:first.webSocket!};
}
it('fetch upgrade、私有投影、hibernation 後 WebSocket 喚醒與已鎖定動作',async()=>{
  const f=await fixture();try{
    await f.edit(s=>{(s.game!.data as {answer:string}).answer='9876';});
    expect((await f.act(f.owner,{type:'guess',round:1,guess:'0123'})).status).toBe(200);
    await evictDurableObject(f.stub);
    const woke = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket did not wake')), 3000);
      const listener = (event: MessageEvent) => { const frame = JSON.parse(String(event.data)); if (frame.room?.game?.myPending === '0123') { clearTimeout(timer); f.socket.removeEventListener('message',listener); resolve(); } };
      f.socket.addEventListener('message',listener);
    });
    f.socket.send('sync'); await woke;
    const v=await f.view();expect(v.game!.myPending).toBe('0123');expect(v.game!.myHistory).toEqual([]);
    const peer=await f.view(f.peer);expect(JSON.stringify(peer)).not.toContain('"0123"');expect(JSON.stringify(peer)).not.toContain('"9876"');expect(peer.game).not.toHaveProperty('opponentHistory');
    expect((await f.act(f.owner,{type:'guess',round:1,guess:'4567'})).status).toBe(409);
    await f.act(f.peer,{type:'guess',round:1,guess:'9876'});const end=await f.view();expect(end.life).toBe('retained');expect(end.game!.answers).toEqual(['9876','9876']);expect(end.game!.opponentHistory![0]!.guess).toBe('9876');
  }finally{f.close();}
});
it('同時送出只鎖定一次、重送不多算，兩方同時出手共同結算',async()=>{
  const f=await fixture();try{
    await f.edit(s=>{(s.game!.data as {answer:string}).answer='9876';});
    const v=await f.view();const command={requestId:crypto.randomUUID(),incarnation:v.incarnation,gameId:v.gameId,connectionEpoch:v.connectionEpoch,type:'guess',round:1,guess:'0123'};
    const [a,b]=await Promise.all([f.stub.action(f.owner,command),f.stub.action(f.owner,command)]);expect(a.status).toBe(200);expect(b.status).toBe(200);expect((await f.view()).game!.myHistory).toHaveLength(0);
    await f.act(f.peer,{type:'guess',round:1,guess:'4567'});
    const [first,second]=await Promise.all([f.act(f.owner,{type:'guess',round:2,guess:'9876'}),f.act(f.peer,{type:'guess',round:2,guess:'9876'})]);expect(first.status).toBe(200);expect(second.status).toBe(200);expect((await f.view()).game!.result?.reason).toBe('draw');
  }finally{f.close();}
});
it('非成員不能取得邀請 metadata，正常成員可分享但不能奪取席位',async()=>{
  const f=await fixture();try{expect(await f.stub.inviteMetadata(crypto.randomUUID())).toBeNull();const metadata=await f.stub.inviteMetadata(f.peer);expect(metadata?.creator).toBe(f.owner);}finally{f.close();}
});
it('同身分不占第二席，後連線接管，房滿與邀請驗證',async()=>{
  const f=await fixture();try{const old=await f.view();expect((await f.stub.join(f.owner,null)).status).toBe(200);expect((await f.stub.join(crypto.randomUUID(),null)).status).toBe(409);expect((await f.stub.join(f.peer,'bad')).status).toBe(404);
    const next=await f.stub.fetch('https://room.internal/ws',{headers:{Upgrade:'websocket','X-Room-Owner':f.owner}});next.webSocket!.accept();expect((await f.view()).connectionEpoch).toBe(old.connectionEpoch+1);expect((await f.act(f.owner,{type:'guess',round:1,guess:'0123'},old)).status).toBe(409);next.webSocket!.close();
  }finally{f.close();}
});
it('雙方同意再戰更換 gameId、清空歷程，舊局動作拒絕',async()=>{
  const f=await fixture();try{await f.act(f.owner,{type:'leave'});const old=await f.view();await f.act(f.owner,{type:'rematch',accept:true});expect((await f.view()).life).toBe('retained');await f.act(f.peer,{type:'rematch',accept:true});const next=await f.view();expect(next.gameId).not.toBe(old.gameId);expect(next.matchNumber).toBe(2);expect(next.game!.myHistory).toEqual([]);expect(next.game).not.toHaveProperty('answers');expect((await f.act(f.owner,{type:'guess',round:1,guess:'0123'},old)).status).toBe(409);}finally{f.close();}
});
it('alarm 判定同步回合逾時並保留最終歷程',async()=>{
  const f=await fixture();try{await f.act(f.owner,{type:'guess',round:1,guess:'0123'});await f.edit(s=>{s.game!.deadline=Date.now()-1;});await runDurableObjectAlarm(f.stub);const v=await f.view();expect(v.life).toBe('retained');expect(v.game!.result).toEqual({winner:0,reason:'timeout'});}finally{f.close();}
});
it('碰撞不覆蓋原房間；空房回收不洩露原局',async()=>{
  const f=await fixture();try{expect((await f.stub.create(crypto.randomUUID(),{code:'ABCDEFGH',requestId:crypto.randomUUID(),kind:'duel',inviteHash:'other',revealOpponentHistory:false})).status).toBe(409);await f.edit(s=>{s.emptyDeadline=Date.now()-1;});await runDurableObjectAlarm(f.stub);expect((await f.stub.view(f.owner)).status).toBe(404);}finally{f.close();}
});


it('等待中房主離開回傳最終投影、重送同請求仍成功，其後房間到期並回收',async()=>{
  const stub=env.GAME_ROOMS.getByName(crypto.randomUUID());const owner=crypto.randomUUID();
  expect((await stub.create(owner,{code:'ABCDEFGH',requestId:crypto.randomUUID(),kind:'race',inviteHash:'test-invite',revealOpponentHistory:false})).status).toBe(201);
  const upgrade=await stub.fetch('https://room.internal/ws',{headers:{Upgrade:'websocket','X-Room-Owner':owner}});expect(upgrade.status).toBe(101);const ws=upgrade.webSocket!;ws.accept();
  const expired=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('no expired frame')),3000);ws.addEventListener('message',event=>{if(JSON.parse(String(event.data)).type==='expired'){clearTimeout(timer);resolve();}});});
  try{
    const current=await stub.view(owner);if(!('room'in current.body))throw new Error(current.body.error.code);const v=current.body.room as RoomView;expect(v.life).toBe('waiting');
    const command={requestId:crypto.randomUUID(),incarnation:v.incarnation,gameId:v.gameId,connectionEpoch:v.connectionEpoch,type:'leave'};
    const left=await stub.action(owner,command);expect(left.status).toBe(200);if(!('room'in left.body))throw new Error(left.body.error.code);expect(left.body.room.life).toBe('expired');expect(left.body.room.game).toBeNull();
    await expired;
    const replay=await stub.action(owner,command);expect(replay.status).toBe(200);if(!('room'in replay.body))throw new Error(replay.body.error.code);expect(replay.body.room.life).toBe('expired');
    expect((await stub.action(owner,{...command,requestId:crypto.randomUUID()})).status).toBe(410);
    expect((await stub.action(crypto.randomUUID(),command)).status).not.toBe(200);
    expect((await stub.view(owner)).status).toBe(410);
    await runDurableObjectAlarm(stub);expect((await stub.view(owner)).status).toBe(404);
  }finally{ws.close();}
});
