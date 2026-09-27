import { describe, expect, it } from 'vitest';
import { CandidateSet, codeAt, codeId, filterCandidates } from '../../src/core/candidates.ts';
import { chooseMinimax } from '../../src/core/minimax.ts';
import { SECOND_GUESS_TABLE } from '../../src/core/opening-table.generated.ts';
import { VALID_FEEDBACKS, feedbackKey } from '../../src/core/rules.ts';
import { referenceMinimax } from '../helpers/reference.ts';

describe('完整 minimax 與第二手表', () => {
  it('所有首手分支的靜態表符合即時 exact minimax', () => {
    expect(Object.keys(SECOND_GUESS_TABLE)).toHaveLength(14);
    for (const feedback of VALID_FEEDBACKS) {
      const key = feedbackKey(feedback) as keyof typeof SECOND_GUESS_TABLE;
      const candidates = filterCandidates(CandidateSet.all(), '0123', feedback);
      const entry = SECOND_GUESS_TABLE[key];
      expect(entry.candidates).toBe(candidates.size);
      if (feedback.a === 4) {
        expect(entry.guess).toBeNull();
        expect(entry.worstCase).toBe(0);
      } else {
        const result = chooseMinimax(candidates);
        expect(result.guess).toBe(entry.guess);
        expect(result.worstCase).toBe(entry.worstCase);
        expect(candidates.has(codeId(result.guess))).toBe(true);
      }
    }
  });

  it('剪枝與平手決策符合獨立、不剪枝的暴力 oracle', () => {
    // Diverse subsets, including ties, singleton, and every opening branch <= 96.
    const sets = [
      CandidateSet.fromIds([codeId('9876')]),
      CandidateSet.fromIds([codeId('4567'), codeId('0123')]),
      CandidateSet.fromIds([0, 7, 31, 47, 128, 5039]),
      ...VALID_FEEDBACKS.map(f => filterCandidates(CandidateSet.all(), '0123', f))
        .filter(set => set.size <= 96),
      ...Array.from({ length: 8 }, (_, offset) =>
        CandidateSet.fromIds(Array.from({ length: 40 }, (_, i) => (i * 113 + offset * 53) % 5040))),
    ];
    for (const set of sets) {
      const expected = referenceMinimax(set.ids().map(codeAt));
      const result = chooseMinimax(set);
      expect({ guess: result.guess, worstCase: result.worstCase }).toEqual(expected);
    }
  });

  it('候選為空拒絕猜測，兩個平手選字典序小者', () => {
    expect(() => chooseMinimax(CandidateSet.empty())).toThrow();
    expect(chooseMinimax(CandidateSet.fromIds([codeId('4567'), codeId('0123')])).guess).toBe('0123');
  });
});
