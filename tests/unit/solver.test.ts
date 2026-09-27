import { describe, expect, it } from 'vitest';
import { candidatesForHistory } from '../../src/core/candidates.ts';
import { VALID_FEEDBACKS, score } from '../../src/core/rules.ts';
import { applyFeedback, createSolver } from '../../src/core/solver.ts';
import { auditAllAnswers, auditDecisionTree } from '../helpers/exhaustive.ts';

describe('solver 狀態與完整解題', () => {
  it('開局固定，4A0B 一步結束，已結束不能再回饋', () => {
    const initial = createSolver();
    expect(initial.pendingGuess).toBe('0123');
    const result = applyFeedback(initial, { a: 4, b: 0 });
    expect(result.ok).toBe(true);
    expect(result.state.status).toBe('solved');
    expect(result.state.pendingGuess).toBeNull();
    expect(result.state.history).toHaveLength(1);
    expect(result.state.history[0]).toMatchObject({ candidatesBefore: 5040, candidatesAfter: 1 });
    expect(() => applyFeedback(result.state, { a: 4, b: 0 })).toThrow('SOLVER_FINISHED');
    expect(initial.history).toHaveLength(0);
    expect(initial.candidates.size).toBe(5040);
  });

  it('非法回饋不改變歷史與候選，之後仍能提交合法回饋', () => {
    const initial = createSolver();
    for (const invalid of [{ a: 3, b: 1 }, { a: -1, b: 0 }, { a: '0', b: 1 }, { a: 0.5, b: 0 }]) {
      expect(() => applyFeedback(initial, invalid)).toThrow();
      expect(initial.history).toHaveLength(0);
      expect(initial.candidates.size).toBe(5040);
    }
    expect(applyFeedback(initial, { a: 0, b: 0 }).state.history).toHaveLength(1);
  });

  it('矛盾回饋拒絕且保留舊狀態，診斷標示建議回饋的回合', () => {
    const first = applyFeedback(createSolver(), { a: 0, b: 0 });
    expect(first.ok).toBe(true);
    const state = first.state;
    const impossible = VALID_FEEDBACKS.find(feedback => candidatesForHistory([
      ...state.history, { guess: state.pendingGuess!, feedback },
    ]).size === 0)!;
    expect(impossible).toBeDefined();
    const rejected = applyFeedback(state, impossible);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('Expected contradiction');
    expect(rejected.state).toBe(state);
    expect(rejected.diagnosis.turns).toContain(2);
    expect(state.history).toHaveLength(1);
    const corrected = applyFeedback(state, score('9876', state.pendingGuess));
    expect(corrected.ok).toBe(true);
    expect(corrected.state.history).toHaveLength(2);
  });

  it('全部 5040 組逐局解題，獨立評分、完整歷史核對、無重複或無進展', () => {
    const report = auditAllAnswers();
    expect(report.answers).toBe(5040);
    expect(report.failures).toBe(0);
    expect(Object.values(report.stepDistribution).reduce((a, b) => a + b, 0)).toBe(5040);
    expect(report.maxCandidatesAfterFirst).toBe(1440);
    expect(report.maxCandidatesAfterSecond).toBe(378);
    // Timing is reported, not asserted: local scheduling is not a Workers SLA.
    console.log(JSON.stringify({ averageSteps: report.averageSteps, worstSteps: report.worstSteps, distribution: report.stepDistribution }));
  });

  it('每個 reachable 局面的 14 種口述回饋：合法分支收斂、矛盾分支不變更', () => {
    const report = auditDecisionTree();
    expect(report.terminalAnswers).toBe(5040);
    expect(report.branches).toBeGreaterThan(5040);
  });
});
