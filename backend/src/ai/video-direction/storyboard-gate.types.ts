// Phase H — Storyboard Gate (chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 46-53). Valide que le Shot Plan traduit réellement le concept en
// séquence visuelle exploitable AVANT toute génération vidéo (150 crédits/plan).
export type StoryboardGateStatus = 'APPROVED' | 'REJECT';

export interface StoryboardGateResult {
  status: StoryboardGateStatus;
  score: number; // 0-100
  // sceneId des plans recommandés pour suppression (fonction narrative non essentielle,
  // spec Sections 47-48) — l'orchestrateur applique un garde-fou déterministe avant d'élaguer.
  scenesToRemove: string[];
  faiblesses: string[];
  recommandation: string;
}
