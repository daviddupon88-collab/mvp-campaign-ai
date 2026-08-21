import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WebResearchProvider } from './web-research-provider.interface';
import { WebResearchOutcome, SOURCE_TYPE_PRIORITY } from './web-research.types';

export const WEB_RESEARCH_REAL_PROVIDER = 'WEB_RESEARCH_REAL_PROVIDER';

// P1.6 — WebResearchService (chantier "Product Intelligence & Creative Intelligence Engine V2",
// 2026-08-18). Garde-fou anti-faux-succès, RÈGLE ABSOLUE du brief : "ne jamais retourner SUCCESS
// pour une recherche Web qui n'a pas réellement été exécutée".
//
// `provider` reste TOUJOURS undefined en production tant qu'aucun vrai fournisseur n'est
// sélectionné/validé — AiModule n'enregistre et ne lie JAMAIS le token WEB_RESEARCH_REAL_PROVIDER
// à quoi que ce soit (cf. ai.module.ts). Le statut renvoyé distingue explicitement :
//   - NOT_CONFIGURED : aucun provider injecté (l'état réel de production aujourd'hui).
//   - MOCK           : un provider avec isMock=true a été injecté (uniquement possible en test —
//                      les tests construisent ce service eux-mêmes avec MockWebResearchProvider).
//   - REAL           : un provider avec isMock=false a été injecté (inatteignable tant qu'aucun
//                      vrai fournisseur n'est branché — personne ne lie ce token aujourd'hui).
// Le statut n'est donc jamais un simple "ça a marché" — il documente la NATURE de la donnée.
@Injectable()
export class WebResearchService {
  private readonly logger = new Logger(WebResearchService.name);

  constructor(@Optional() @Inject(WEB_RESEARCH_REAL_PROVIDER) private readonly provider?: WebResearchProvider) {}

  async researchProduct(query: string): Promise<WebResearchOutcome> {
    if (!this.provider) {
      this.logger.warn('REAL WEB PROVIDER: NOT CONFIGURED — recherche web ignorée, le Product Intelligence Profile sera construit sans données web.');
      return { status: 'NOT_CONFIGURED' };
    }

    // Pipeline réel : search -> fetch -> extract par résultat, puis classement par priorité de
    // source (cf. SOURCE_TYPE_PRIORITY) — même chemin, que le provider soit Mock (tests) ou réel
    // (aucun changement de code requis au branchement d'un vrai fournisseur, cf. P1.5).
    const rawResults = await this.provider.search(query);
    for (const result of rawResults) {
      const page = await this.provider.fetch(result.url);
      await this.provider.extract(page);
    }

    const results = [...rawResults].sort((a, b) => this.priorityIndex(a.sourceType) - this.priorityIndex(b.sourceType));

    return { status: this.provider.isMock ? 'MOCK' : 'REAL', results };
  }

  private priorityIndex(sourceType: string): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const index = SOURCE_TYPE_PRIORITY.indexOf(sourceType as any);
    return index === -1 ? SOURCE_TYPE_PRIORITY.length : index;
  }
}
