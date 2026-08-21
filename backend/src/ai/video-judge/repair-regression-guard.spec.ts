import { evaluateRepairOutcome, computeCriterionDeltas } from './repair-regression-guard';
import { VideoJudgeResult } from './video-judge.types';

function buildJudge(criteria: { name: string; score: number }[], globalScore: number): VideoJudgeResult {
  return {
    criteria: criteria.map((c) => ({ name: c.name as any, score: c.score, justification: 'x' })),
    globalScore,
    visualQuality: { score: globalScore, criteria: [] },
    advertisingEffectiveness: { score: globalScore, criteria: [] },
    verdict: 'REPAIR_REQUIRED',
  };
}

describe('evaluateRepairOutcome', () => {
  it("exemple du spec : mouvement 45->75 mais productConsistency (critique) 88->62... reste au-dessus du plancher (50) : PAS une régression critique, mais le score global décide", () => {
    const before = buildJudge([{ name: 'motionDynamism', score: 45 }, { name: 'productConsistency', score: 88 }], 60);
    const after = buildJudge([{ name: 'motionDynamism', score: 75 }, { name: 'productConsistency', score: 62 }], 70);

    const result = evaluateRepairOutcome(before, after);

    expect(result.accepted).toBe(true); // productConsistency reste >=50 (plancher) et le score global progresse
  });

  it('un critère CRITIQUE franchit le plancher vers le bas à cause de cette réparation : rejetée, même si un autre critère progresse fortement', () => {
    const before = buildJudge([{ name: 'motionDynamism', score: 45 }, { name: 'productConsistency', score: 88 }], 60);
    const after = buildJudge([{ name: 'motionDynamism', score: 90 }, { name: 'productConsistency', score: 40 }], 65);

    const result = evaluateRepairOutcome(before, after);

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('productConsistency');
  });

  it('un critère critique déjà sous le plancher AVANT la réparation et qui y reste (sans nouvelle régression) : pas rejeté pour ce motif', () => {
    const before = buildJudge([{ name: 'productConsistency', score: 30 }], 40);
    const after = buildJudge([{ name: 'productConsistency', score: 35 }], 45); // progresse, toujours sous le plancher mais pas une NOUVELLE régression

    const result = evaluateRepairOutcome(before, after);

    expect(result.accepted).toBe(true);
  });

  it('score global régresse (aucun critère critique concerné) : rejetée', () => {
    const before = buildJudge([{ name: 'hookStrength', score: 70 }], 65);
    const after = buildJudge([{ name: 'hookStrength', score: 50 }], 55);

    const result = evaluateRepairOutcome(before, after);

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('score global');
  });

  it('amélioration franche sur toute la ligne : acceptée', () => {
    const before = buildJudge([{ name: 'hookStrength', score: 50 }], 55);
    const after = buildJudge([{ name: 'hookStrength', score: 80 }], 75);

    const result = evaluateRepairOutcome(before, after);

    expect(result.accepted).toBe(true);
  });
});

describe('computeCriterionDeltas', () => {
  it('calcule le delta exact par critère présent dans les deux jugements', () => {
    const before = buildJudge([{ name: 'hookStrength', score: 50 }, { name: 'pacing', score: 60 }], 55);
    const after = buildJudge([{ name: 'hookStrength', score: 80 }, { name: 'pacing', score: 55 }], 70);

    const deltas = computeCriterionDeltas(before, after);

    expect(deltas.get('hookStrength' as any)).toBe(30);
    expect(deltas.get('pacing' as any)).toBe(-5);
  });
});
