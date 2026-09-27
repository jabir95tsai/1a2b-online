import { parseCode } from '../../core/rules.ts';
import type { RoomKind } from '../../protocol/room.ts';
import { ApiError } from '../errors.ts';
import { object, uuid } from '../validation.ts';
import type { GameAction } from './strategy.ts';

export const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function roomCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(value)) throw new ApiError(400, 'INVALID_ROOM_CODE', '請輸入 8 碼房碼（不含 0、O、1、I、L）。');
  return value;
}
export function onlyKeys(input: Record<string, unknown>, names: string[]): void {
  if (Object.keys(input).some(name => !names.includes(name))) throw new ApiError(400, 'INVALID_REQUEST', '請求含不支援的欄位。');
}
export function roomCreation(value: unknown): { requestId: string; kind: RoomKind } {
  const input = object(value);
  onlyKeys(input, ['requestId', 'kind']);
  if (input.kind !== 'duel' && input.kind !== 'race') throw new ApiError(400, 'INVALID_MODE', '請選擇多人玩法。');
  return { requestId: uuid(input.requestId), kind: input.kind };
}
export type RoomAction = { requestId: string; incarnation: string; gameId: string; connectionEpoch: number }
  & (GameAction | { type: 'rematch'; accept: boolean });
export function roomAction(value: unknown): RoomAction {
  const input = object(value);
  const base = { requestId: uuid(input.requestId), incarnation: uuid(input.incarnation), gameId: uuid(input.gameId), connectionEpoch: input.connectionEpoch };
  if (typeof base.connectionEpoch !== 'number' || !Number.isSafeInteger(base.connectionEpoch) || base.connectionEpoch < 1) throw new ApiError(400, 'INVALID_REQUEST', '連線版本無效。');
  const prefix = ['requestId', 'incarnation', 'gameId', 'connectionEpoch', 'type'];
  const common = { ...base, connectionEpoch: base.connectionEpoch };
  if (input.type === 'leave') { onlyKeys(input, prefix); return { ...common, type: 'leave' }; }
  if (input.type === 'rematch') {
    onlyKeys(input, [...prefix, 'accept']);
    if (typeof input.accept !== 'boolean') throw new ApiError(400, 'INVALID_REQUEST', '再戰意願無效。');
    return { ...common, type: 'rematch', accept: input.accept };
  }
  if (typeof input.round !== 'number' || !Number.isSafeInteger(input.round) || input.round < 0) throw new ApiError(400, 'INVALID_ROUND', '回合格式無效。');
  if (input.type === 'set-answer') {
    onlyKeys(input, [...prefix, 'round', 'answer']);
    return { ...common, type: 'set-answer', answer: parseCode(input.answer), round: input.round };
  }
  if (input.type === 'guess') {
    onlyKeys(input, [...prefix, 'round', 'guess']);
    return { ...common, type: 'guess', guess: parseCode(input.guess), round: input.round };
  }
  throw new ApiError(400, 'INVALID_ACTION', '不支援此動作。');
}
/** HMAC digest bytes are uniform; reject modulo-biased bytes. */
export function codeFromDigest(digest: string): string | null {
  let code = '';
  for (const pair of digest.match(/../g) ?? []) {
    const n = Number.parseInt(pair, 16);
    if (n < 248) code += ROOM_ALPHABET[n % 31];
    if (code.length === 8) return code;
  }
  return null;
}
