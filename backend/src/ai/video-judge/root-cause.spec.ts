import { classifyRootCause } from './root-cause';
import { RepairHistoryEntry } from './repair-history';
import { JudgeCriterionResult, UNAVAILABLE_DEFECT } from './video-judge.types';

describe('classifyRootCause', () => {
  it('classe storytelling sans historique comme STORYBOARD', () => {
    expect(classifyRootCause('storytelling', { history: [] })).toBe('STORYBOARD');
  });

  it('classe storytelling comme CONCEPT si une escalade storyboard a déjà ECHOUE', () => {
    const history: RepairHistoryEntry[] = [
      { criterion: 'storytelling', strategy: 'UNREPAIRABLE', scoreDelta: -3, outcome: 'ECHEC' },
    ];
    expect(classifyRootCause('storytelling', { history })).toBe('CONCEPT');
  });

  it('classe storytelling comme CONCEPT si une escalade storyboard a déjà été FAIBLE', () => {
    const history: RepairHistoryEntry[] = [
      { criterion: 'storytelling', strategy: 'UNREPAIRABLE', scoreDelta: 2, outcome: 'FAIBLE' },
    ];
    expect(classifyRootCause('storytelling', { history })).toBe('CONCEPT');
  });

  it('classe hookStrength comme STORYBOARD par défaut', () => {
    expect(classifyRootCause('hookStrength', { history: [] })).toBe('STORYBOARD');
  });

  it('classe advertisingEffectiveness comme STORYBOARD par défaut', () => {
    expect(classifyRootCause('advertisingEffectiveness', { history: [] })).toBe('STORYBOARD');
  });

  it("n'escalade pas vers CONCEPT sur un historique d'un AUTRE critère", () => {
    const history: RepairHistoryEntry[] = [
      { criterion: 'hookStrength', strategy: 'UNREPAIRABLE', scoreDelta: -3, outcome: 'ECHEC' },
    ];
    expect(classifyRootCause('storytelling', { history })).toBe('STORYBOARD');
  });

  it('classe productConsistency avec sceneRef et aucun historique comme SCENE', () => {
    expect(classifyRootCause('productConsistency', { sceneRef: 'shot-1', history: [] })).toBe('SCENE');
  });

  it('classe productConsistency comme PRODUCT_FIDELITY après 2 CLIP_REGEN ECHEC sur la même scène', () => {
    const history: RepairHistoryEntry[] = [
      { criterion: 'productConsistency', sceneId: 'shot-1', strategy: 'CLIP_REGEN', scoreDelta: -2, outcome: 'ECHEC' },
      { criterion: 'productConsistency', sceneId: 'shot-1', strategy: 'CLIP_REGEN', scoreDelta: -1, outcome: 'ECHEC' },
    ];
    expect(classifyRootCause('productConsistency', { sceneRef: 'shot-1', history })).toBe('PRODUCT_FIDELITY');
  });

  it('reste SCENE si seulement 1 CLIP_REGEN ECHEC (seuil de 2 non atteint)', () => {
    const history: RepairHistoryEntry[] = [
      { criterion: 'productConsistency', sceneId: 'shot-1', strategy: 'CLIP_REGEN', scoreDelta: -2, outcome: 'ECHEC' },
    ];
    expect(classifyRootCause('productConsistency', { sceneRef: 'shot-1', history })).toBe('SCENE');
  });

  it("n'escalade pas PRODUCT_FIDELITY sur les ECHEC d'une AUTRE scène", () => {
    const history: RepairHistoryEntry[] = [
      { criterion: 'productConsistency', sceneId: 'shot-2', strategy: 'CLIP_REGEN', scoreDelta: -2, outcome: 'ECHEC' },
      { criterion: 'productConsistency', sceneId: 'shot-2', strategy: 'CLIP_REGEN', scoreDelta: -1, outcome: 'ECHEC' },
    ];
    expect(classifyRootCause('productConsistency', { sceneRef: 'shot-1', history })).toBe('SCENE');
  });

  it('classe productVisibility comme SCENE (même règle que productConsistency)', () => {
    expect(classifyRootCause('productVisibility', { sceneRef: 'shot-1', history: [] })).toBe('SCENE');
  });

  it('classe factualConsistency comme CONCEPT', () => {
    expect(classifyRootCause('factualConsistency', { history: [] })).toBe('CONCEPT');
  });

  it('classe brandCoherence comme BRAND', () => {
    expect(classifyRootCause('brandCoherence', { history: [] })).toBe('BRAND');
  });

  it('classe audioQuality, voiceAudibility et ctaClarity comme AUDIO', () => {
    expect(classifyRootCause('audioQuality', { history: [] })).toBe('AUDIO');
    expect(classifyRootCause('voiceAudibility', { history: [] })).toBe('AUDIO');
    expect(classifyRootCause('ctaClarity', { history: [] })).toBe('AUDIO');
  });

  it('classe formatCompliance comme VISUAL_COMPOSITION (Mission 4 Phase G — mesure réelle désormais, plus le rubber-stamp ASSEMBLY)', () => {
    expect(classifyRootCause('formatCompliance', { history: [] })).toBe('VISUAL_COMPOSITION');
  });

  it('classe motionDynamism comme UNKNOWN (aucun mapping déterministe)', () => {
    expect(classifyRootCause('motionDynamism', { history: [] })).toBe('UNKNOWN');
  });

  it('Mission 4 Phase G — classe pacing, textReadability, grammar comme SUBTITLE (gap réel confirmé par l\'audit : ils mappent déjà tous les trois sur SUBTITLE_ONLY dans repair-dispatch.ts, mais retombaient sur UNKNOWN faute de root-cause)', () => {
    expect(classifyRootCause('pacing', { history: [] })).toBe('SUBTITLE');
    expect(classifyRootCause('textReadability', { history: [] })).toBe('SUBTITLE');
    expect(classifyRootCause('grammar', { history: [] })).toBe('SUBTITLE');
  });

  it('Mission 4 Phase G — classe voiceDynamism et voicePacing comme VOICE', () => {
    expect(classifyRootCause('voiceDynamism', { history: [] })).toBe('VOICE');
    expect(classifyRootCause('voicePacing', { history: [] })).toBe('VOICE');
  });

  it('Mission 4 Phase G — classe visualComposition et sceneConsistency comme VISUAL_COMPOSITION (même root cause que formatCompliance, gates de réparation distincts par ailleurs)', () => {
    expect(classifyRootCause('visualComposition', { history: [] })).toBe('VISUAL_COMPOSITION');
    expect(classifyRootCause('sceneConsistency', { history: [] })).toBe('VISUAL_COMPOSITION');
  });

  // Mission 3 (validation empirique, 2026-08-20) — REJEU de données réelles : les 3 campagnes
  // historiques REPAIR_EXHAUSTED (base de données, avant ce fix) montraient TOUTES le même
  // schéma : 9 critères texte simultanément marqués UNAVAILABLE_DEFECT dans le MÊME jugement, aux
  // côtés de vrais scores visuels élevés (92-100). Fixture reprenant EXACTEMENT ce schéma
  // (campagne c29f0982, tentative 1).
  describe('Mission 3 — détection PROVIDER (échec de l\'appel Judge groupé, rejeu de données réelles)', () => {
    const REAL_HISTORICAL_CRITERIA: JudgeCriterionResult[] = [
      { name: 'productConsistency', score: 92, justification: 'x' },
      { name: 'motionDynamism', score: 100, justification: 'x' },
      { name: 'audioQuality', score: 49, justification: 'x', defect: 'Le mixage final ne converge pas vers le niveau sonore cible' },
      { name: 'voiceAudibility', score: 90, justification: 'x' },
      { name: 'productVisibility', score: 94, justification: 'x' },
      { name: 'formatCompliance', score: 100, justification: 'x' },
      { name: 'storytelling', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
      { name: 'hookStrength', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
      { name: 'pacing', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
      { name: 'textReadability', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
      { name: 'grammar', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
      { name: 'ctaClarity', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
      { name: 'brandCoherence', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
      { name: 'factualConsistency', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
      { name: 'advertisingEffectiveness', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
    ];

    it('classe PROVIDER pour un critère UNAVAILABLE_DEFECT du groupe (storytelling), même si ambigu STORYBOARD/CONCEPT par défaut', () => {
      expect(classifyRootCause('storytelling', { history: [], allCriteria: REAL_HISTORICAL_CRITERIA })).toBe('PROVIDER');
    });

    it('classe PROVIDER même pour le défaut RÉEL et prioritaire (audioQuality) qui coexiste dans le même jugement', () => {
      // audioQuality est un vrai défaut (pas UNAVAILABLE_DEFECT) et serait normalement classé
      // AUDIO — mais la majorité du jugement signale un Judge défaillant : toute réparation
      // serait prématurée tant que le contenu réel n'a pas été mesuré correctement.
      expect(classifyRootCause('audioQuality', { history: [], allCriteria: REAL_HISTORICAL_CRITERIA })).toBe('PROVIDER');
    });

    it("sans allCriteria (comportement historique), le même critère reste classé normalement (non-régression)", () => {
      expect(classifyRootCause('storytelling', { history: [] })).toBe('STORYBOARD');
      expect(classifyRootCause('audioQuality', { history: [] })).toBe('AUDIO');
    });

    it('ne déclenche PAS PROVIDER si seulement une minorité de critères sont UNAVAILABLE_DEFECT (1 seul, pas un échec de l\'appel groupé)', () => {
      const partial: JudgeCriterionResult[] = [
        { name: 'productConsistency', score: 92, justification: 'x' },
        { name: 'storytelling', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT },
        { name: 'hookStrength', score: 80, justification: 'x' },
        { name: 'pacing', score: 75, justification: 'x' },
      ];
      expect(classifyRootCause('storytelling', { history: [], allCriteria: partial })).toBe('STORYBOARD');
    });
  });
});
