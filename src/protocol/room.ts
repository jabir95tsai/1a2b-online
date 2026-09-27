export type Seat = 0 | 1;
export type RoomKind = 'duel' | 'race';
export interface RoomStep { round: number; guess: string; feedback: { a: number; b: number }; incomplete?: boolean }
export interface MatchResult { winner: Seat | null; reason: 'solved' | 'draw' | 'timeout' | 'disconnect' | 'abandoned' | 'cancelled' }
export interface MatchView {
  phase: 'setup' | 'playing' | 'finished';
  round: number;
  deadline: number | null;
  result: MatchResult | null;
  firstPlayer: Seat | null;
  turn: Seat | null;
  answerReady: [boolean, boolean];
  canSetAnswer: boolean;
  canGuess: boolean;
  myPending: string | null;
  myHistory: RoomStep[];
  opponentSteps: number;
  opponentHistory?: RoomStep[];
  answers?: [string | null, string | null];
}
export interface RoomView {
  code: string; incarnation: string; revision: number; kind: RoomKind;
  life: 'waiting' | 'active' | 'retained' | 'expired';
  gameId: string; matchNumber: number; you: Seat; connectionEpoch: number;
  revealOpponentHistory: boolean;
  players: [null | { connected: boolean; rematch: boolean }, null | { connected: boolean; rematch: boolean }];
  expiresAt: number; game: MatchView | null;
}
export type RoomMessage = { type: 'room'; room: RoomView }
  | { type: 'replaced' } | { type: 'expired' }
  | { type: 'error'; error: { code: string; message: string } };
