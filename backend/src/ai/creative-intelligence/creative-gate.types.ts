// Phase G — Creative Gate (chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 35-45). Valide que le Creative Concept constitue réellement une
// PUBLICITÉ exploitable AVANT tout Shot Plan/génération vidéo — jamais un succès automatique
// parce qu'un concept a été produit par le LLM.
export type CreativeGateStatus = 'APPROVED' | 'REVISE' | 'BLOCKED';

export interface CreativeGateResult {
  status: CreativeGateStatus;
  score: number; // 0-100, uniquement pertinent si status !== 'BLOCKED'
  hook: string;
  promessePrincipale: string;
  benefices: string[];
  preuve: string;
  cta: string;
  forces: string[];
  faiblesses: string[];
  risques: string[];
  causesDeRejet: string[];
  recommandation: string;
}
