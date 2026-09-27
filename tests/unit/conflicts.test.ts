import { describe, expect, it } from 'vitest';
import { candidatesForHistory } from '../../src/core/candidates.ts';
import { diagnoseConflicts } from '../../src/core/conflicts.ts';

describe('矛盾診斷', () => {
  it('一致歷史不誤報', () => {
    expect(diagnoseConflicts([]).contradictory).toBe(false);
    expect(diagnoseConflicts([{ guess: '0123', feedback: { a: 1, b: 2 } }]).contradictory).toBe(false);
  });

  it('找出互斥的兩次回饋並移除無關回饋', () => {
    const history = [
      { guess: '4567', feedback: { a: 0, b: 0 } },
      { guess: '0123', feedback: { a: 4, b: 0 } },
      { guess: '0123', feedback: { a: 0, b: 0 } },
    ];
    const result = diagnoseConflicts(history);
    expect(result.turns).toEqual([2, 3]);
    expect(result.irreducible).toBe(true);
    const core = result.turns.map(turn => history[turn - 1]!);
    expect(candidatesForHistory(core).size).toBe(0);
    for (let i = 0; i < core.length; i++) {
      expect(candidatesForHistory(core.filter((_, index) => index !== i)).size).toBeGreaterThan(0);
    }
  });

  it('能找出不是任意兩條就互斥的三條衝突', () => {
    // Each pair excludes six digits; all three exclude seven (only three remain).
    const history = ['0123', '0145', '0246'].map(guess => ({ guess, feedback: { a: 0, b: 0 } }));
    const result = diagnoseConflicts(history);
    expect(result.contradictory).toBe(true);
    expect(result.irreducible).toBe(true);
    expect(result.turns).toEqual([1, 2, 3]);
    const core = result.turns.map(turn => history[turn - 1]!);
    expect(candidatesForHistory(core).size).toBe(0);
    for (let i = 0; i < core.length; i++) {
      expect(candidatesForHistory(core.filter((_, index) => i !== index)).size).toBeGreaterThan(0);
    }
  });

  it('預算不足仍提供已證明矛盾的集合，不虛稱已最小化', () => {
    const history = [
      { guess: '0123', feedback: { a: 4, b: 0 } },
      { guess: '0123', feedback: { a: 0, b: 0 } },
    ];
    const result = diagnoseConflicts(history, 0);
    expect(result).toMatchObject({ contradictory: true, turns: [1, 2], irreducible: false });
    expect(candidatesForHistory(result.turns.map(turn => history[turn - 1]!)).size).toBe(0);
    expect(() => diagnoseConflicts(history, -1)).toThrow();
  });
});
