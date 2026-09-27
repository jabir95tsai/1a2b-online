import { CandidateSet, filterCandidates } from './candidates.ts';
import type { Observation } from './candidates.ts';

export interface ConflictDiagnosis {
  readonly contradictory: boolean;
  /** One-based indices, including the proposed feedback when supplied by solver. */
  readonly turns: readonly number[];
  readonly irreducible: boolean;
  readonly intersections: number;
}

/** Diagnose a proven conflict; bounded deletion finds an irreducible, not minimum, core. */
export function diagnoseConflicts(
  history: readonly Observation[],
  maxIntersections = 50_000,
): ConflictDiagnosis {
  if (!Number.isInteger(maxIntersections) || maxIntersections < 0) {
    throw new RangeError('診斷運算上限須為非負整數。');
  }
  const constraints = history.map(({ guess, feedback }) =>
    filterCandidates(CandidateSet.all(), guess, feedback));
  let intersection = CandidateSet.all();
  let intersections = 0;
  for (const constraint of constraints) {
    intersection = intersection.intersect(constraint);
    intersections++;
  }
  if (intersection.size !== 0) {
    return Object.freeze({ contradictory: false, turns: Object.freeze([]), irreducible: false, intersections });
  }

  // The full history is already a proven conflict, even when minimization is budget-limited.
  let core = constraints.map((_, index) => index);
  let remainingBudget = maxIntersections;
  for (const index of [...core]) {
    let without = CandidateSet.all();
    for (const other of core) {
      if (other === index) continue;
      if (remainingBudget === 0) {
        return Object.freeze({
          contradictory: true, turns: Object.freeze(core.map(i => i + 1)), irreducible: false, intersections,
        });
      }
      remainingBudget--;
      intersections++;
      without = without.intersect(constraints[other]!);
      if (without.size === 0) break;
    }
    if (without.size === 0) core = core.filter(i => i !== index);
  }
  return Object.freeze({
    contradictory: true, turns: Object.freeze(core.map(i => i + 1)), irreducible: true, intersections,
  });
}
