import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { SoloSuccess, ErrorView, SoloView } from '../../src/protocol/solo.ts';
import { SoloRepository } from '../../src/server/solo/repository.ts';
import { CandidateSet } from '../../src/core/candidates.ts';
import { score } from '../../src/core/rules.ts';

const origin = 'https://game.example';
it('失效 Cookie 可建立新匿名身分，但不能取回原玩家局面', async () => {
  const c = new Client(); await c.session(); const old = await c.create({ kind: 'A', maxGuesses: 10 });
  c.cookie = '__Host-1a2b-session=invalid'; await c.session();
  expect((await c.request(`/api/solo/${old.id}`)).response.status).toBe(404);
});
type Payload = SoloSuccess | ErrorView;
class Client {
  cookie = '';
  ip = crypto.randomUUID(); // Synthetic trusted-edge identity; never a real client IP.
  async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: {
      Origin: origin, 'CF-Connecting-IP': this.ip, Cookie: this.cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await exports.default.fetch(`${origin}${path}`, init);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const payload = await response.json<Payload>();
    return { response, payload };
  }
  async session() {
    const result = await this.request('/api/session', 'POST', {});
    expect(result.response.status).toBe(200);
    return result;
  }
  async create(config: Record<string, unknown>) {
    const result = await this.request('/api/solo', 'POST', { requestId: crypto.randomUUID(), ...config });
    expect(result.response.status).toBe(201);
    return success(result.payload);
  }
  async act(view: SoloView, action: Record<string, unknown>, requestId = crypto.randomUUID()) {
    return this.request(`/api/solo/${view.id}/actions`, 'POST', {
      requestId, generation: view.generation, expectedRevision: view.revision, ...action,
    });
  }
}
function success(payload: Payload): SoloView {
  if (!('game' in payload)) throw new Error(`Unexpected API error: ${payload.error.code}`);
  return payload.game;
}
function errorCode(payload: Payload): string {
  if (!('error' in payload)) throw new Error('Expected error');
  return payload.error.code;
}
async function client(): Promise<Client> {
  const result = new Client();
  await result.session();
  return result;
}
async function stored(game: SoloView) {
  return runInDurableObject(env.SOLO_GAMES.getByName(game.id), (_instance, ctx) => {
    const row = ctx.storage.sql.exec<{ snapshot: string; candidates: ArrayBuffer }>('SELECT snapshot, candidates FROM solo_game').one();
    return { state: JSON.parse(row.snapshot), bytes: row.candidates.byteLength, snapshot: row.snapshot };
  });
}
function privateFieldsAbsent(view: SoloView): void {
  expect(Object.keys(view).sort()).toEqual([
    'id', 'generation', 'revision', 'kind', 'status', 'outcome', 'expiresAt', 'steps', 'history',
    'maxGuesses', 'pendingGuess', 'candidateCount', ...(view.status === 'finished' && 'answer' in view ? ['answer'] : []),
  ].sort());
  if (view.status === 'active') expect(view).not.toHaveProperty('answer');
  for (const step of view.history) {
    expect(Object.keys(step).sort()).toEqual((view.kind === 'A'
      ? ['guess', 'feedback'] : ['guess', 'feedback', 'candidatesBefore', 'candidatesAfter']).sort());
  }
}

