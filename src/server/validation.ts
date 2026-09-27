import { parseCode, parseFeedback } from '../core/rules.ts';
import type { Code, Feedback } from '../core/rules.ts';
import { ApiError } from './errors.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type Creation = { requestId: string } & (
  { kind: 'A'; maxGuesses: number | null }
  | { kind: 'B-honest'; answer: Code }
  | { kind: 'B-oral' }
);
export type SoloCommand = { requestId: string; generation: string; expectedRevision: number } & (
  { type: 'guess'; guess: Code }
  | { type: 'next' }
  | { type: 'feedback'; feedback: Feedback }
  | { type: 'correct'; turn: number; feedback: Feedback }
  | { type: 'abandon' }
);
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function invalid(): never { throw new ApiError(400, 'INVALID_REQUEST', '請檢查請求欄位與格式。'); }
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}
export function parseCreation(value: unknown): Creation {
  const input = object(value);
  const requestId = uuid(input.requestId);
  if (input.kind === 'A') {
    keys(input, ['requestId', 'kind', 'maxGuesses']);
    const maxGuesses = input.maxGuesses === undefined ? 10 : input.maxGuesses;
    if (maxGuesses !== null && (typeof maxGuesses !== 'number' || !Number.isSafeInteger(maxGuesses) || maxGuesses < 1)) invalid();
    return { requestId, kind: 'A', maxGuesses };
  }
  if (input.kind === 'B-honest') {
    keys(input, ['requestId', 'kind', 'answer']);
    return { requestId, kind: 'B-honest', answer: parseCode(input.answer) };
  }
  if (input.kind === 'B-oral') {
    keys(input, ['requestId', 'kind']);
    return { requestId, kind: 'B-oral' };
  }
  return invalid();
}
export function parseCommand(value: unknown): SoloCommand {
  const input = object(value);
  const requestId = uuid(input.requestId);
  const generation = uuid(input.generation);
  const expectedRevision = input.expectedRevision;
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid();
  const base = { requestId, generation, expectedRevision };
  const allowed = ['requestId', 'generation', 'expectedRevision', 'type'];
  switch (input.type) {
    case 'guess':
      keys(input, [...allowed, 'guess']);
      return { ...base, type: 'guess', guess: parseCode(input.guess) };
    case 'next': case 'abandon':
      keys(input, allowed);
      return { ...base, type: input.type };
    case 'feedback':
      keys(input, [...allowed, 'feedback']);
      return { ...base, type: 'feedback', feedback: strictFeedback(input.feedback) };
    case 'correct': {
      keys(input, [...allowed, 'turn', 'feedback']);
      const turn = input.turn;
      if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1) invalid();
      return { ...base, type: 'correct', turn, feedback: strictFeedback(input.feedback) };
    }
    default: return invalid();
  }
}
function strictFeedback(value: unknown): Feedback {
  keys(object(value), ['a', 'b']);
  return parseFeedback(value);
}
export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'JSON_REQUIRED', '請使用 application/json。');
  }
  const reader = request.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        throw new ApiError(413, 'REQUEST_TOO_LARGE', '請求不得超過 8 KiB。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { return invalid(); }
}
