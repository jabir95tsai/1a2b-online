import { CandidateSet } from '../../core/candidates.ts';
import { applyFeedback, createSolver } from '../../core/solver.ts';
import type { SolverState } from '../../core/solver.ts';
import { score } from '../../core/rules.ts';
import type { Code, Feedback } from '../../core/rules.ts';
import type { SoloView } from '../../protocol/solo.ts';
import { ApiError } from '../errors.ts';
import type { Creation, SoloCommand } from '../validation.ts';

export const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
export const FINISHED_TTL_MS = 30 * 60 * 1000;
interface Base {
  schemaVersion: 1;
  id: string;
  generation: string;
  owner: string;
  revision: number;
  createdAt: number;
  expiresAt: number;
  creation: Creation;
  status: 'active' | 'finished';
  outcome: SoloView['outcome'];
  receipts: { id: string; command: string }[];
}
interface PlayerGame extends Base {
  kind: 'A'; answer: Code; maxGuesses: number | null;
  history: { guess: Code; feedback: Feedback }[];
}
interface ComputerGame extends Base {
  kind: 'B-honest' | 'B-oral'; answer: Code | null;
  solver: Omit<SolverState, 'candidates'>;
}
export type SoloState = PlayerGame | ComputerGame;
export interface SoloRecord { state: SoloState; candidates: CandidateSet }

export function initializeSolo(id: string, owner: string, creation: Creation,
  answer: Code, generation: string, now: number): SoloRecord {
  const base: Base = { schemaVersion: 1, id, owner, generation, revision: 0, createdAt: now,
    expiresAt: now + IDLE_TTL_MS, creation, status: 'active', outcome: null, receipts: [] };
  if (creation.kind === 'A') {
    return { state: { ...base, kind: 'A', answer, maxGuesses: creation.maxGuesses, history: [] }, candidates: CandidateSet.empty() };
  }
  const { candidates, ...solver } = createSolver();
  return { state: { ...base, kind: creation.kind, answer: creation.kind === 'B-honest' ? creation.answer : null, solver }, candidates };
}

function applyOrThrow(solver: SolverState, feedback: Feedback): SolverState {
  const result = applyFeedback(solver, feedback);
  if (!result.ok) throw new ApiError(422, 'CONTRADICTORY_FEEDBACK', '此回饋與先前紀錄矛盾，請檢查標示的回合。', {
    turns: result.diagnosis.turns, irreducible: result.diagnosis.irreducible,
  });
  return result.state;
}

/** Pure transition; persistence/ownership/version checks belong to the DO boundary. */
export function transitionSolo(record: SoloRecord, command: SoloCommand, now: number): SoloRecord {
  const { state } = record;
  if (state.status === 'finished') throw new ApiError(409, 'GAME_FINISHED', '本局已結束。');
  let next = state;
  let candidates = record.candidates;
  if (command.type === 'abandon') {
    next = { ...state, status: 'finished', outcome: 'abandoned' };
  } else if (state.kind === 'A') {
    if (command.type !== 'guess') throw new ApiError(409, 'WRONG_MODE', '此模式只接受玩家猜測。');
    const feedback = score(state.answer, command.guess);
    const history = [...state.history, { guess: command.guess, feedback }];
    const won = feedback.a === 4;
    const lost = !won && state.maxGuesses !== null && history.length >= state.maxGuesses;
    next = { ...state, history, status: won || lost ? 'finished' : 'active', outcome: won ? 'won' : lost ? 'lost' : null };
  } else {
    let solver: SolverState = { ...state.solver, candidates };
    if (state.kind === 'B-honest') {
      if (command.type !== 'next') throw new ApiError(409, 'WRONG_MODE', '誠實模式由伺服端自動回饋。');
      solver = applyOrThrow(solver, score(state.answer, solver.pendingGuess));
    } else if (command.type === 'feedback') {
      solver = applyOrThrow(solver, command.feedback);
    } else if (command.type === 'correct') {
      if (command.turn > state.solver.history.length) throw new ApiError(400, 'INVALID_TURN', '要修正的回合不存在。');
      solver = createSolver();
      for (const step of state.solver.history.slice(0, command.turn - 1)) solver = applyOrThrow(solver, step.feedback);
      solver = applyOrThrow(solver, command.feedback);
      // Later history is intentionally discarded; all downstream guesses are recomputed.
    } else {
      throw new ApiError(409, 'WRONG_MODE', '口述模式需要回饋或修正回饋。');
    }
    const { candidates: updated, ...stored } = solver;
    candidates = updated;
    next = { ...state, solver: stored, status: solver.status === 'solved' ? 'finished' : 'active', outcome: solver.status === 'solved' ? 'solved' : null };
  }
  next = { ...next, revision: state.revision + 1,
    expiresAt: now + (next.status === 'finished' ? FINISHED_TTL_MS : IDLE_TTL_MS),
    receipts: [...(command.type === 'abandon' ? [] : state.receipts),
      { id: command.requestId, command: JSON.stringify(command) }].slice(-64) };
  return { state: next, candidates };
}

export function projectSolo({ state, candidates }: SoloRecord): SoloView {
  const history = state.kind === 'A'
    ? state.history.map(step => ({ guess: step.guess, feedback: { a: step.feedback.a, b: step.feedback.b } }))
    : state.solver.history.map(step => ({ guess: step.guess, feedback: { a: step.feedback.a, b: step.feedback.b },
      candidatesBefore: step.candidatesBefore, candidatesAfter: step.candidatesAfter }));
  const view: SoloView = {
    id: state.id, generation: state.generation, revision: state.revision, kind: state.kind,
    status: state.status, outcome: state.outcome, expiresAt: state.expiresAt, steps: history.length, history,
    maxGuesses: state.kind === 'A' ? state.maxGuesses : null,
    pendingGuess: state.kind !== 'A' && state.status === 'active' ? state.solver.pendingGuess : null,
    candidateCount: state.kind === 'A' ? null : candidates.size,
  };
  if (state.status === 'finished') {
    const answer = state.answer ?? (state.kind === 'B-oral' && state.outcome === 'solved' ? state.solver.history.at(-1)?.guess : undefined);
    if (answer !== undefined && answer !== null) view.answer = answer;
  }
  return view;
}
