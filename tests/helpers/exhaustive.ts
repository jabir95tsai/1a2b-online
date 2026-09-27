import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ALL_CODES, CandidateSet, candidatesForHistory, codeAt, codeId, filterCandidates } from '../../src/core/candidates.ts';
import { chooseMinimax } from '../../src/core/minimax.ts';
import { VALID_FEEDBACKS } from '../../src/core/rules.ts';
import { applyFeedback, createSolver } from '../../src/core/solver.ts';
import { referenceScore } from './reference.ts';

export interface SolutionTrace {
  answer: string;
  steps: number;
  guesses: string[];
  candidateCounts: number[];
}

export interface AuditResult {
  answers: number;
  failures: number;
  totalGuesses: number;
  averageSteps: number;
  worstSteps: number;
  worstStepExamples: string[];
  stepDistribution: Record<string, number>;
  maxCandidatesAfterFirst: number;
  maxCandidatesAfterSecond: number;
  decisionNodes: number;
  fullRunMs: number;
  feedbackTransitionMs: { calls: number; p50: number; p95: number; p99: number; max: number };
  exactMinimaxThirdOnwardMs: { calls: number; p50: number; p95: number; p99: number; max: number };
  traces: SolutionTrace[];
}

function timings(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return { calls: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? 0 };
}

/** Replays every secret separately, without memoizing solver decisions between games. */
export function auditAllAnswers(): AuditResult {
  const started = performance.now();
  const traces: SolutionTrace[] = [];
  const transitionTimes: number[] = [];
  const minimaxTimes: number[] = [];
  const stepDistribution: Record<string, number> = {};
  const decisionNodes = new Set<string>();
  let maxCandidatesAfterFirst = 0;
  let maxCandidatesAfterSecond = 0;
  let totalGuesses = 0;
  let worstSteps = 0;

  for (const answer of ALL_CODES) {
    let state = createSolver();
    const guesses = new Set<string>();
    const candidateCounts = [state.candidates.size];
    while (state.status !== 'solved') {
      // A candidate-only non-win must shrink the set, so 5040 is a proven safety cap.
      assert.ok(guesses.size < ALL_CODES.length, `non-termination: ${answer}`);
      const guess = state.pendingGuess;
      assert.ok(guess !== null);
      assert.ok(!guesses.has(guess), `repeated guess: ${answer}/${guess}`);
      assert.ok(state.candidates.has(codeId(guess)));
      guesses.add(guess);

      decisionNodes.add(JSON.stringify(state.history.map(step => [step.guess, step.feedback.a, step.feedback.b])));
      const feedback = referenceScore(answer, guess);
      const oldSize = state.candidates.size;
      const transitionStart = performance.now();
      const result = applyFeedback(state, feedback);
      transitionTimes.push(performance.now() - transitionStart);
      assert.ok(result.ok, `honest feedback rejected: ${answer}/${guess}`);
      state = result.state;
      assert.ok(state.candidates.has(codeId(answer)), `true answer removed: ${answer}`);
      assert.ok(state.candidates.equals(candidatesForHistory(state.history)), `history/bitset divergence: ${answer}`);
      candidateCounts.push(state.candidates.size);
      if (state.history.length === 1) maxCandidatesAfterFirst = Math.max(maxCandidatesAfterFirst, state.candidates.size);
      if (state.history.length === 2) maxCandidatesAfterSecond = Math.max(maxCandidatesAfterSecond, state.candidates.size);
      if (feedback.a !== 4) assert.ok(state.candidates.size < oldSize, `no progress: ${answer}/${guess}`);
      if (state.status !== 'solved' && state.history.length >= 2) {
        // Measure the actual exact selector separately from filtering/history allocation.
        const selectStart = performance.now();
        const selected = chooseMinimax(state.candidates);
        minimaxTimes.push(performance.now() - selectStart);
        assert.equal(selected.guess, state.pendingGuess);
      }
    }
    assert.equal(state.history.at(-1)!.guess, answer);
    assert.deepEqual(state.history.at(-1)!.feedback, { a: 4, b: 0 });
    assert.equal(state.candidates.size, 1);
    assert.equal(state.pendingGuess, null);
    const steps = state.history.length;
    totalGuesses += steps;
    worstSteps = Math.max(worstSteps, steps);
    stepDistribution[steps] = (stepDistribution[steps] ?? 0) + 1;
    traces.push({ answer, steps, guesses: [...guesses], candidateCounts });
  }

  return {
    answers: traces.length,
    failures: 0, // Any invariant failure throws above and prevents a successful report.
    totalGuesses,
    averageSteps: totalGuesses / traces.length,
    worstSteps,
    worstStepExamples: traces.filter(trace => trace.steps === worstSteps).slice(0, 12).map(trace => trace.answer),
    stepDistribution,
    maxCandidatesAfterFirst,
    maxCandidatesAfterSecond,
    decisionNodes: decisionNodes.size,
    fullRunMs: performance.now() - started,
    feedbackTransitionMs: timings(transitionTimes),
    exactMinimaxThirdOnwardMs: timings(minimaxTimes),
    traces,
  };
}

/** Every consistent oral-feedback path belongs to at least one enumerated answer. */
export function auditDecisionTree(): { terminalAnswers: number; branches: number } {
  const leaves = new Set<string>();
  let branches = 0;
  function visit(state: ReturnType<typeof createSolver>): void {
    assert.ok(state.pendingGuess !== null);
    for (const feedback of VALID_FEEDBACKS) {
      const subset = filterCandidates(state.candidates, state.pendingGuess, feedback);
      const result = applyFeedback(state, feedback);
      branches++;
      if (subset.size === 0) {
        assert.equal(result.ok, false);
        assert.equal(result.state, state);
        continue;
      }
      assert.ok(result.ok);
      assert.ok(result.state.candidates.equals(subset));
      if (feedback.a === 4) {
        assert.equal(result.state.status, 'solved');
        const answer = codeAt(subset.ids()[0]!);
        assert.ok(!leaves.has(answer));
        leaves.add(answer);
      } else {
        assert.ok(subset.size < state.candidates.size);
        visit(result.state);
      }
    }
  }
  assert.equal(CandidateSet.all().size, 5040);
  visit(createSolver());
  assert.equal(leaves.size, 5040);
  return { terminalAnswers: leaves.size, branches };
}
