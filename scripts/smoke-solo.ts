import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { SoloSuccess, ErrorView, SoloView } from '../src/protocol/solo.ts';
import { referenceScore } from '../tests/helpers/reference.ts';

const origin = process.env.SOLO_SMOKE_ORIGIN ?? 'http://127.0.0.1:8787';
const target = new URL(origin);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Smoke test 僅允許 loopback，避免意外操作正式環境。');
assert.equal(target.origin, origin);
let cookie = '';
let requests = 0;
const latencies: number[] = [];
async function request(path: string, method = 'GET', value?: unknown) {
  const init: RequestInit = { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } };
  if (value !== undefined) init.body = JSON.stringify(value);
  const start = performance.now();
  const response = await fetch(`${origin}${path}`, init);
  const payload = await response.json() as SoloSuccess | ErrorView;
  latencies.push(performance.now() - start);
  requests++;
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, payload };
}
function game(payload: SoloSuccess | ErrorView): SoloView {
  assert.ok('game' in payload, '預期成功的遊戲回應');
  const view = payload.game;
  for (const field of ['owner', 'creation', 'receipts', 'solver', 'candidates']) assert.ok(!(field in view));
  if (view.status === 'active') assert.ok(!('answer' in view));
  return view;
}
async function act(view: SoloView, action: Record<string, unknown>) {
  return request(`/api/solo/${view.id}/actions`, 'POST', { requestId: crypto.randomUUID(),
    expectedRevision: view.revision, generation: view.generation, ...action });
}

assert.equal((await request('/api/session', 'POST', {})).status, 200);
const answer = '8590';
let honest = game((await request('/api/solo', 'POST', { requestId: crypto.randomUUID(), kind: 'B-honest', answer })).payload);
while (honest.status === 'active') {
  assert.ok(honest.steps < 8);
  const guess = honest.pendingGuess!;
  const next = await act(honest, { type: 'next' });
  assert.equal(next.status, 200);
  honest = game(next.payload);
  assert.deepEqual(honest.history.at(-1)!.feedback, referenceScore(answer, guess));
}
assert.equal(honest.answer, answer);
assert.equal(honest.steps, 8);
assert.equal(honest.outcome, 'solved');

const player = game((await request('/api/solo', 'POST', { requestId: crypto.randomUUID(), kind: 'A', maxGuesses: 1 })).payload);
const playerEnd = game((await act(player, { type: 'guess', guess: '0123' })).payload);
assert.equal(playerEnd.status, 'finished');
assert.equal(playerEnd.steps, 1);
assert.deepEqual(playerEnd.history[0]!.feedback, referenceScore(playerEnd.answer!, '0123'));

let oral = game((await request('/api/solo', 'POST', { requestId: crypto.randomUUID(), kind: 'B-oral' })).payload);
oral = game((await act(oral, { type: 'feedback', feedback: { a: 0, b: 0 } })).payload);
const rejected = await act(oral, { type: 'feedback', feedback: { a: 0, b: 0 } });
assert.equal(rejected.status, 422);
assert.ok('error' in rejected.payload && rejected.payload.error.code === 'CONTRADICTORY_FEEDBACK');
assert.deepEqual(game((await request(`/api/solo/${oral.id}`)).payload), oral);

const output = {
  generatedAt: new Date().toISOString(), transport: 'loopback HTTP → Wrangler/workerd → SQLite Durable Object',
  requests, modeA: 'one-attempt terminal score verified', honestMode: { steps: honest.steps, outcome: honest.outcome },
  oralMode: 'contradiction rejected; persisted public view unchanged',
  privacy: 'no private state fields or premature answer field in checked responses',
  latencyMs: { max: Math.max(...latencies), mean: latencies.reduce((a, b) => a + b, 0) / latencies.length },
  note: 'Local HTTP only; no Cloudflare deployment or browser UI. Cookie, player ID and game IDs intentionally omitted.',
};
const directory = new URL('../reports/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('solo-http-smoke.json', directory), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
