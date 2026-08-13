import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

// FONDATION POUR UNE PHASE ULTÉRIEURE — AUCUNE AUTOMATISATION N'EST EXÉCUTÉE PAR CE SERVICE
// AUJOURD'HUI. Ce chantier ("recommandations mesurables PUIS, plus tard, des
// automatisations contrôlées") livre volontairement les deux prérequis sans encore activer
// le second :
//  1) mesurable — cf. OptimizerOutcomeService, qui ferme la boucle avant/après.
//  2) automatisation contrôlée — ce service pose l'interface et les garde-fous attendus,
//     désactivé via ENABLE_CONTROLLED_AUTOMATION (absent = false partout).
//
// Quand cette phase sera activée, les garde-fous suivants resteront non négociables :
//   - une organisation doit explicitement opter in (pas d'activation globale silencieuse) ;
//   - seules les recommandations `automationEligible=true` sont concernées (cf. plan-catalog
//     des types d'action sûrs dans AiOptimizerService) ;
//   - chaque exécution automatique doit rester journalisée et réversible ;
//   - l'exécution doit elle-même passer par les adaptateurs SocialAdapter existants (jamais
//     un appel direct à une API tierce en dehors du chemin déjà audité par ce backend).
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('ENABLE_CONTROLLED_AUTOMATION', 'false') === 'true';
  }

  // Point d'entrée qui sera appelé une fois la phase activée — aujourd'hui, refuse
  // systématiquement, pour qu'aucun appel ne puisse accidentellement déclencher une action
  // réelle avant que cette fonctionnalité soit délibérément construite et testée.
  async executeAutomatically(_recommendationId: string): Promise<never> {
    if (!this.isEnabled()) {
      throw new ForbiddenException(
        "L'automatisation contrôlée n'est pas encore activée sur cette instance (ENABLE_CONTROLLED_AUTOMATION=false). " +
          'Cette fonctionnalité est prévue pour une phase ultérieure — cf. AutomationService.',
      );
    }
    // Non atteint dans cette version : l'implémentation réelle (exécution via les
    // SocialAdapter existants, journalisation, réversibilité) reste à construire.
    throw new Error('Non implémenté');
  }

  // Utilisé par le frontend pour afficher (ou non) une action "Automatiser" sur une
  // recommandation — reste informatif tant que isEnabled() est faux.
  async listAutomationEligible(organizationId: string) {
    return this.prisma.optimizationRecommendation.findMany({
      where: { organizationId, automationEligible: true, status: 'PENDING' },
    });
  }
}
