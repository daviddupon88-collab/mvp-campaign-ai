import { classifyRepair, REPAIR_STRATEGY_COST_ORDER, repairScopeForStrategy, isClipRegenGateSatisfied, FORMAT_REPAIR_CONFIDENCE_THRESHOLD, SCENE_REPAIR_CONFIDENCE_THRESHOLD } from './repair-dispatch';
import { JudgeCriterionName, JudgeCriterionResult } from './video-judge.types';

const ALL_CRITERIA: JudgeCriterionName[] = [
  'productConsistency', 'motionDynamism', 'audioQuality', 'voiceAudibility', 'formatCompliance',
  'productVisibility', 'storytelling', 'hookStrength', 'pacing', 'textReadability', 'grammar',
  'ctaClarity', 'brandCoherence', 'factualConsistency', 'advertisingEffectiveness',
];

describe('classifyRepair', () => {
  it('les 15 critères ont chacun une stratégie assignée (aucun undefined)', () => {
    for (const criterion of ALL_CRITERIA) {
      expect(classifyRepair(criterion)).toBeDefined();
    }
  });

  it('CLIP_REGEN pour les défauts de contenu filmé (mouvement, fidélité produit, visibilité)', () => {
    expect(classifyRepair('motionDynamism')).toBe('CLIP_REGEN');
    expect(classifyRepair('productConsistency')).toBe('CLIP_REGEN');
    expect(classifyRepair('productVisibility')).toBe('CLIP_REGEN');
  });

  it('SUBTITLE_ONLY pour les défauts de texte affiché/rythme (aucune régénération vidéo/audio nécessaire)', () => {
    expect(classifyRepair('textReadability')).toBe('SUBTITLE_ONLY');
    expect(classifyRepair('pacing')).toBe('SUBTITLE_ONLY');
    expect(classifyRepair('grammar')).toBe('SUBTITLE_ONLY');
  });

  it('AUDIO_REGEN pour les défauts vocaux/sonores et le CTA (repli conservateur : CTA supposé parlé)', () => {
    expect(classifyRepair('audioQuality')).toBe('AUDIO_REGEN');
    expect(classifyRepair('voiceAudibility')).toBe('AUDIO_REGEN');
    expect(classifyRepair('ctaClarity')).toBe('AUDIO_REGEN');
  });

  it('UNREPAIRABLE pour les jugements holistiques sans correctif mécanique ciblé', () => {
    expect(classifyRepair('storytelling')).toBe('UNREPAIRABLE');
    expect(classifyRepair('hookStrength')).toBe('UNREPAIRABLE');
    expect(classifyRepair('brandCoherence')).toBe('UNREPAIRABLE');
    expect(classifyRepair('advertisingEffectiveness')).toBe('UNREPAIRABLE');
    expect(classifyRepair('factualConsistency')).toBe('UNREPAIRABLE');
    // Mission 4 Phase A : jugement créatif holistique (cadrage/équilibre), jamais un correctif
    // mécanique ciblé — distinct de formatCompliance (géométrie mesurée) ci-dessous.
    expect(classifyRepair('visualComposition')).toBe('UNREPAIRABLE');
  });

  it("Mission 4 Phase H — CLIP_REGEN pour formatCompliance/sceneConsistency (le gate de confiance dédié, pas classifyRepair, décide s'il s'applique réellement)", () => {
    expect(classifyRepair('formatCompliance')).toBe('CLIP_REGEN');
    expect(classifyRepair('sceneConsistency')).toBe('CLIP_REGEN');
  });

  it('Mission 4 Phase H — AUDIO_REGEN pour voiceDynamism/voicePacing (jamais CLIP_REGEN/generateVideo pour un défaut vocal isolé)', () => {
    expect(classifyRepair('voiceDynamism')).toBe('AUDIO_REGEN');
    expect(classifyRepair('voicePacing')).toBe('AUDIO_REGEN');
  });
});

