import { classifyOutcome, shouldSkipStrategy, needsEscalation, RepairHistoryEntry } from './repair-history';

describe('classifyOutcome', () => {
  it('delta=5 : SIGNIFICANT (borne incluse)', () => expect(classifyOutcome(5)).toBe('SIGNIFICANT'));
  it('delta=10 : SIGNIFICANT', () => expect(classifyOutcome(10)).toBe('SIGNIFICANT'));
  it('delta=4 : FAIBLE (juste sous la borne SIGNIFICANT)', () => expect(classifyOutcome(4)).toBe('FAIBLE'));
  it('delta=0 : FAIBLE (borne incluse)', () => expect(classifyOutcome(0)).toBe('FAIBLE'));
  it('delta=-1 : ECHEC', () => expect(classifyOutcome(-1)).toBe('ECHEC'));
  it('delta=-20 : ECHEC', () => expect(classifyOutcome(-20)).toBe('ECHEC'));
});

describe('shouldSkipStrategy', () => {
  const echecEntry: RepairHistoryEntry = { criterion: 'motionDynamism' as any, sceneId: 'shot-2', strategy: 'CLIP_REGEN', scoreDelta: -10, outcome: 'ECHEC' };
  const faibleEntry: RepairHistoryEntry = { criterion: 'audioQuality' as any, sceneId: undefined, strategy: 'AUDIO_REGEN', scoreDelta: 2, outcome: 'FAIBLE' };

  it('entrée ECHEC exacte (même critère/scène/stratégie) : true', () => {
    expect(shouldSkipStrategy([echecEntry], 'motionDynamism' as any, 'shot-2', 'CLIP_REGEN')).toBe(true);
  });

  it('entrée FAIBLE (pas ECHEC) sur la même triple : false — ne bloque jamais, seule une escalade est due', () => {
    expect(shouldSkipStrategy([faibleEntry], 'audioQuality' as any, undefined, 'AUDIO_REGEN')).toBe(false);
  });

  it('ECHEC mais sur une AUTRE scène : false — ne bloque que la scène concernée', () => {
    expect(shouldSkipStrategy([echecEntry], 'motionDynamism' as any, 'shot-3', 'CLIP_REGEN')).toBe(false);
  });

  it('ECHEC mais sur un AUTRE critère : false', () => {
    expect(shouldSkipStrategy([echecEntry], 'productConsistency' as any, 'shot-2', 'CLIP_REGEN')).toBe(false);
  });

  it('historique vide : false', () => {
    expect(shouldSkipStrategy([], 'motionDynamism' as any, 'shot-2', 'CLIP_REGEN')).toBe(false);
  });
});

describe('needsEscalation', () => {
  const faibleEntry: RepairHistoryEntry = { criterion: 'motionDynamism' as any, sceneId: 'shot-2', strategy: 'CLIP_REGEN', scoreDelta: 3, outcome: 'FAIBLE' };

  it('entrée FAIBLE exacte : true', () => {
    expect(needsEscalation([faibleEntry], 'motionDynamism' as any, 'shot-2', 'CLIP_REGEN')).toBe(true);
  });

  it('entrée SIGNIFICANT (déjà un vrai progrès) : false — aucune escalade nécessaire', () => {
    const entry: RepairHistoryEntry = { ...faibleEntry, outcome: 'SIGNIFICANT', scoreDelta: 10 };
    expect(needsEscalation([entry], 'motionDynamism' as any, 'shot-2', 'CLIP_REGEN')).toBe(false);
  });

  it('historique vide : false', () => {
    expect(needsEscalation([], 'motionDynamism' as any, 'shot-2', 'CLIP_REGEN')).toBe(false);
  });
});
