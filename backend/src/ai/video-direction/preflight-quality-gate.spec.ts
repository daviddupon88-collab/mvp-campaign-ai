import { evaluatePreFlightQuality, PreFlightQualityInput } from './preflight-quality-gate';
import { VisualDna } from './visual-dna.service';
import { Shot } from './video-director.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';

const CLEAN_VISUAL_DNA: VisualDna = {
  productCategory: 'gilet', colors: ['jaune'], materials: ['mesh'], shape: 'ajusté',
  distinctiveFeatures: ['bandes réfléchissantes'], logoOrBrandMarks: null, raw: '{}', isFallback: false,
};
const CLEAN_CONCEPT: CreativeConcept = {
  title: 't', concept: 'c', coreMessage: 'm', hook: 'Un chantier plongé dans le noir', emotionalDirection: 'e', visualDirection: 'v',
  storytellingApproach: 's', proofStrategy: 'p', cta: 'Commandez la vôtre', targetAudience: 'a', duration: 15, format: '9:16',
  scenesCount: 2, qualityAlignment: 'Hook = événement dès la 1ère seconde.', raw: '{}',
};
const CLEAN_BLUEPRINT: NarrativeBlueprint = {
  hook: 'h', problem: 'p', tension: 't', reveal: 'r', productIntroduction: 'i',
  benefit: 'b', proof: 'pr', emotionalPayoff: 'e', cta: 'c', pacing: 'x', pausePoints: [],
  beats: [{ id: 'beat-1', role: 'hook', objective: 'accrocher', duration: 3, requiredVisualEvidence: 'chantier sombre', requiredVoiceover: 'x', shotIds: [] }],
  raw: '{}',
};
const SHOT_1: Shot = { sceneId: 'shot-1', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };
const SHOT_2: Shot = { sceneId: 'shot-2', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };
const CLEAN_SHOT_PLAN: Shot[] = [SHOT_1, SHOT_2];
const PASSING_VALIDATION = { passed: true, reasons: [], warnings: [] };

function buildInput(overrides: Partial<PreFlightQualityInput> = {}): PreFlightQualityInput {
  return {
    visualDna: CLEAN_VISUAL_DNA,
    creativeConcept: CLEAN_CONCEPT,
    narrativeBlueprint: CLEAN_BLUEPRINT,
    shotPlan: CLEAN_SHOT_PLAN,
    shotPlanValidation: PASSING_VALIDATION,
    narrationText: 'Un chantier plongé dans le noir. Commandez la vôtre.',
    ...overrides,
  };
}

