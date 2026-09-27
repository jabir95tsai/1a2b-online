import type { RoomKind } from '../../protocol/room.ts';
import type { GameStrategy } from './strategy.ts';
import { duel } from './strategies/duel.ts';
import { race } from './strategies/race.ts';

const strategies: Record<RoomKind, GameStrategy> = { duel, race };
export function strategyFor(kind: RoomKind): GameStrategy { return strategies[kind]; }
