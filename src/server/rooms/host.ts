import type { RoomKind, RoomView, Seat } from '../../protocol/room.ts';
import type { GameContext, GameState } from './strategy.ts';
import { strategyFor } from './registry.ts';
import { randomAnswer } from '../random.ts';
import { ApiError } from '../errors.ts';

export interface Player { owner: string; epoch: number; connected: boolean; rematch: boolean }
export interface RoomState {
  schemaVersion: 1; code: string; incarnation: string; kind: RoomKind; revision: number;
  creationRequestId: string; inviteHash: string; revealOpponentHistory: boolean;
  life: 'waiting' | 'active' | 'retained' | 'expired'; gameId: string; matchNumber: number;
  players: [Player, Player | null]; game: GameState | null;
  expiresAt: number; emptyDeadline: number | null; alarmAt: number | null;
  receipts: { owner: string; id: string; command: string }[];
}
export function seatOf(room: RoomState, owner: string): Seat {
  const seat = room.players.findIndex(player => player?.owner === owner);
  if (seat < 0) throw new ApiError(404, 'ROOM_NOT_FOUND', '找不到此房間或尚未加入。');
  return seat as Seat;
}
export function context(room: RoomState, now: number): GameContext {
  return { now, randomAnswer, randomSeat: () => (crypto.getRandomValues(new Uint8Array(1))[0]! & 1) as Seat,
    connected: [room.players[0].connected, room.players[1]?.connected ?? false], revealOpponentHistory: room.revealOpponentHistory };
}
export function startMatch(room: RoomState, now: number): void {
  room.game = strategyFor(room.kind).start(room.game, context(room, now));
  room.life = 'active';
  room.gameId = crypto.randomUUID();
  for (const player of room.players) if (player) player.rematch = false;
}
export function settleLifecycle(room: RoomState, now: number): void {
  if (room.life === 'active' && room.game?.phase === 'finished') {
    room.life = 'retained';
    room.expiresAt = now + 30 * 60_000;
  }
}
/** Lifecycle host knows only strategy envelope/deadlines, never gameplay rules. */
export function advanceRoom(source: RoomState, now: number): RoomState {
  const room = structuredClone(source);
  if (((room.life === 'waiting' || room.life === 'retained') && room.expiresAt <= now)
    || (room.emptyDeadline !== null && room.emptyDeadline <= now)) {
    room.life = 'expired'; room.game = null;
  }
  if (room.life === 'active' && room.game) {
    room.game = strategyFor(room.kind).expire(room.game, context(room, now));
    settleLifecycle(room, now);
  }
  return room;
}
export function nextDeadline(room: RoomState, now: number): number {
  if (room.life === 'expired') return now + 1000;
  const deadlines: number[] = [];
  if (room.life === 'waiting' || room.life === 'retained') deadlines.push(room.expiresAt);
  if (room.emptyDeadline !== null) deadlines.push(room.emptyDeadline);
  if (room.life === 'active' && room.game?.deadline !== null && room.game?.deadline !== undefined) deadlines.push(room.game.deadline);
  return Math.min(...deadlines);
}
export function projectRoom(room: RoomState, owner: string, now: number): RoomView {
  const seat = seatOf(room, owner);
  return { code: room.code, incarnation: room.incarnation, revision: room.revision, kind: room.kind,
    life: room.life, gameId: room.gameId, matchNumber: room.matchNumber, you: seat,
    connectionEpoch: room.players[seat]!.epoch, revealOpponentHistory: room.revealOpponentHistory,
    players: room.players.map(player => player ? { connected: player.connected, rematch: player.rematch } : null) as RoomView['players'],
    expiresAt: room.expiresAt, game: room.game && room.life !== 'expired' ? strategyFor(room.kind).project(room.game, seat, context(room, now)) : null };
}
