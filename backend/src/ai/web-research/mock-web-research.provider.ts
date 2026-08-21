import { Injectable } from '@nestjs/common';
import { WebResearchProvider } from './web-research-provider.interface';
import { WebSearchResult, FetchedPage, ExtractedContent, SourceType } from './web-research.types';

// P1.3 — Mock Web Research Provider. DEVELOPMENT/TESTING ONLY — cf. règle absolue du brief :
// "un mock ne doit jamais être présenté comme une recherche Web réelle en production". Ce
// provider n'est enregistré nulle part comme le "vrai" fournisseur de WebResearchService (cf.
// web-research.service.ts, le slot réel reste vide en production) — il n'est instancié
// explicitement que par les tests, jamais par le câblage de production (AiModule).
//
// Toutes les valeurs renvoyées sont préfixées/étiquetées "[MOCK]" ou sourceType: MOCK, pour
// qu'aucune confusion ne soit possible même si ce provider était accidentellement injecté quelque
// part — un signal visible partout dans la donnée elle-même, pas seulement dans son nom de classe.
@Injectable()
export class MockWebResearchProvider implements WebResearchProvider {
  readonly name = 'mock';
  readonly isMock = true;

  async search(query: string): Promise<WebSearchResult[]> {
    return [
      { title: `[MOCK] Résultat officiel pour "${query}"`, url: 'https://mock.local/official-result', snippet: '[MOCK] Extrait simulé — donnée de test, pas une recherche réelle.', sourceType: SourceType.MOCK },
      { title: `[MOCK] Résultat retailer pour "${query}"`, url: 'https://mock.local/retailer-result', snippet: '[MOCK] Extrait simulé — donnée de test, pas une recherche réelle.', sourceType: SourceType.MOCK },
    ];
  }

  async fetch(url: string): Promise<FetchedPage> {
    return { url, html: '<html><body>[MOCK CONTENT] — page simulée, jamais récupérée réellement sur le web.</body></html>', fetchedAt: new Date() };
  }

  async extract(page: FetchedPage): Promise<ExtractedContent> {
    return {
      url: page.url,
      text: '[MOCK EXTRACTED TEXT] — contenu simulé.',
      claims: [{ claim: '[MOCK CLAIM] Autonomie de 12h', context: '[MOCK] extrait de contexte simulé' }],
    };
  }
}