describe('Mission 4 Phase H — isClipRegenGateSatisfied (gate de confiance dédié formatCompliance/sceneConsistency)', () => {
  function criterion(overrides: Partial<JudgeCriterionResult>): JudgeCriterionResult {
    return { name: 'formatCompliance', score: 50, justification: 'x', ...overrides };
  }

  it('TEST 15/TEST 12 — confiance suffisante + sceneRef unique : gate satisfait', () => {
    expect(isClipRegenGateSatisfied(criterion({ name: 'formatCompliance', confidence: FORMAT_REPAIR_CONFIDENCE_THRESHOLD, sceneRef: 'shot-3' }))).toBe(true);
    expect(isClipRegenGateSatisfied(criterion({ name: 'sceneConsistency', confidence: SCENE_REPAIR_CONFIDENCE_THRESHOLD, sceneRef: 'shot-3' }))).toBe(true);
  });

  it('TEST 11 — confiance sous le seuil : gate refusé même avec un sceneRef', () => {
    expect(isClipRegenGateSatisfied(criterion({ name: 'formatCompliance', confidence: FORMAT_REPAIR_CONFIDENCE_THRESHOLD - 0.01, sceneRef: 'shot-3' }))).toBe(false);
    expect(isClipRegenGateSatisfied(criterion({ name: 'sceneConsistency', confidence: SCENE_REPAIR_CONFIDENCE_THRESHOLD - 0.01, sceneRef: 'shot-3' }))).toBe(false);
  });

  it('TEST 16 — sceneRef absent : gate refusé même à confiance élevée (défaut non localisable)', () => {
    expect(isClipRegenGateSatisfied(criterion({ name: 'formatCompliance', confidence: 0.99, sceneRef: undefined }))).toBe(false);
    expect(isClipRegenGateSatisfied(criterion({ name: 'sceneConsistency', confidence: 0.99, sceneRef: undefined }))).toBe(false);
  });

  it('confidence totalement absente (mesure non renseignée) : gate refusé, jamais un repli optimiste', () => {
    expect(isClipRegenGateSatisfied(criterion({ name: 'formatCompliance', sceneRef: 'shot-3' }))).toBe(false);
  });

  it('critères CLIP_REGEN préexistants (motionDynamism, productConsistency, productVisibility) : jamais gatés, toujours autorisés (comportement historique inchangé)', () => {
    expect(isClipRegenGateSatisfied(criterion({ name: 'motionDynamism', confidence: undefined, sceneRef: undefined }))).toBe(true);
    expect(isClipRegenGateSatisfied(criterion({ name: 'productConsistency', confidence: undefined, sceneRef: undefined }))).toBe(true);
    expect(isClipRegenGateSatisfied(criterion({ name: 'productVisibility', confidence: undefined, sceneRef: undefined }))).toBe(true);
  });
});

describe('REPAIR_STRATEGY_COST_ORDER', () => {
  it('SUBTITLE_ONLY et AUDIO_REGEN précèdent toujours CLIP_REGEN (moins coûteux en premier)', () => {
    const subtitleIndex = REPAIR_STRATEGY_COST_ORDER.indexOf('SUBTITLE_ONLY');
    const audioIndex = REPAIR_STRATEGY_COST_ORDER.indexOf('AUDIO_REGEN');
    const clipIndex = REPAIR_STRATEGY_COST_ORDER.indexOf('CLIP_REGEN');

    expect(subtitleIndex).toBeLessThan(clipIndex);
    expect(audioIndex).toBeLessThan(clipIndex);
  });
});

describe('repairScopeForStrategy (Phase O)', () => {
  it('CLIP_REGEN -> SCENE_ONLY (cible toujours une scène précise)', () => {
    expect(repairScopeForStrategy('CLIP_REGEN')).toBe('SCENE_ONLY');
  });

  it('SUBTITLE_ONLY et AUDIO_REGEN -> SCENE_GROUP (portée globale, pas de scène)', () => {
    expect(repairScopeForStrategy('SUBTITLE_ONLY')).toBe('SCENE_GROUP');
    expect(repairScopeForStrategy('AUDIO_REGEN')).toBe('SCENE_GROUP');
  });
});