describe('SoloGame real Workers runtime / HTTP API', () => {
  it('匿名安全 cookie、不回傳擁有者；未登入與跨站請求被拒絕', async () => {
    const c = new Client();
    expect((await c.request('/api/solo', 'POST', {})).response.status).toBe(401);
    const { response } = await c.session();
    const cookie = response.headers.get('set-cookie')!;
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(cookie).toContain(flag);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await c.request('/api/solo', 'POST', {}, { Origin: 'https://other.example' })).response.status).toBe(403);
    c.cookie = c.cookie.slice(0, -1) + (c.cookie.endsWith('0') ? '1' : '0');
    expect((await c.request('/api/solo', 'POST', {})).response.status).toBe(401);
  });

  it('Mode A 預設 10 次、限制終局才揭曉，非法猜測不計次不寫入', async () => {
    const c = await client();
    let game = await c.create({ kind: 'A' });
    expect(game.maxGuesses).toBe(10);
    privateFieldsAbsent(game);
    const before = await stored(game);
    for (const guess of ['123', '0012', '０１２３', '0123 ', '12 3', 1234]) {
      const rejected = await c.act(game, { type: 'guess', guess });
      expect(rejected.response.status).toBe(400);
      expect((await stored(game)).snapshot).toBe(before.snapshot);
    }
    const answer: string = before.state.answer;
    const miss = answer === '0123' ? '4567' : '0123';
    for (let turn = 1; turn <= 10; turn++) {
      const result = await c.act(game, { type: 'guess', guess: miss });
      expect(result.response.status).toBe(200);
      game = success(result.payload);
      expect(game.steps).toBe(turn);
      privateFieldsAbsent(game);
      // Compare a whole JSON string value, not digits accidentally inside timestamps/IDs.
      if (turn < 10) expect(JSON.stringify(result.payload)).not.toContain(JSON.stringify(answer));
    }
    expect(game).toMatchObject({ status: 'finished', outcome: 'lost', answer });
    expect(errorCode((await c.act(game, { type: 'guess', guess: answer })).payload)).toBe('GAME_FINISHED');
  });

  it('Mode A 最後一手猜中優先判勝；無限猜超過 10 手仍可繼續', async () => {
    const c = await client();
    let limited = await c.create({ kind: 'A', maxGuesses: 1 });
    const answer: string = (await stored(limited)).state.answer;
    limited = success((await c.act(limited, { type: 'guess', guess: answer })).payload);
    expect(limited).toMatchObject({ status: 'finished', outcome: 'won', steps: 1, answer });
    let unlimited = await c.create({ kind: 'A', maxGuesses: null });
    const otherAnswer: string = (await stored(unlimited)).state.answer;
    for (let i = 0; i < 12; i++) unlimited = success((await c.act(unlimited, { type: 'guess', guess: otherAnswer === '0123' ? '4567' : '0123' })).payload);
    expect(unlimited).toMatchObject({ status: 'active', steps: 12, maxGuesses: null });
    expect(unlimited).not.toHaveProperty('answer');
  });

  it.each(['0123', '9876', '8590', '8905', '9580'])('Mode B 誠實模式 HTTP 整局 %s', async answer => {
    const c = await client();
    let game = await c.create({ kind: 'B-honest', answer });
    expect(game).toMatchObject({ pendingGuess: '0123', candidateCount: 5040, steps: 0 });
    privateFieldsAbsent(game);
    const frames: SoloView[] = [game];
    while (game.status === 'active') {
      expect(game.steps).toBeLessThan(8);
      const guess = game.pendingGuess!;
      const result = await c.act(game, { type: 'next' });
      expect(result.response.status).toBe(200);
      game = success(result.payload);
      frames.push(game);
      expect(game.history.at(-1)!.feedback).toEqual(score(answer, guess));
      privateFieldsAbsent(game);
      expect((await stored(game)).bytes).toBe(630);
    }
    expect(game).toMatchObject({ status: 'finished', outcome: 'solved', answer, candidateCount: 1 });
    expect(frames.filter(frame => frame.status === 'active').every(frame => !('answer' in frame))).toBe(true);
    if (['8590', '8905', '9580'].includes(answer)) expect(game.steps).toBe(8);
  });

  it('口述模式矛盾不寫入、更正歷史會截斷並重新計算、4A0B 結束', async () => {
    const c = await client();
    let game = await c.create({ kind: 'B-oral' });
    game = success((await c.act(game, { type: 'feedback', feedback: { a: 0, b: 0 } })).payload);
    expect(game.pendingGuess).toBe('4567');
    const snapshot = (await stored(game)).snapshot;
    const contradiction = await c.act(game, { type: 'feedback', feedback: { a: 0, b: 0 } });
    expect(contradiction.response.status).toBe(422);
    expect(errorCode(contradiction.payload)).toBe('CONTRADICTORY_FEEDBACK');
    expect((await stored(game)).snapshot).toBe(snapshot);
    for (const feedback of [{ a: -1, b: 2 }, { a: 3, b: 1 }, { a: 2, b: 3 }, { a: 0.1, b: 1 }]) {
      expect((await c.act(game, { type: 'feedback', feedback })).response.status).toBe(400);
    }
    game = success((await c.act(game, { type: 'feedback', feedback: score('9876', game.pendingGuess) })).payload);
    expect(game.steps).toBe(2);
    game = success((await c.act(game, { type: 'correct', turn: 1, feedback: { a: 1, b: 0 } })).payload);
    expect(game.steps).toBe(1);
    expect(game.pendingGuess).toBe('0456');
    expect(game.candidateCount).toBe(480);
    const finalAnswer = game.pendingGuess;
    game = success((await c.act(game, { type: 'feedback', feedback: { a: 4, b: 0 } })).payload);
    expect(game).toMatchObject({ outcome: 'solved', answer: finalAnswer, steps: 2 });
    expect((await c.act(game, { type: 'correct', turn: 1, feedback: { a: 0, b: 0 } })).response.status).toBe(409);
  });

  it('建立冪等、動作重送不計次，requestId 換內容、舊 revision／generation 被拒絕', async () => {
    const c = await client();
    const creation = { requestId: crypto.randomUUID(), kind: 'A', maxGuesses: null };
    const first = await c.request('/api/solo', 'POST', creation);
    const initial = success(first.payload);
    const repeat = await c.request('/api/solo', 'POST', creation);
    expect(repeat.response.status).toBe(200);
    expect(success(repeat.payload)).toEqual(initial);
    expect((await c.request('/api/solo', 'POST', { ...creation, maxGuesses: 10 })).response.status).toBe(409);
    const answer: string = (await stored(initial)).state.answer;
    const action = { type: 'guess', guess: answer === '0123' ? '4567' : '0123' };
    const requestId = crypto.randomUUID();
    const accepted = await c.act(initial, action, requestId);
    const saved = (await stored(initial)).snapshot;
    const replay = await c.act(initial, action, requestId);
    expect(replay.response.status).toBe(200);
    expect(replay.payload).toMatchObject({ replayed: true });
    expect(success(replay.payload)).toEqual(success(accepted.payload));
    expect((await stored(initial)).snapshot).toBe(saved);
    expect(errorCode((await c.act(initial, { type: 'guess', guess: '9876' }, requestId)).payload)).toBe('REQUEST_ID_REUSED');
    expect(errorCode((await c.act(initial, action)).payload)).toBe('STALE_REVISION');
    expect(errorCode((await c.act(success(accepted.payload), { ...action, generation: crypto.randomUUID() })).payload)).toBe('STALE_GENERATION');
  });

  it('同 revision 並行動作只接受一個；跨身分不能讀取或操作', async () => {
    const c = await client();
    const game = await c.create({ kind: 'B-honest', answer: '9876' });
    const results = await Promise.all([c.act(game, { type: 'next' }), c.act(game, { type: 'next' })]);
    expect(results.map(result => result.response.status).sort()).toEqual([200, 409]);
    expect(success((await c.request(`/api/solo/${game.id}`)).payload).steps).toBe(1);
    const other = await client();
    expect((await other.request(`/api/solo/${game.id}`)).response.status).toBe(404);
    expect((await other.act(game, { type: 'next' })).response.status).toBe(404);
  });

  it('SQLite 單列＋630-byte bitset，一次有效 UPDATE 的 rowsWritten=1；不額外建立逐手資料列', async () => {
    const c = await client();
    let game = await c.create({ kind: 'B-honest', answer: '9876' });
    const alarmBefore = await runInDurableObject(env.SOLO_GAMES.getByName(game.id), (_instance, ctx) => ctx.storage.getAlarm());
    game = success((await c.act(game, { type: 'next' })).payload);
    await runInDurableObject(env.SOLO_GAMES.getByName(game.id), async (instance, ctx) => {
      const repository = new SoloRepository(ctx.storage.sql);
      const record = repository.read()!;
      expect(record.candidates).toBeInstanceOf(CandidateSet);
      expect(ctx.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM solo_game').one().count).toBe(1);
      expect(record.state).not.toHaveProperty('candidates');
      const sqlSpy = vi.spyOn(ctx.storage.sql, 'exec');
      try {
        const command = { requestId: crypto.randomUUID(), generation: game.generation, expectedRevision: game.revision, type: 'next' };
        const result = await instance.action(record.state.owner, command);
        expect(result.status).toBe(200);
        const mutations = sqlSpy.mock.calls.flatMap(([query], i) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query) ? [i] : []);
        expect(mutations).toHaveLength(1);
        expect(sqlSpy.mock.results[mutations[0]!]!.value.rowsWritten).toBe(1);
        sqlSpy.mockClear();
        expect((await instance.action(record.state.owner, command)).status).toBe(200);
        expect(sqlSpy.mock.calls.filter(([query]) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query))).toHaveLength(0);
      } finally { sqlSpy.mockRestore(); }
    });
    const alarmAfter = await runInDurableObject(env.SOLO_GAMES.getByName(game.id), (_instance, ctx) => ctx.storage.getAlarm());
    expect(alarmAfter).toBe(alarmBefore);
  });

  it('重新建構 DO 從持久資料還原；提前 alarm 重排，到期清除且可再次初始化', async () => {
    const c = await client();
    let game = await c.create({ kind: 'B-honest', answer: '9876' });
    game = success((await c.act(game, { type: 'next' })).payload);
    const originalCreation: Record<string, unknown> = (await stored(game)).state.creation;
    await evictDurableObject(env.SOLO_GAMES.getByName(game.id));
    expect(success((await c.request(`/api/solo/${game.id}`)).payload)).toEqual(game);
    expect(await runDurableObjectAlarm(env.SOLO_GAMES.getByName(game.id))).toBe(true);
    expect((await c.request(`/api/solo/${game.id}`)).response.status).toBe(200);
    await runInDurableObject(env.SOLO_GAMES.getByName(game.id), (_instance, ctx) => {
      const repository = new SoloRepository(ctx.storage.sql);
      const record = repository.read()!;
      record.state.expiresAt = Date.now() - 1;
      repository.write(record);
    });
    expect((await c.request(`/api/solo/${game.id}`)).response.status).toBe(410);
    expect(await runDurableObjectAlarm(env.SOLO_GAMES.getByName(game.id))).toBe(true);
    expect((await c.request(`/api/solo/${game.id}`)).response.status).toBe(404);
    const recreated = await c.request('/api/solo', 'POST', originalCreation);
    expect(recreated.response.status).toBe(201);
    expect(success(recreated.payload).generation).not.toBe(game.generation);
    expect(errorCode((await c.act(game, { type: 'next' })).payload)).toBe('STALE_GENERATION');
  });

  it('模式限制、額外欄位、過大與不合法 JSON 請求被拒絕', async () => {
    const c = await client();
    const game = await c.create({ kind: 'B-honest', answer: '9876' });
    expect((await c.act(game, { type: 'feedback', feedback: { a: 4, b: 0 } })).response.status).toBe(409);
    expect((await c.act(game, { type: 'next', answer: '0123' })).response.status).toBe(400);
    expect((await c.request('/api/solo', 'POST', { requestId: crypto.randomUUID(), kind: 'A', maxGuesses: 0 })).response.status).toBe(400);
    expect((await c.request('/api/solo', 'POST', { data: 'x'.repeat(9000) })).response.status).toBe(413);
    expect((await c.request('/api/solo', 'POST', {}, { 'Content-Type': 'text/plain' })).response.status).toBe(415);
    const malformed = await exports.default.fetch(`${origin}/api/solo`, { method: 'POST', headers: { Origin: origin, Cookie: c.cookie, 'Content-Type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
    expect((await c.request(`/api/solo/${game.id}?answer=0123`)).response.status).toBe(400);
  });

  it('主動結束才揭曉，不能重開舊局；建立限流回 429', async () => {
    const c = await client();
    const game = await c.create({ kind: 'B-honest', answer: '9876' });
    const finished = success((await c.act(game, { type: 'abandon' })).payload);
    expect(finished).toMatchObject({ status: 'finished', outcome: 'abandoned', answer: '9876' });
    expect((await c.act(finished, { type: 'next' })).response.status).toBe(409);
    let limited = false;
    for (let i = 0; i < 20; i++) {
      const result = await c.request('/api/solo', 'POST', { kind: 'B-oral', requestId: crypto.randomUUID() });
      if (result.response.status === 429) { limited = true; expect(result.response.headers.get('retry-after')).toBe('60'); break; }
    }
    expect(limited).toBe(true);
  });
});
