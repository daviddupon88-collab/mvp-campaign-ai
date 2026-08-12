import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BrandMemoryCategory, BrandMemoryStatus, BrandMemoryType } from '@prisma/client';
import { UpsertBrandKitDto } from './dto/brand-kit.dto';

export interface ListMemoryFilters {
  limit?: number;
  type?: BrandMemoryType;
  category?: BrandMemoryCategory;
  channel?: string;
  persona?: string;
  status?: BrandMemoryStatus;
}

// Module 2 — Brand Intelligence, devenu Brand Brain : deux natures de données bien
// distinctes cohabitent ici.
//  - BrandKit : la charte déclarée, éditée manuellement (ton, palette, mission, personas...).
//  - BrandMemoryEntry : ce que la marque a appris au fil du temps, alimenté automatiquement
//    (cf. PublishingService, AiOptimizerService, ContentStudioService via
//    BrandLearningService) — l'injection réelle dans les prompts de génération se fait
//    désormais via BrandContextBuilderService (cf. Lot D), pas ici.
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

  // V1 — encore utilisé par PublishingService (pas encore migré vers
  // BrandLearningService.recordObservation() comme AiOptimizerService l'a été au Lot D) ;
  // conservé tel quel pour ne rien casser. Migration vers le moteur de confiance = limitation
  // connue à traiter dans un lot ultérieur, cf. rapport d'audit.
  async logMemory(organizationId: string, type: 'CAMPAIGN_LEARNING' | 'COMPETITOR_NOTE' | 'PERFORMANCE_INSIGHT', content: string, sourceCampaignId?: string) {
    return this.prisma.brandMemoryEntry.create({
      data: { organizationId, type: type as any, content, sourceCampaignId },
    });
  }

  // Journal de mémoire du Brand Brain — consulté par les équipes marketing pour comprendre
  // pourquoi une génération a pris telle orientation. Filtres optionnels (Phase 13 :
  // "consulter") ; sans filtre de statut, tous statuts confondus (comportement historique).
  async listMemory(organizationId: string, filters: ListMemoryFilters = {}) {
    return this.prisma.brandMemoryEntry.findMany({
      where: {
        organizationId,
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.channel ? { channel: filters.channel } : {}),
        ...(filters.persona ? { persona: filters.persona } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      orderBy: { lastObservedAt: 'desc' },
      take: filters.limit ?? 20,
    });
  }

  // Règles de marque actives (Phase 11/22) — vue dédiée, distincte de listMemory() : une
  // RULE a un statut particulier (contrainte non négociable) que l'UI et l'API traitent
  // séparément des simples apprentissages/insights.
  async listRules(organizationId: string) {
    return this.prisma.brandMemoryEntry.findMany({
      where: { organizationId, type: 'RULE', status: 'ACTIVE' },
      orderBy: { confidenceScore: 'desc' },
    });
  }
}
