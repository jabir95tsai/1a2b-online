import { score } from '../../../core/rules.ts';
import type { Code } from '../../../core/rules.ts';
import type { MatchResult, RoomStep, Seat } from '../../../protocol/room.ts';
import { ApiError } from '../../errors.ts';
import { other } from '../strategy.ts';
import type { GameState, GameStrategy } from '../strategy.ts';

interface RaceData { answer: Code; pending: [Code | null, Code | null]; histories: [RoomStep[], RoomStep[]] }
function data(state: GameState): RaceData { return state.data as RaceData; }
function finish(state: GameState, result: MatchResult): GameState {
  const d = structuredClone(data(state));
  for (const seat of [0, 1] as Seat[]) {
    const guess = d.pending[seat];
    if (guess !== null) d.histories[seat].push({ round: state.round, guess, feedback: score(d.answer, guess), incomplete: true });
  }
  d.pending = [null, null];
  return { ...state, data: d, phase: 'finished', result, deadline: null };
}
export const race: GameStrategy = {
  start(_previous, ctx) {
    return { phase: 'playing', round: 1, deadline: ctx.now + 60_000, result: null,
      data: { answer: ctx.randomAnswer(), pending: [null, null], histories: [[], []] } satisfies RaceData };
  },
  act(state, seat, action, ctx) {
    if (state.phase === 'finished') throw new ApiError(409, 'GAME_FINISHED', '本局已結束。');
    if (action.type === 'leave') return finish(state, { winner: other(seat), reason: 'abandoned' });
    if (action.type !== 'guess') throw new ApiError(409, 'WRONG_MODE', '同步競速由系統出題。');
    if (action.round !== state.round) throw new ApiError(409, 'STALE_ROUND', '回合已更新，請重新操作。');
    const d = structuredClone(data(state));
    if (d.pending[seat] !== null) throw new ApiError(409, 'GUESS_LOCKED', '本回合已送出，請等待揭曉。');
    d.pending[seat] = action.guess;
    if (d.pending[0] === null || d.pending[1] === null) return { ...state, data: d };
    const results = [score(d.answer, d.pending[0]), score(d.answer, d.pending[1])];
    for (const player of [0, 1] as Seat[]) d.histories[player].push({ round: state.round, guess: d.pending[player]!, feedback: results[player]! });
    d.pending = [null, null];
    if (results.some(result => result.a === 4)) return finish({ ...state, data: d }, {
      winner: results.every(result => result.a === 4) ? null : results[0]!.a === 4 ? 0 : 1,
      reason: results.every(result => result.a === 4) ? 'draw' : 'solved',
    });
    return { ...state, data: d, round: state.round + 1, deadline: ctx.now + 60_000 };
  },
  presence(state) { return state; },
  expire(state, ctx) {
    if (state.phase === 'finished' || state.deadline === null || ctx.now < state.deadline) return state;
    const pending = data(state).pending;
    return finish(state, { winner: pending[0] !== null ? 0 : pending[1] !== null ? 1 : null,
      reason: pending.every(guess => guess === null) ? 'cancelled' : 'timeout' });
  },
  project(state, seat, ctx) {
    const d = data(state);
    return { phase: state.phase, round: state.round, deadline: state.deadline, result: state.result,
      firstPlayer: null, turn: null, answerReady: [true, true], canSetAnswer: false,
      canGuess: state.phase === 'playing' && d.pending[seat] === null,
      myPending: d.pending[seat], myHistory: d.histories[seat], opponentSteps: d.histories[other(seat)].length + (d.pending[other(seat)] === null ? 0 : 1),
      ...(state.phase === 'finished' || ctx.revealOpponentHistory ? { opponentHistory: d.histories[other(seat)] } : {}),
      ...(state.phase === 'finished' ? { answers: [d.answer, d.answer] as [Code, Code] } : {}),
    };
  },
};
