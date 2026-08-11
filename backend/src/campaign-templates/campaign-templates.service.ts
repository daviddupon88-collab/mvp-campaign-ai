import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SEED_TEMPLATES } from './seed-templates';
import { CreateTemplateDto } from './dto/create-template.dto';

// Module 18 — Marketplace, version simplifiée : une bibliothèque de templates réutilisables,
// sans commission ni vente entre organisations pour l'instant (cf. roadmap). Deux origines :
//  - isSystem=true : fournis par Campaign-ai, seedés au démarrage, visibles par tous.
//  - organizationId renseigné : créés par un client à partir d'une de ses campagnes,
//    visibles uniquement par son organisation (pas encore de partage inter-organisation —
//    prochaine étape naturelle vers un vrai marketplace avec commission).
@Injectable()
export class CampaignTemplatesService implements OnModuleInit {
  private readonly logger = new Logger(CampaignTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Seed idempotent : ne recrée pas les templates système s'ils existent déjà (basé sur le nom).
  async onModuleInit() {
    const existingCount = await this.prisma.campaignTemplate.count({ where: { isSystem: true } });
    if (existingCount >= SEED_TEMPLATES.length) return;

    for (const template of SEED_TEMPLATES) {
      await this.prisma.campaignTemplate.upsert({
        where: { id: this.systemTemplateId(template.name) },
        create: {
          id: this.systemTemplateId(template.name),
          name: template.name,
          sector: template.sector as any,
          description: template.description,
          defaultObjective: template.defaultObjective,
          defaultChannels: template.defaultChannels,
          toneHint: template.toneHint,
          structureHint: template.structureHint as any,
          isSystem: true,
        },
        update: {}, // ne pas écraser un template déjà personnalisé par une migration manuelle future
      });
    }
    this.logger.log(`${SEED_TEMPLATES.length} templates système initialisés`);
  }

  // ID déterministe basé sur le nom, pour que le seed soit idempotent sans dépendre
  // d'un ordre d'exécution ni d'une table de migration séparée.
  private systemTemplateId(name: string): string {
    const slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-');
    return `system-template-${slug}`;
  }

  // Visible : tous les templates système + les templates propres à l'organisation.
  async list(organizationId: string, sector?: string) {
    return this.prisma.campaignTemplate.findMany({
      where: {
        OR: [{ isSystem: true }, { organizationId }],
        ...(sector ? { sector: sector as any } : {}),
      },
      orderBy: [{ isSystem: 'desc' }, { usageCount: 'desc' }],
    });
  }

  async getById(organizationId: string, id: string) {
    const template = await this.prisma.campaignTemplate.findFirst({
      where: { id, OR: [{ isSystem: true }, { organizationId }] },
    });
    if (!template) throw new NotFoundException('Template introuvable');
    return template;
  }

  async create(organizationId: string, dto: CreateTemplateDto) {
    return this.prisma.campaignTemplate.create({
      data: {
        organizationId,
        name: dto.name,
        sector: dto.sector as any,
        description: dto.description,
        defaultObjective: dto.defaultObjective,
        defaultChannels: dto.defaultChannels,
        toneHint: dto.toneHint,
        structureHint: dto.structureHint as any,
        isSystem: false,
      },
    });
  }

  // Sauvegarde une campagne existante comme template réutilisable — le geste produit
  // le plus naturel pour peupler la bibliothèque ("cette campagne a bien marché, j'en refais
  // le moule"), sans passer par un formulaire de création à vide.
  async createFromCampaign(organizationId: string, campaignId: string, name: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, organizationId } });
    if (!campaign) throw new NotFoundException('Campagne introuvable');

    return this.prisma.campaignTemplate.create({
      data: {
        organizationId,
        name,
        sector: 'GENERAL',
        description: `Créé à partir de la campagne "${campaign.name}"`,
        defaultObjective: campaign.objective,
        defaultChannels: campaign.channels ?? undefined,
        isSystem: false,
      },
    });
  }

  async incrementUsage(id: string) {
    await this.prisma.campaignTemplate.update({ where: { id }, data: { usageCount: { increment: 1 } } });
  }
}
