import { QUALITY_TARGET_V1 } from './quality-target';

describe('QUALITY_TARGET_V1', () => {
  it('cible 75/100, versionné, jamais un nombre magique dupliqué ailleurs', () => {
    expect(QUALITY_TARGET_V1.targetScore).toBe(75);
    expect(QUALITY_TARGET_V1.version).toBe('goal-first-v2');
  });

  it('critères critiques réutilisent des noms de JudgeCriterionName, jamais des libellés inventés', () => {
    const knownCriteria = [
      'productConsistency', 'motionDynamism', 'audioQuality', 'voiceAudibility', 'formatCompliance',
      'productVisibility', 'storytelling', 'hookStrength', 'pacing', 'textReadability', 'grammar',
      'ctaClarity', 'brandCoherence', 'factualConsistency', 'advertisingEffectiveness',
      'voiceDynamism', 'voicePacing', 'visualComposition', 'sceneConsistency',
    ];
    for (const criterion of QUALITY_TARGET_V1.criticalCriteria) {
      expect(knownCriteria).toContain(criterion);
    }
  });

  it('plancher critique et conditions prohibées définis, non vides', () => {
    expect(QUALITY_TARGET_V1.minimumCriticalScore).toBeGreaterThan(0);
    expect(QUALITY_TARGET_V1.prohibitedConditions.length).toBeGreaterThan(0);
  });
});
