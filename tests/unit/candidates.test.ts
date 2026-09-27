import { describe, expect, it } from 'vitest';
import { ALL_CODES, CANDIDATE_BYTES, CandidateSet, candidatesForHistory, codeAt, codeId, filterCandidates } from '../../src/core/candidates.ts';
import { score } from '../../src/core/rules.ts';
import { referenceScore } from '../helpers/reference.ts';

describe('候選 bitset', () => {
  it('630-byte BLOB 無損保存所有 5040 個索引', () => {
    const all = CandidateSet.all();
    expect(CANDIDATE_BYTES).toBe(630);
    expect(all.size).toBe(5040);
    expect(CandidateSet.fromBytes(all.toBytes().buffer).equals(all)).toBe(true);
    const edges = [0, 7, 8, 31, 32, 5039];
    const subset = CandidateSet.fromIds(edges);
    expect(subset.ids()).toEqual(edges);
    expect(CandidateSet.fromBytes(subset.toBytes()).ids()).toEqual(edges);
    expect(subset.intersect(all).equals(subset)).toBe(true);
    expect(subset.intersect(CandidateSet.empty()).size).toBe(0);
    expect(CandidateSet.fromIds([8, 8]).size).toBe(1);
  });

  it('不洩漏可變底層 buffer', () => {
    const source = new Uint8Array(630).fill(255);
    const set = CandidateSet.fromBytes(source);
    source.fill(0);
    set.toBytes().fill(0);
    set.ids().length = 0;
    expect(set.size).toBe(5040);
    expect(set.has(5039)).toBe(true);
    expect(set.toBytes()[0]).toBe(255);
  });

  it('拒絕錯誤 BLOB 長度及索引', () => {
    for (const size of [0, 629, 631, 632]) {
      expect(() => CandidateSet.fromBytes(new Uint8Array(size))).toThrow();
    }
    for (const id of [-1, 5040, 1.5, NaN, Infinity]) {
      expect(() => CandidateSet.fromIds([id])).toThrow();
      expect(() => CandidateSet.all().has(id)).toThrow();
      expect(() => codeAt(id)).toThrow();
    }
  });

  it('完整歷史交集與獨立逐條評分相同', () => {
    const history = ['0123', '4567', '8901'].map(guess => ({ guess, feedback: score('9870', guess) }));
    const expected = ALL_CODES.filter(answer => history.every(({ guess, feedback }) => {
      const result = referenceScore(answer, guess);
      return result.a === feedback.a && result.b === feedback.b;
    }));
    const actual = candidatesForHistory(history);
    expect(actual.ids().map(codeAt)).toEqual(expected);
    expect(actual.has(codeId('9870'))).toBe(true);
    expect(candidatesForHistory([]).size).toBe(5040);
  });

  it('保留舊集合且非法回饋不被當成空集合', () => {
    const original = CandidateSet.all();
    const filtered = filterCandidates(original, '0123', { a: 4, b: 0 });
    expect(filtered.ids().map(codeAt)).toEqual(['0123']);
    expect(original.size).toBe(5040);
    expect(() => filterCandidates(original, '0123', { a: 3, b: 1 })).toThrow();
    expect(() => candidatesForHistory([
      { guess: '0123', feedback: { a: 4, b: 0 } },
      { guess: '0123', feedback: { a: 0, b: 0 } },
      { guess: 'invalid', feedback: { a: 0, b: 0 } },
    ])).toThrow();
  });
});
