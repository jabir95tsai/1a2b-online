import { describe, expect, it } from 'vitest';
import { ALL_CODES, codeId } from '../../src/core/candidates.ts';
import { scoreIdsUnchecked } from '../../src/core/internal/universe.ts';
import { VALID_FEEDBACKS, feedbackKey, parseCode, parseFeedback, score } from '../../src/core/rules.ts';
import { referenceScore } from '../helpers/reference.ts';

describe('共用規則', () => {
  it('完整且唯一的 5040 組、字典序、前導 0', () => {
    expect(ALL_CODES).toHaveLength(5040);
    expect(new Set(ALL_CODES).size).toBe(5040);
    expect([...ALL_CODES].sort()).toEqual(ALL_CODES);
    expect(ALL_CODES[0]).toBe('0123');
    expect(ALL_CODES.at(-1)).toBe('9876');
    for (const code of ALL_CODES) expect(parseCode(code)).toBe(code);
  });

  it.each([
    '', '123', '01234', '1123', '0000', 'abcd', '12a3', ' 0123', '0123 ', '01 2',
    '０１２３', '0１23', '0123\n', '0123\r\n', '\t0123', '01\u200b23',
    '١٢٣٤', 1234, 123, null, undefined, ['0', '1', '2', '3'], { toString: () => '0123' },
  ])('拒絕非法輸入 %j', value => {
    expect(() => parseCode(value)).toThrow();
    expect(() => score('0123', value)).toThrow();
    expect(() => score(value, '0123')).toThrow();
  });

  it.each([
    { a: -1, b: 2 }, { a: 2, b: -1 }, { a: 2.5, b: 0 }, { a: 0, b: 1.5 },
    { a: 3, b: 2 }, { a: 5, b: 0 }, { a: 3, b: 1 }, { a: 4, b: 1 },
    { a: '1', b: 2 }, { a: 1, b: '2' }, { a: NaN, b: 0 }, { a: 0, b: Infinity },
    { a: null, b: 0 }, { a: true, b: 0 }, {}, null, undefined, '1A2B', [1, 2],
  ])('拒絕非法回饋 %j', value => expect(() => parseFeedback(value)).toThrow());

  it('恰有 14 種可能回饋，包含終止項目', () => {
    const encountered = new Set(ALL_CODES.map(code => feedbackKey(score(code, '0123'))));
    expect([...encountered].sort()).toEqual(VALID_FEEDBACKS.map(feedbackKey).sort());
    expect(encountered.size).toBe(14);
    expect(encountered.has('3A1B')).toBe(false);
    expect(encountered.has('4A0B')).toBe(true);
    for (const feedback of VALID_FEEDBACKS) expect(parseFeedback(feedback)).toEqual(feedback);
  });

  it('前導 0、錯位、全中、全錯', () => {
    expect(score('0123', '0123')).toEqual({ a: 4, b: 0 });
    expect(score('0123', '3012')).toEqual({ a: 0, b: 4 });
    expect(score('0123', '0456')).toEqual({ a: 1, b: 0 });
    expect(score('0123', '4567')).toEqual({ a: 0, b: 0 });
    expect(score('0123', '0214')).toEqual({ a: 1, b: 2 });
  });

  it('公開評分與最佳化評分對全答案、多種位置排列符合獨立 oracle', () => {
    const guesses = ['0123', '9876', '3012', '4567', '9071', '8902', '5430', '1023'];
    for (let id = 0; id < ALL_CODES.length; id++) {
      const answer = ALL_CODES[id]!;
      for (const guess of guesses) {
        const reference = referenceScore(answer, guess);
        expect(score(answer, guess)).toEqual(reference);
        expect(scoreIdsUnchecked(id, codeId(guess))).toBe(reference.a * 5 + reference.b);
        expect(score(guess, answer)).toEqual(reference);
      }
    }
  });
});
