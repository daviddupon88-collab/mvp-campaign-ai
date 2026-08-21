// Types partagés du chantier Product Intelligence (2026-08-18). Séparé de visual-dna.service.ts
// (../video-direction/) : ce dernier reste le schéma ÉTROIT dédié à la fidélité vidéo (Shot
// Plan), inchangé. Ici : le schéma RICHE (17 champs) qui alimente le ProductIntelligenceProfile,
// utilisé pour le grounding de TOUTE génération publicitaire (texte/image/vidéo), pas seulement
// la vérification de fidélité d'un plan vidéo généré. Chevauchement conceptuel assumé — cf. plan.
export interface ProductVisionAnalysis {
  category: string | null;
  subcategory: string | null;
  productType: string | null;
  brand: string | null;
  productName: string | null;
  model: string | null;
  // Couvre "texte visible" ET "OCR" du brief — même mécanisme (lecture vision d'un texte
  // imprimé sur le produit/packaging), pas deux étapes séparées qui dupliqueraient l'appel IA.
  visibleText: string[];
  logoDetected: boolean;
  packaging: string | null;
  colors: string[];
  materials: string[];
  shape: string | null;
  visualAttributes: string[];
  distinctiveFeatures: string[];
  // Affirmations écrites SUR le produit/packaging tel quel ("sans sulfate", "12h d'autonomie"...)
  // — simplement TRANSCRITES ici, jamais vérifiées : la vérification est le rôle du Fact
  // Verification (P1.5), pas de la vision. Ne jamais traiter ces valeurs comme des faits confirmés.
  visibleClaims: string[];
  identificationClues: string[];
  confidence: number; // 0-1
  raw: string; // réponse brute conservée pour debug/repli, même convention que VisualDnaService
}

export interface ProductIdentificationCandidate {
  name: string;
  brand: string | null;
  model: string | null;
  matchScore: number; // 0-1
  reason: string;
}

// CONFIRMED/PROBABLE/UNCERTAIN/UNKNOWN — jamais auto-déclaré par le LLM, toujours dérivé
// déterministiquement du meilleur matchScore (cf. ProductIdentificationService.deriveConfidenceLevel).
export type IdentificationConfidenceLevel = 'CONFIRMED' | 'PROBABLE' | 'UNCERTAIN' | 'UNKNOWN';

export interface ProductIdentificationResult {
  candidates: ProductIdentificationCandidate[];
  bestMatch: string | null;
  confidenceLevel: IdentificationConfidenceLevel;
  confidence: number; // 0-1, = matchScore du meilleur candidat (0 si aucun)
}
