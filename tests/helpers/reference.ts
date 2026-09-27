import type { Feedback } from '../../src/core/rules.ts';

/** Independent oracle: no production masks, universe IDs, or score helper. */
export function referenceScore(answer: string, guess: string): Feedback {
  let a = 0;
  let b = 0;
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === answer[i]) {
      a++;
    } else {
      for (let j = 0; j < answer.length; j++) {
        if (i !== j && guess[i] === answer[j]) b++;
      }
    }
  }
  return { a, b };
}

export function referenceMinimax(candidates: readonly string[]): { guess: string; worstCase: number } {
  let best = { guess: '', worstCase: Infinity };
  for (const guess of [...candidates].sort()) {
    const counts = new Map<string, number>();
    for (const answer of candidates) {
      const result = referenceScore(answer, guess);
      const key = `${result.a},${result.b}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const worstCase = Math.max(...counts.values());
    if (worstCase < best.worstCase) best = { guess, worstCase };
  }
  return best;
}
