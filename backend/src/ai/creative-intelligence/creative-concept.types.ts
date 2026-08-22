// P0.2 — Creative Concept (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Transforme la Creative Intelligence (P0.1) en une vraie IDÉE publicitaire —
// pas une description du produit. Le concept doit démontrer, pas énumérer.
export interface CreativeConcept {
  title: string;
  concept: string;
  coreMessage: string;
  hook: string;
  emotionalDirection: string;
  visualDirection: string;
  storytellingApproach: string;
  proofStrategy: string;
  cta: string;
  targetAudience: string;
  duration: number; // secondes, cible
  // '9:16' uniquement — formats multiples hors périmètre de ce chantier (décision explicite).
  format: '9:16';
  // Pilote directement le nombre de plans du Shot Plan (P0.3) — cadré [2,5] au parsing.
  scenesCount: number;
  // Mission 4.3 (Goal-First Quality Architecture, Phase 2) — preuve VÉRIFIABLE que ce concept a
  // été construit pour satisfaire le QualityTarget, jamais une note auto-attribuée (brief : "Ne
  // pas demander à l'IA de simplement attribuer une note élevée à son propre concept").
  qualityAlignment: string;
  raw: string;
}
