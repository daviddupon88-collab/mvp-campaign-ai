// P1.4 — Source Model (chantier "Product Intelligence & Creative Intelligence Engine V2",
// 2026-08-18). Provenance de chaque information — indépendant du fournisseur (Mock aujourd'hui,
// un vrai WebResearchProvider demain, cf. web-research-provider.interface.ts).
export enum SourceType {
  OFFICIAL = 'OFFICIAL',
  MANUFACTURER = 'MANUFACTURER',
  AUTHORIZED_RETAILER = 'AUTHORIZED_RETAILER',
  RETAILER = 'RETAILER',
  MARKETPLACE = 'MARKETPLACE',
  REVIEW = 'REVIEW',
  SOCIAL = 'SOCIAL',
  OTHER = 'OTHER',
  // Réservé aux données produites par MockWebResearchProvider — ne doit JAMAIS apparaître pour
  // une donnée présentée comme réelle (cf. FactVerificationService, WebResearchService).
  MOCK = 'MOCK',
}

// Hiérarchie de confiance (priorité de TRI, pas un score fixe) — cf. FactVerificationService,
// qui retient la source la mieux classée en cas de désaccord entre plusieurs sources.
export const SOURCE_TYPE_PRIORITY: SourceType[] = [
  SourceType.OFFICIAL,
  SourceType.MANUFACTURER,
  SourceType.AUTHORIZED_RETAILER,
  SourceType.RETAILER,
  SourceType.MARKETPLACE,
  SourceType.REVIEW,
  SourceType.SOCIAL,
  SourceType.OTHER,
  SourceType.MOCK,
];

export enum FactVerificationStatus {
  VERIFIED = 'VERIFIED',
  PROBABLE = 'PROBABLE',
  UNVERIFIED = 'UNVERIFIED',
  CONTRADICTED = 'CONTRADICTED',
  UNKNOWN = 'UNKNOWN',
}

export interface Claim {
  claim: string;
  source: string;
  sourceType: SourceType;
  confidence: number; // 0-1
  verified: boolean;
  retrievedAt: Date;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  sourceType: SourceType;
}

export interface FetchedPage {
  url: string;
  html: string;
  fetchedAt: Date;
}

export interface RawClaim {
  claim: string;
  context: string;
}

export interface ExtractedContent {
  url: string;
  text: string;
  claims: RawClaim[];
}

// Résultat renvoyé par WebResearchService.researchProduct — le statut EST la garantie
// anti-faux-succès : NOT_CONFIGURED tant qu'aucun vrai fournisseur n'est branché, jamais SUCCESS
// pour une recherche qui n'a pas réellement été exécutée (règle absolue du brief).
export type WebResearchOutcome =
  | { status: 'NOT_CONFIGURED' }
  | { status: 'MOCK'; results: WebSearchResult[] }
  | { status: 'REAL'; results: WebSearchResult[] };
