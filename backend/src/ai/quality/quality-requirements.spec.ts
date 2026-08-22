import { deriveQualityRequirements, renderQualityRequirementsForPrompt, buildStageQualityRequirementsBlock, CONCEPT_STAGE_CRITERIA, STORYBOARD_STAGE_CRITERIA } from './quality-requirements';
import { QualityTarget } from './quality-target';

const TARGET: QualityTarget = {
  targetScore: 75,
  version: 'test-v1',
  criticalCriteria: ['hookStrength', 'ctaClarity'],
  minimumCriticalScore: 60,
  prohibitedConditions: [],
};

describe('deriveQualityRequirements', () => {
  it('produit une exigence par critère critique, toutes bloquantes', () => {
    const { requirements } = deriveQualityRequirements(TARGET);

    expect(requirements).toHaveLength(TARGET.criticalCriteria.length);
    expect(requirements.every((r) => r.blocking)).toBe(true);
    expect(requirements.every((r) => r.importance === 'CRITICAL')).toBe(true);
    expect(requirements.map((r) => r.criterion)).toEqual(TARGET.criticalCriteria);
  });

  it('chaque exigence porte une consigne de CONSTRUCTION concrète, pas une reformulation du critère', () => {
    const { requirements } = deriveQualityRequirements(TARGET);

    const hookRequirement = requirements.find((r) => r.criterion === 'hookStrength')!;
    expect(hookRequirement.constructionRequirement.length).toBeGreaterThan(20);
    expect(hookRequirement.constructionRequirement).not.toBe('hookStrength');
  });

  it('critère inconnu de la table : repli générique, jamais une exception', () => {
    const unknownTarget: QualityTarget = { ...TARGET, criticalCriteria: ['someFutureCriterion'] };

    const { requirements } = deriveQualityRequirements(unknownTarget);

    expect(requirements).toHaveLength(1);
    expect(requirements[0].constructionRequirement.length).toBeGreaterThan(0);
  });

  it('liste vide : aucune exigence, jamais une exception', () => {
    const emptyTarget: QualityTarget = { ...TARGET, criticalCriteria: [] };

    expect(deriveQualityRequirements(emptyTarget).requirements).toEqual([]);
  });
});

describe('renderQualityRequirementsForPrompt', () => {
  it('rend un bloc texte contenant la consigne de construction de chaque exigence', () => {
    const requirements = deriveQualityRequirements(TARGET);

    const block = renderQualityRequirementsForPrompt(requirements);

    expect(block).toContain(String(TARGET.targetScore));
    for (const requirement of requirements.requirements) {
      expect(block).toContain(requirement.constructionRequirement);
    }
  });

  it('aucune exigence : bloc vide, jamais un en-tête creux', () => {
    const empty = deriveQualityRequirements({ ...TARGET, criticalCriteria: [] });

    expect(renderQualityRequirementsForPrompt(empty)).toBe('');
  });
});

// Mission 4.3 (Goal-First Quality Architecture, Phase 2) — relocalisé depuis creative-gate.service.ts
// et storyboard-gate.service.ts (Phase 1) : construction (CreativeConceptService) et évaluation
// (les deux gates) doivent juger le MÊME sous-ensemble de critères à un stade donné.
describe('buildStageQualityRequirementsBlock', () => {
  const fullTarget: QualityTarget = {
    targetScore: 75,
    version: 'test-v1',
    criticalCriteria: ['hookStrength', 'ctaClarity', 'storytelling', 'productConsistency', 'brandCoherence'],
    minimumCriticalScore: 60,
    prohibitedConditions: [],
  };

  it('stade concept : ne garde que hookStrength/ctaClarity/storytelling, jamais productConsistency (stade storyboard)', () => {
    const block = buildStageQualityRequirementsBlock(fullTarget, CONCEPT_STAGE_CRITERIA);

    expect(block).toContain('hookStrength');
    expect(block).toContain('ctaClarity');
    expect(block).toContain('storytelling');
    expect(block).not.toContain('productConsistency');
    expect(block).not.toContain('brandCoherence');
  });

  it('stade storyboard : ne garde que productConsistency/storytelling/ctaClarity, jamais hookStrength', () => {
    const block = buildStageQualityRequirementsBlock(fullTarget, STORYBOARD_STAGE_CRITERIA);

    expect(block).toContain('productConsistency');
    expect(block).toContain('storytelling');
    expect(block).toContain('ctaClarity');
    expect(block).not.toContain('hookStrength');
  });

  it('aucun critère du QualityTarget ne correspond au stade : bloc vide', () => {
    const target: QualityTarget = { ...fullTarget, criticalCriteria: ['brandCoherence'] };

    expect(buildStageQualityRequirementsBlock(target, CONCEPT_STAGE_CRITERIA)).toBe('');
  });
});
