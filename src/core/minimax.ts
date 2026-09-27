import { CandidateSet, codeAt } from './candidates.ts';
import { scoreIdsUnchecked } from './internal/universe.ts';
import type { Code } from './rules.ts';

export interface MinimaxChoice {
  readonly guess: Code;
  readonly worstCase: number;
  readonly comparisons: number;
}

/** Exact candidate-only minimax. Lexicographically first guess wins ties. */
export function chooseMinimax(candidates: CandidateSet): MinimaxChoice {
  if (candidates.size === 0) throw new RangeError('候選集合為空，不能提出猜測。');
  const ids = candidates.ids();
  const bins = new Uint16Array(25);
  let bestId = ids[0]!;
  let bestWorst = Number.POSITIVE_INFINITY;
  let comparisons = 0;

  for (const guessId of ids) {
    bins.fill(0);
    let worst = 0;
    for (const answerId of ids) {
      const bucket = scoreIdsUnchecked(answerId, guessId);
      const count = bins[bucket]! + 1;
      bins[bucket] = count;
      comparisons++;
      if (count > worst) worst = count;
      // IDs are lexical: a later guess tied with the best cannot replace it.
      // A bucket never shrinks, so this pruning preserves exact minimax.
      if (worst >= bestWorst) break;
    }
    if (worst < bestWorst) {
      bestId = guessId;
      bestWorst = worst;
    }
  }

  return Object.freeze({ guess: codeAt(bestId), worstCase: bestWorst, comparisons });
}
