import type { Code } from '../../core/rules.ts';
import type { MatchResult, MatchView, Seat } from '../../protocol/room.ts';

export interface GameState {
  phase: 'setup' | 'playing' | 'finished'; round: number; deadline: number | null;
  result: MatchResult | null; data: unknown;
}
export interface GameContext {
  now: number; randomAnswer: () => Code; randomSeat: () => Seat;
  connected: [boolean, boolean]; revealOpponentHistory: boolean;
}
export type GameAction = { type: 'set-answer'; answer: Code; round: number }
  | { type: 'guess'; guess: Code; round: number } | { type: 'leave' };
export interface GameStrategy {
  start(previous: GameState | null, context: GameContext): GameState;
  act(state: GameState, seat: Seat, action: GameAction, context: GameContext): GameState;
  presence(state: GameState, seat: Seat, connected: boolean, context: GameContext): GameState;
  expire(state: GameState, context: GameContext): GameState;
  project(state: GameState, seat: Seat, context: GameContext): MatchView;
}
export const other = (seat: Seat): Seat => seat === 0 ? 1 : 0;
