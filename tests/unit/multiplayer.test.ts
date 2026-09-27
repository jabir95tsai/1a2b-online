import { describe, it, expect } from 'vitest';
import { race } from '../../src/server/rooms/strategies/race.ts';
import { duel } from '../../src/server/rooms/strategies/duel.ts';
import { parseCode } from '../../src/core/rules.ts';
import type { GameContext, GameState } from '../../src/server/rooms/strategy.ts';
import { roomAction, codeFromDigest, roomCode } from '../../src/server/rooms/validation.ts';
const ctx: GameContext = { now: 1000, randomAnswer: () => parseCode('9876'), randomSeat: () => 0, connected:[true,true], revealOpponentHistory:false };
const guess = (value:string, round=1) => ({type:'guess' as const,guess:parseCode(value),round});
describe('同步競速',()=>{
  it('封鎖待揭曉的回饋與對手內容，兩人提交才同步公開自己的回饋',()=>{
    let s=race.start(null,ctx); s=race.act(s,0,guess('0123'),ctx);
    expect(race.project(s,0,ctx).myPending).toBe('0123');
    const peer=race.project(s,1,ctx);expect(peer).not.toHaveProperty('answers');expect(peer).not.toHaveProperty('opponentHistory');expect(JSON.stringify(peer)).not.toContain('0123');
    expect(race.project(s,0,ctx).myHistory).toEqual([]);
    expect(()=>race.act(s,0,guess('4567'),ctx)).toThrow();
    s=race.act(s,1,guess('4567'),ctx);expect(s.round).toBe(2);expect(race.project(s,0,ctx).myHistory).toHaveLength(1);
    expect(JSON.stringify(race.project(s,0,ctx))).not.toContain('4567');
  });
  it.each([['9876','0123',0],['0123','9876',1],['9876','9876',null]] as const)('同步結局 %s / %s', (a,b,winner)=>{
    let s=race.start(null,ctx);s=race.act(s,0,guess(a),ctx);expect(s.phase).toBe('playing');s=race.act(s,1,guess(b),ctx);
    expect(s.phase).toBe('finished');expect(s.result!.winner).toBe(winner);
    for(const seat of [0,1] as const){expect(race.project(s,seat,ctx).answers).toEqual(['9876','9876']);expect(race.project(s,seat,ctx).opponentHistory).toHaveLength(1);}
  });
  it.each([0,1] as const)('逾時方判負，已提交者 %i 勝', seat=>{
    let s=race.start(null,ctx);s=race.act(s,seat,guess('0123'),ctx);s=race.expire(s,{...ctx,now:61000});expect(s.result).toEqual({winner:seat,reason:'timeout'});
  });
  it('雙方逾時取消，新局重新出題；離線不延長回合',()=>{
    const s=race.start(null,ctx);expect(race.presence(s,0,false,ctx).deadline).toBe(61000);
    expect(race.expire(s,{...ctx,now:61000}).result?.reason).toBe('cancelled');
    expect(race.project(race.start(s,{...ctx,randomAnswer:()=>parseCode('0123')}),0,ctx)).not.toHaveProperty('answers');
  });
  it('公開旗標仍不提前公開未完成回合',()=>{
    const s=race.act(race.start(null,ctx),0,guess('0123'),ctx);
    expect(race.project(s,1,{...ctx,revealOpponentHistory:true}).opponentHistory).toEqual([]);
  });
});
function ready():GameState {let s=duel.start(null,ctx);s=duel.act(s,0,{type:'set-answer',round:s.round,answer:parseCode('0123')},ctx);return duel.act(s,1,{type:'set-answer',round:s.round,answer:parseCode('9876')},ctx);}
describe('輪流互猜',()=>{
  it('先手命中後仍保留後手同回合權益，雙中和局',()=>{let s=ready();s=duel.act(s,0,guess('9876'),ctx);expect(s.phase).toBe('playing');expect(duel.project(s,0,ctx)).not.toHaveProperty('answers');s=duel.act(s,1,guess('0123'),ctx);expect(s.result).toEqual({winner:null,reason:'draw'});});
  it('後手未命中則先手勝；新局交換先手',()=>{let s=ready();s=duel.act(s,0,guess('9876'),ctx);s=duel.act(s,1,guess('4567'),ctx);expect(s.result?.winner).toBe(0);expect(duel.project(duel.start(s,ctx),0,ctx).firstPlayer).toBe(1);});
  it('拒絕越權回合、答案重新設定；後手可直接勝',()=>{let s=ready();expect(()=>duel.act(s,1,guess('0123'),ctx)).toThrow();expect(()=>duel.act(s,0,{type:'set-answer',round:1,answer:parseCode('4567')},ctx)).toThrow();s=duel.act(s,0,guess('4567'),ctx);s=duel.act(s,1,guess('0123'),ctx);expect(s.result?.winner).toBe(1);});
  it('對手猜自己的題可以看見，但答案不輸出',()=>{const s=duel.act(ready(),0,guess('4567'),ctx);const v=duel.project(s,1,ctx);expect(v.opponentHistory?.[0]?.guess).toBe('4567');expect(v).not.toHaveProperty('answers');});
  it('離線超過寬限則結束，重新連線可恢復',()=>{const s=duel.presence(ready(),1,false,ctx);expect(duel.expire(s,{...ctx,now:61001,connected:[true,false]}).result?.winner).toBe(0);expect(duel.presence(s,1,true,{...ctx,now:2000}).phase).toBe('playing');});
});
describe('房間輸入',()=>{
  it('八碼排除易混字元',()=>{expect(()=>roomCode('0O1ILABC')).toThrow();expect(codeFromDigest('00'.repeat(32))).toBe('22222222');expect(()=>roomCode('ABCDEFGH ')).toThrow();});
  it('所有動作重新验证数字、epoch、局識別',()=>{const base={requestId:crypto.randomUUID(),incarnation:crypto.randomUUID(),gameId:crypto.randomUUID(),connectionEpoch:1,type:'guess',round:1};for(const value of ['１２３４','1123','123','12345',' 123','abcd'])expect(()=>roomAction({...base,guess:value})).toThrow();expect(()=>roomAction({...base,guess:'0123',connectionEpoch:0})).toThrow();});
});
