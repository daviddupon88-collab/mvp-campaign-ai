import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertBrandKitDto } from './dto/brand-kit.dto';

// Module 2 — Brand Intelligence, devenu Brand Brain : deux natures de données bien
// distinctes cohabitent ici.
//  - BrandKit : la charte déclarée, éditée manuellement (ton, palette, mission, personas...).
//  - BrandMemoryEntry : ce que la marque a appris au fil du temps, alimenté automatiquement
//    (cf. logMemory, appelé à la publication d'une campagne et sur les recommandations
//    Optimizer notables) — c'est cette seconde partie qui transforme un simple formulaire
//    de charte graphique en mémoire qui s'enrichit réellement.
@Injectable()
export class BrandService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string) {
    return this.prisma.brandKit.findUnique({ where: { organizationId } });
  }

  async upsert(organizationId: string, dto: UpsertBrandKitDto) {
    return this.prisma.brandKit.upsert({
      where: { organizationId },
      create: { organizationId, ...dto } as any,
      update: { ...dto } as any,
    });
  }

  // Journalise un apprentissage — jamais appelé directement par l'utilisateur, mais par les
  // points d'intégration du cycle de vie d'une campagne (cf. PublishingService, AiOptimizerService).
  async logMemory(organizationId: string, type: 'CAMPAIGN_LEARNING' | 'COMPETITOR_NOTE' | 'PERFORMANCE_INSIGHT', content: string, sourceCampaignId?: string) {
    return this.prisma.brandMemoryEntry.create({
      data: { organizationId, type: type as any, content, sourceCampaignId },
    });
  }

  async listMemory(organizationId: string, limit = 20) {
    return this.prisma.brandMemoryEntry.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // Construit le bloc de contexte textuel injecté dans les prompts IA (Orchestrator,
  // Modération, Cohérence de marque) — considérablement enrichi par rapport à la version
  // initiale (ton + valeurs uniquement) : mission, vision, slogans, concurrents, personas
  // de référence, ET les derniers apprentissages mémorisés. C'est ce contexte qui fait
  // qu'une génération "sait" ce que la marque est et ce qui a déjà été appris d'elle,
  // plutôt que de repartir de zéro à chaque campagne.
  async buildPromptContext(organizationId: string): Promise<string> {
    const kit = await this.get(organizationId);
    if (!kit) return '';

    const recentMemory = await this.listMemory(organizationId, 5);

    const sections = [
      kit.mission ? `Mission : ${kit.mission}` : null,
      kit.vision ? `Vision : ${kit.vision}` : null,
      kit.toneOfVoice ? `Ton éditorial : ${kit.toneOfVoice}` : null,
      kit.valueProps ? `Arguments clés : ${JSON.stringify(kit.valueProps)}` : null,
      kit.slogans ? `Slogans existants : ${JSON.stringify(kit.slogans)}` : null,
      kit.competitors ? `Concurrents connus : ${JSON.stringify(kit.competitors)}` : null,
      kit.personaNotes ? `Personas de référence : ${JSON.stringify(kit.personaNotes)}` : null,
      recentMemory.length > 0
        ? `Apprentissages des campagnes précédentes :\n${recentMemory.map((m) => `- ${m.content}`).join('\n')}`
        : null,
    ];

    return sections.filter(Boolean).join('\n');
  }
}
