import { CandidateSet, filterCandidates } from './candidates.ts';
import { diagnoseConflicts } from './conflicts.ts';
import type { ConflictDiagnosis } from './conflicts.ts';
import { chooseMinimax } from './minimax.ts';
import { OPENING_GUESS, SECOND_GUESS_TABLE } from './opening-table.generated.ts';
import { feedbackKey, parseCode, parseFeedback } from './rules.ts';
import type { Code, Feedback } from './rules.ts';

export interface SolverStep {
  readonly guess: Code;
  readonly feedback: Feedback;
  readonly candidatesBefore: number;
  readonly candidatesAfter: number;
}

export interface SolverState {
  readonly status: 'awaiting_feedback' | 'solved';
  readonly candidates: CandidateSet;
  readonly history: readonly SolverStep[];
  readonly pendingGuess: Code | null;
}

export type FeedbackResult = Readonly<{
  ok: true;
  state: SolverState;
}> | Readonly<{
  ok: false;
  code: 'CONTRADICTORY_FEEDBACK';
  state: SolverState;
  diagnosis: ConflictDiagnosis;
}>;

/** Server-private state. It must never be used as an API response DTO. */
export function createSolver(): SolverState {
  return Object.freeze({
    status: 'awaiting_feedback',
    candidates: CandidateSet.all(),
    history: Object.freeze([]),
    pendingGuess: parseCode(OPENING_GUESS),
  });
}

export function applyFeedback(state: SolverState, value: unknown): FeedbackResult {
  const feedback = parseFeedback(value);
  if (state.status === 'solved' || state.pendingGuess === null) {
    throw new Error('SOLVER_FINISHED');
  }
  const guess = state.pendingGuess;
  const candidates = filterCandidates(state.candidates, guess, feedback);
  if (candidates.size === 0) {
    return Object.freeze({
      ok: false,
      code: 'CONTRADICTORY_FEEDBACK',
      state,
      diagnosis: diagnoseConflicts([...state.history, { guess, feedback }]),
    });
  }
  const history = Object.freeze([...state.history, Object.freeze({
    guess, feedback, candidatesBefore: state.candidates.size, candidatesAfter: candidates.size,
  })]);
  const solved = feedback.a === 4;
  let pendingGuess: Code | null = null;
  if (!solved) {
    if (history.length === 1) {
      const entry = SECOND_GUESS_TABLE[feedbackKey(feedback) as keyof typeof SECOND_GUESS_TABLE];
      if (entry.guess === null) throw new Error('INVALID_OPENING_TABLE');
      pendingGuess = parseCode(entry.guess);
    } else {
      pendingGuess = chooseMinimax(candidates).guess;
    }
  }
  return Object.freeze({
    ok: true,
    state: Object.freeze({ status: solved ? 'solved' : 'awaiting_feedback', candidates, history, pendingGuess }),
  });
}
