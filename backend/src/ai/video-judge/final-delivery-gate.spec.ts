import { evaluateFinalDelivery, FinalDeliveryInput } from './final-delivery-gate';
import { VideoJudgeResult } from './video-judge.types';

function buildJudge(verdict: 'PASS' | 'REPAIR_REQUIRED', globalScore = 90): VideoJudgeResult {
  return { criteria: [], globalScore, visualQuality: { score: globalScore, criteria: [] }, advertisingEffectiveness: { score: globalScore, criteria: [] }, verdict };
}

function buildInput(overrides: Partial<FinalDeliveryInput> = {}): FinalDeliveryInput {
  return {
    creativeGateStatus: 'APPROVED',
    storyboardGateStatus: 'APPROVED',
    judge: buildJudge('PASS'),
    narrationDataUri: 'data:audio/mp3;base64,ZmFrZQ==',
    transcript: [{ start: 0, end: 2, text: 'x' }],
    format: '9:16',
    plannedShotCount: 3,
    deliveredShotCount: 3,
    ...overrides,
  };
}

describe('evaluateFinalDelivery', () => {
  it('toutes les conditions réunies : deliverable=true, aucune raison bloquante', () => {
    const result = evaluateFinalDelivery(buildInput());

    expect(result.deliverable).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  it('Storyboard Gate REJECT malgré un Video Judge PASS : deliverable=false, raison nommée', () => {
    const result = evaluateFinalDelivery(buildInput({ storyboardGateStatus: 'REJECT' }));

    expect(result.deliverable).toBe(false);
    expect(result.blockingReasons.some((r) => r.includes('Storyboard Gate'))).toBe(true);
  });

  it('Creative Gate non APPROVED (REVISE) : deliverable=false', () => {
    const result = evaluateFinalDelivery(buildInput({ creativeGateStatus: 'REVISE' }));

    expect(result.deliverable).toBe(false);
    expect(result.blockingReasons.some((r) => r.includes('Creative Gate'))).toBe(true);
  });

  it('narration absente malgré tout le reste au vert : deliverable=false — jamais de livraison silencieuse incomplète', () => {
    const result = evaluateFinalDelivery(buildInput({ narrationDataUri: null }));

    expect(result.deliverable).toBe(false);
    expect(result.blockingReasons.some((r) => r.includes('Audio'))).toBe(true);
  });

  it('transcript vide : deliverable=false', () => {
    const result = evaluateFinalDelivery(buildInput({ transcript: [] }));

    expect(result.deliverable).toBe(false);
  });

  it('format non supporté : deliverable=false', () => {
    const result = evaluateFinalDelivery(buildInput({ format: '16:9' }));

    expect(result.deliverable).toBe(false);
    expect(result.blockingReasons.some((r) => r.includes('Format'))).toBe(true);
  });

  it('plusieurs conditions en échec simultanément : toutes les raisons sont listées, pas seulement la première', () => {
    const result = evaluateFinalDelivery(buildInput({ creativeGateStatus: 'BLOCKED', judge: buildJudge('REPAIR_REQUIRED', 40) }));

    expect(result.blockingReasons.length).toBeGreaterThanOrEqual(2);
  });

  describe('Mission 4.3 (Étape 14/18) — livraison partielle, tolérance ZÉRO (supersède la tolérance 50% de Mission 4.2 P0-4)', () => {
    it('tous les plans livrés : partialDelivery=false, jamais bloquant', () => {
      const result = evaluateFinalDelivery(buildInput({ plannedShotCount: 4, deliveredShotCount: 4 }));

      expect(result.partialDelivery).toBe(false);
      expect(result.deliverable).toBe(true);
    });

    it('9 plans livrés sur 10 planifiés (bien au-dessus de l\'ancien seuil de tolérance 50%) : deliverable=false quand même — la logique de ratio a disparu, tout manquant bloque', () => {
      const result = evaluateFinalDelivery(buildInput({ plannedShotCount: 10, deliveredShotCount: 9 }));

      expect(result.partialDelivery).toBe(true);
      expect(result.deliverable).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes('9/10'))).toBe(true);
    });

    it('3 plans livrés sur 4 planifiés : deliverable=false, raison explicite citant le ratio', () => {
      const result = evaluateFinalDelivery(buildInput({ plannedShotCount: 4, deliveredShotCount: 3 }));

      expect(result.partialDelivery).toBe(true);
      expect(result.deliverable).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes('3/4'))).toBe(true);
    });

    it('1 plan livré sur 5 planifiés : deliverable=false, raison explicite citant le ratio', () => {
      const result = evaluateFinalDelivery(buildInput({ plannedShotCount: 5, deliveredShotCount: 1 }));

      expect(result.partialDelivery).toBe(true);
      expect(result.deliverable).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes('1/5'))).toBe(true);
    });

    it('plannedShotCount=0 (aucun plan attendu) : jamais interprété comme une livraison partielle', () => {
      const result = evaluateFinalDelivery(buildInput({ plannedShotCount: 0, deliveredShotCount: 0 }));

      expect(result.partialDelivery).toBe(false);
    });
  });
});
