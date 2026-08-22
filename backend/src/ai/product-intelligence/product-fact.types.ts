// Mission 4.4 (Product URL Intelligence, Phase C/F) — provenance obligatoire pour toute
// information produit consommée par le pipeline créatif, quelle que soit sa source (photo, URL,
// texte utilisateur, inférence). Distinct de web-research.types.ts::SourceType (qui classe la
// FIABILITÉ d'une source web — OFFICIAL/RETAILER/REVIEW/...) : cet axe classe la MODALITÉ
// d'entrée. Les deux coexistent sans collision (ex. un ProductFact source='PRODUCT_URL' peut être
// lui-même dérivé d'un Claim sourceType='MANUFACTURER').
export type ProductFactSource = 'USER' | 'PRODUCT_URL' | 'IMAGE' | 'INFERENCE';

// "L'information ne doit jamais devenir un simple '750 ml' sans provenance" (brief, Phase F).
export interface ProductFact {
  key: string;
  value: string;
  source: ProductFactSource;
  confidence: number; // 0-1
  evidence?: string;
}

// Registre des affirmations publicitaires (brief, Phase G). Une inférence LLM ne devient JAMAIS
// automatiquement un fait produit : allowedForAdvertising est calculé déterministiquement
// (product-page-claim-builder.ts), jamais auto-déclaré par le LLM lui-même.
export interface ProductClaim {
  id: string;
  text: string;
  source: ProductFactSource;
  evidence: string;
  confidence: number; // 0-1
  allowedForAdvertising: boolean;
}

// Détection de contradiction inter-sources (brief, Phase J) — ne supprime JAMAIS silencieusement
// une source en désaccord ; UNRESOLVED devient un signal de qualité exploitable par
// PreFlightQualityGate/StoryboardGateService, jamais un simple repli discret sur une valeur.
export type ProductFactConflictResolution = 'URL_PREFERRED' | 'IMAGE_PREFERRED' | 'USER_PREFERRED' | 'UNRESOLVED';

export interface ProductFactConflict {
  attribute: string;
  sources: Array<{ source: ProductFactSource; value: string; confidence: number }>;
  resolution: ProductFactConflictResolution;
  reason: string;
}