describe('evaluatePreFlightQuality', () => {
  it('entrée entièrement propre : ready=true, aucune raison bloquante', () => {
    const result = evaluatePreFlightQuality(buildInput());
    expect(result.ready).toBe(true);
    expect(result.blockingReasons).toEqual([]);
  });

  describe('PRODUCT', () => {
    it('Visual DNA en repli neutre (isFallback=true) : bloquant', () => {
      const result = evaluatePreFlightQuality(buildInput({ visualDna: { ...CLEAN_VISUAL_DNA, isFallback: true } }));
      expect(result.ready).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes('isFallback=true'))).toBe(true);
    });

    it('Visual DNA sans élément distinctif (mais pas en fallback) : bloquant', () => {
      const result = evaluatePreFlightQuality(buildInput({ visualDna: { ...CLEAN_VISUAL_DNA, distinctiveFeatures: [] } }));
      expect(result.ready).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes('élément distinctif'))).toBe(true);
    });
  });

  describe('CONCEPT', () => {
    it('hook vide : bloquant', () => {
      const result = evaluatePreFlightQuality(buildInput({ creativeConcept: { ...CLEAN_CONCEPT, hook: '' } }));
      expect(result.blockingReasons.some((r) => r.includes('Hook absent'))).toBe(true);
    });

    it('cta vide : bloquant', () => {
      const result = evaluatePreFlightQuality(buildInput({ creativeConcept: { ...CLEAN_CONCEPT, cta: '' } }));
      expect(result.blockingReasons.some((r) => r.includes('Aucun CTA'))).toBe(true);
    });

    it('qualityAlignment vide : bloquant (1ère application réelle de ce champ Phase 2)', () => {
      const result = evaluatePreFlightQuality(buildInput({ creativeConcept: { ...CLEAN_CONCEPT, qualityAlignment: '' } }));
      expect(result.blockingReasons.some((r) => r.includes('qualityAlignment'))).toBe(true);
    });
  });

  describe('NARRATIVE', () => {
    it('aucun beat : bloquant', () => {
      const result = evaluatePreFlightQuality(buildInput({ narrativeBlueprint: { ...CLEAN_BLUEPRINT, beats: [] } }));
      expect(result.blockingReasons.some((r) => r.includes('Aucun beat narratif'))).toBe(true);
    });

    it('un beat sans requiredVisualEvidence : bloquant, cite son id', () => {
      const blueprint: NarrativeBlueprint = { ...CLEAN_BLUEPRINT, beats: [{ ...CLEAN_BLUEPRINT.beats[0], requiredVisualEvidence: '' }] };
      const result = evaluatePreFlightQuality(buildInput({ narrativeBlueprint: blueprint }));
      expect(result.blockingReasons.some((r) => r.includes('requiredVisualEvidence') && r.includes('beat-1'))).toBe(true);
    });
  });

  describe('SHOT PLAN', () => {
    it('shotPlanValidation.passed=false : ses reasons sont reprises telles quelles, jamais recalculées', () => {
      const validation = { passed: false, reasons: ['nombre de plans incorrect : 1 généré(s) au lieu de 2 attendu(s)'], warnings: [] };
      const result = evaluatePreFlightQuality(buildInput({ shotPlanValidation: validation }));
      expect(result.blockingReasons).toContain('nombre de plans incorrect : 1 généré(s) au lieu de 2 attendu(s)');
    });

    it('un shot usedFallbackTemplate=true : bloquant (élevé depuis un warning non-bloquant dans shot-plan-validator.ts)', () => {
      const shotPlan: Shot[] = [SHOT_1, { ...SHOT_2, usedFallbackTemplate: true }];
      const result = evaluatePreFlightQuality(buildInput({ shotPlan }));
      expect(result.ready).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes('usedFallbackTemplate') && r.includes('shot-2'))).toBe(true);
    });
  });

  describe('EXECUTION', () => {
    it('narrativeBeatId ne correspond à aucun beat du blueprint : bloquant (lien orphelin)', () => {
      const shotPlan: Shot[] = [SHOT_1, { ...SHOT_2, narrativeBeatId: 'beat-inconnu' }];
      const result = evaluatePreFlightQuality(buildInput({ shotPlan }));
      expect(result.ready).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes('narrativeBeatId inconnu') && r.includes('shot-2'))).toBe(true);
    });

    it('narrativeBeatId correspond bien à un beat existant : jamais bloquant', () => {
      const shotPlan: Shot[] = [SHOT_1, { ...SHOT_2, narrativeBeatId: 'beat-1' }];
      const result = evaluatePreFlightQuality(buildInput({ shotPlan }));
      expect(result.ready).toBe(true);
    });
  });

  describe('DELIVERY', () => {
    it('narrationText vide : bloquant', () => {
      const result = evaluatePreFlightQuality(buildInput({ narrationText: '' }));
      expect(result.blockingReasons.some((r) => r.includes('Aucune narration'))).toBe(true);
    });
  });

  // Mission 4.4 (Product URL Intelligence, Phase Q)
  describe('PRODUCT_SOURCE', () => {
    it('aucun productConflicts (URL non fournie/exploitée) : jamais bloquant en soi', () => {
      const result = evaluatePreFlightQuality(buildInput({ productConflicts: undefined }));
      expect(result.ready).toBe(true);
    });

    it('conflit UNRESOLVED sur un attribut d\'identité critique (brand) : bloquant', () => {
      const result = evaluatePreFlightQuality(
        buildInput({
          productConflicts: [
            { attribute: 'brand', sources: [{ source: 'PRODUCT_URL', value: 'X', confidence: 0.9 }, { source: 'IMAGE', value: 'Y', confidence: 0.85 }], resolution: 'UNRESOLVED', reason: 'écart trop faible' },
          ],
        }),
      );
      expect(result.ready).toBe(false);
      expect(result.blockingReasons.some((r) => r.includes('brand'))).toBe(true);
    });

    it('conflit UNRESOLVED sur un attribut NON critique (ex. une spécification secondaire) : jamais bloquant', () => {
      const result = evaluatePreFlightQuality(
        buildInput({
          productConflicts: [
            { attribute: 'Poids', sources: [{ source: 'PRODUCT_URL', value: '500g', confidence: 0.9 }, { source: 'IMAGE', value: '600g', confidence: 0.85 }], resolution: 'UNRESOLVED', reason: 'écart trop faible' },
          ],
        }),
      );
      expect(result.ready).toBe(true);
    });

    it('conflit RÉSOLU (pas UNRESOLVED), même sur un attribut critique : jamais bloquant', () => {
      const result = evaluatePreFlightQuality(
        buildInput({
          productConflicts: [
            { attribute: 'brand', sources: [{ source: 'PRODUCT_URL', value: 'X', confidence: 0.9 }], resolution: 'URL_PREFERRED', reason: 'x' },
          ],
        }),
      );
      expect(result.ready).toBe(true);
    });
  });

  it('plusieurs défauts simultanés : toutes les raisons apparaissent, pas seulement la première', () => {
    const result = evaluatePreFlightQuality(
      buildInput({
        visualDna: { ...CLEAN_VISUAL_DNA, isFallback: true },
        creativeConcept: { ...CLEAN_CONCEPT, cta: '' },
        narrativeBlueprint: { ...CLEAN_BLUEPRINT, beats: [] },
        narrationText: '',
      }),
    );

    expect(result.blockingReasons.length).toBeGreaterThanOrEqual(4);
  });
});
