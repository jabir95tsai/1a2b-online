import { score } from '../../../core/rules.ts';
import type { Code } from '../../../core/rules.ts';
import type { MatchResult, RoomStep, Seat } from '../../../protocol/room.ts';
import { ApiError } from '../../errors.ts';
import { other } from '../strategy.ts';
import type { GameState, GameStrategy } from '../strategy.ts';

interface DuelData {
  first: Seat; turn: Seat; answers: [Code | null, Code | null];
  histories: [RoomStep[], RoomStep[]]; firstSolved: boolean;
  turnDeadline: number; disconnects: [number | null, number | null];
}
function data(state: GameState): DuelData { return state.data as DuelData; }
function deadline(state: GameState, d: DuelData): GameState {
  return { ...state, data: d, deadline: state.phase === 'finished' ? null
    : Math.min(d.turnDeadline, ...d.disconnects.filter((n): n is number => n !== null)) };
}
function finish(state: GameState, result: MatchResult): GameState {
  return { ...state, phase: 'finished', result, deadline: null };
}
export const duel: GameStrategy = {
  start(previous, ctx) {
    const first = previous ? other(data(previous).first) : ctx.randomSeat();
    return { phase: 'setup', round: 0, result: null, deadline: ctx.now + (ctx.connected.every(Boolean) ? 300_000 : 60_000),
      data: { first, turn: first, answers: [null, null], histories: [[], []], firstSolved: false,
        turnDeadline: ctx.now + 300_000, disconnects: ctx.connected.map(connected => connected ? null : ctx.now + 60_000) as DuelData['disconnects'] } satisfies DuelData };
  },
  act(state, seat, action, ctx) {
    if (state.phase === 'finished') throw new ApiError(409, 'GAME_FINISHED', '本局已結束。');
    if (action.type === 'leave') return finish(state, { winner: state.phase === 'setup' ? null : other(seat), reason: 'abandoned' });
    if (action.round !== state.round) throw new ApiError(409, 'STALE_ROUND', '回合已更新，請重新操作。');
    const d = structuredClone(data(state));
    if (action.type === 'set-answer') {
      if (state.phase !== 'setup' || d.answers[seat] !== null) throw new ApiError(409, 'ANSWER_LOCKED', '答案已鎖定。');
      d.answers[seat] = action.answer;
      if (d.answers.every(answer => answer !== null)) {
        d.turnDeadline = ctx.now + 120_000;
        return deadline({ ...state, phase: 'playing', round: 1 }, d);
      }
      return deadline(state, d);
    }
    if (state.phase !== 'playing') throw new ApiError(409, 'NOT_READY', '等待雙方設定答案。');
    if (d.turn !== seat) throw new ApiError(409, 'NOT_YOUR_TURN', '目前是對手的回合。');
    const feedback = score(d.answers[other(seat)], action.guess);
    d.histories[seat].push({ round: state.round, guess: action.guess, feedback });
    if (seat === d.first) {
      d.firstSolved = feedback.a === 4;
      d.turn = other(seat);
    } else {
      if (feedback.a === 4 || d.firstSolved) return finish({ ...state, data: d }, {
        winner: feedback.a === 4 && d.firstSolved ? null : feedback.a === 4 ? seat : d.first,
        reason: feedback.a === 4 && d.firstSolved ? 'draw' : 'solved',
      });
      d.turn = d.first;
      state = { ...state, round: state.round + 1 };
    }
    d.turnDeadline = ctx.now + 120_000;
    return deadline(state, d);
  },
  presence(state, seat, connected, ctx) {
    if (state.phase === 'finished') return state;
    const d = structuredClone(data(state));
    d.disconnects[seat] = connected ? null : ctx.now + 60_000;
    return deadline(state, d);
  },
  expire(state, ctx) {
    if (state.phase === 'finished' || state.deadline === null || ctx.now < state.deadline) return state;
    const d = data(state);
    if (state.phase === 'setup' || ctx.connected.every(value => !value)) return finish(state, { winner: null, reason: 'cancelled' });
    const absent = ([0, 1] as Seat[]).find(seat => d.disconnects[seat] !== null && d.disconnects[seat]! <= ctx.now);
    return finish(state, { winner: other(absent ?? d.turn), reason: absent === undefined ? 'timeout' : 'disconnect' });
  },
  project(state, seat) {
    const d = data(state);
    return { phase: state.phase, round: state.round, deadline: state.deadline, result: state.result,
      firstPlayer: d.first, turn: state.phase === 'playing' ? d.turn : null,
      answerReady: [d.answers[0] !== null, d.answers[1] !== null],
      canSetAnswer: state.phase === 'setup' && d.answers[seat] === null,
      canGuess: state.phase === 'playing' && d.turn === seat, myPending: null,
      myHistory: d.histories[seat], opponentSteps: d.histories[other(seat)].length,
      opponentHistory: d.histories[other(seat)],
      ...(state.phase === 'finished' ? { answers: d.answers } : {}),
    };
  },
};
