import { ProductClaim } from '../product-fact.types';

// Mission 4.4 (Product URL Intelligence, Phase E) — forme demandée par le brief, verbatim, avec
// ProductClaim/ProductSpecification réellement typés (pas un stub) dès la 1ère version.
export interface ProductSpecification {
  key: string;
  value: string;
  unit?: string;
}

export type ProductUrlExtractionMethod = 'JSON_LD' | 'OPENGRAPH' | 'HTML' | 'LLM' | 'MIXED';

export interface ProductUrlFacts {
  sourceUrl: string;
  title?: string;
  brand?: string;
  category?: string;
  description?: string;
  specifications: ProductSpecification[];
  claims: ProductClaim[];
  images: string[];
  price?: { amount: number; currency: string };
  availability?: string;
  extractionMethod: ProductUrlExtractionMethod;
  warnings: string[];
  // Mission 4.5 (Phase 1 — instrumentation) — additif, tous optionnels : permet de mesurer
  // séparément ce qui était auparavant seulement résumé dans extractionMethod (un seul tag,
  // jamais de compte par palier). Absent pour les ProductUrlFacts construits avant ce chantier
  // ou par des chemins qui ne les renseignent pas (ex. emptyUrlFacts) — jamais une valeur
  // inventée à 0 qui laisserait croire à une mesure réelle.
  jsonLdFactCount?: number;
  openGraphFactCount?: number;
  htmlFactCount?: number;
  fetchDurationMs?: number;
  redirectCount?: number;
  cacheHit?: boolean;
  llmFallbackDurationMs?: number;
}
