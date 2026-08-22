// Phase H — Storyboard Gate (chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 46-53). Valide que le Shot Plan traduit réellement le concept en
// séquence visuelle exploitable AVANT toute génération vidéo (150 crédits/plan).
export type StoryboardGateStatus = 'APPROVED' | 'REJECT';

// Mission 4.3 (Goal-First Quality Architecture, Phase 5b, Étape 8) — taxonomie de cause racine
// PRÉ-vidéo, distincte des 12 catégories post-vidéo de root-cause.ts (qui classifient un défaut
// mesuré sur une vidéo déjà générée). Un plancher critique violé ou un score insuffisant à ce
// stade se rattache à l'une de ces 7 catégories, jamais laissée au libre texte du LLM quand elle
// découle d'une décision déterministe (cf. applyCriticalFloor dans storyboard-gate.service.ts).
export type GoalFirstRootCause = 'SHOT' | 'NARRATIVE' | 'CONCEPT' | 'PRODUCT' | 'EXECUTION' | 'BRAND' | 'TECHNICAL';

export interface StoryboardGateResult {
  // Dérivé de readyForGeneration — conservé pour compatibilité avec les consommateurs existants
  // (applySafePruning, la boucle de régénération unique de AiOrchestratorService).
  status: StoryboardGateStatus;
  score: number; // 0-100
  // sceneId des plans recommandés pour suppression (fonction narrative non essentielle,
  // spec Sections 47-48) — l'orchestrateur applique un garde-fou déterministe avant d'élaguer.
  scenesToRemove: string[];
  faiblesses: string[];
  recommandation: string;
  // Mission 4.3 Phase 5b — PreProductionQualityJudge (Étape 8) fusionné dans cette porte : ce
  // gate voit désormais le NarrativeBlueprint, les VideoGenerationInstruction compilées (ce que
  // Veo recevra réellement) et le Product Intelligence Profile, plus seulement le concept brut et
  // le Shot Plan JSON.
  criterionScores: Record<string, number>; // un par critère de STORYBOARD_STAGE_CRITERIA
  // Assemblé en CODE (score insuffisant / plancher critique violé) — jamais du texte LLM brut
  // recopié tel quel, même discipline que UNAVAILABLE_DEFECT dans video-judge.service.ts.
  blockingDefects: string[];
  risks: string[];
  requiredChanges: string[];
  // null quand readyForGeneration=true. Décidé DÉTERMINISTIQUEMENT (jamais lu depuis le LLM)
  // quand le plancher critique est violé ; sinon, celui rapporté par le LLM lors d'un rejet
  // "normal" (score insuffisant sans violation de plancher).
  rootCauseLevel: GoalFirstRootCause | null;
  readyForGeneration: boolean;
}
