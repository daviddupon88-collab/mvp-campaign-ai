import { WebSearchResult, FetchedPage, ExtractedContent } from './web-research.types';

// P1.1 — WebResearchProvider (chantier "Product Intelligence & Creative Intelligence Engine V2",
// 2026-08-18). Abstraction indépendante du fournisseur — permet d'intégrer ultérieurement
// n'importe quel fournisseur de recherche web sans modifier WebResearchService ni le reste de
// Campaign-ai. Même principe que AiProvider (backend/src/ai/ai-gateway/providers/
// ai-provider.interface.ts) pour les fournisseurs IA existants.
//
// P1.2 — RÈGLE ABSOLUE : aucun fournisseur réel n'est sélectionné/intégré dans ce chantier.
// Aucune clé API, aucune URL, aucun package npm de recherche n'est ajouté. Le seul provider
// enregistré (MockWebResearchProvider) est explicitement development/testing only — cf.
// mock-web-research.provider.ts — et n'est JAMAIS injecté comme provider "réel" dans
// WebResearchService (cf. web-research.service.ts).
export interface WebResearchProvider {
  readonly name: string;
  // true UNIQUEMENT pour un provider de test/développement — jamais true pour un vrai
  // fournisseur. WebResearchService s'appuie sur ce champ pour ne jamais confondre une
  // recherche simulée avec une recherche réelle.
  readonly isMock: boolean;
  search(query: string): Promise<WebSearchResult[]>;
  fetch(url: string): Promise<FetchedPage>;
  extract(page: FetchedPage): Promise<ExtractedContent>;
}
