import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsIngestionService } from '../optimizer/analytics-ingestion.service';

// Point d'accès unifié aux statistiques — distinct d'AiEconomicsService (qui suit le coût
// des appels aux fournisseurs d'IA) : ici, ce sont les dépenses publicitaires réelles,
// l'engagement et les conversions sur les réseaux sociaux, pas le coût de génération.
// Trois niveaux de lecture, du plus agrégé au plus fin : campagne -> canal -> créative.
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: AnalyticsIngestionService,
  ) {}

  private async assertCampaignOwnership(organizationId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, organizationId } });
    if (!campaign) throw new NotFoundException('Campagne introuvable');
    return campaign;
  }

  // Vue d'ensemble de la campagne : totaux tous canaux confondus + CTR/CPA/ROAS recalculés
  // sur les totaux (jamais moyennés canal par canal, ce qui fausserait le résultat).
  async getCampaignSummary(organizationId: string, campaignId: string) {
    await this.assertCampaignOwnership(organizationId, campaignId);
    const aggregated = await this.ingestion.getAggregatedMetric(organizationId, campaignId);
    return aggregated ?? {
      impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, ctr: null, cpa: null, roas: null,
    };
  }

  // Répartition par canal — répond directement à "quel canal performe le mieux ?".
  async getChannelBreakdown(organizationId: string, campaignId: string) {
    await this.assertCampaignOwnership(organizationId, campaignId);
    const metrics = await this.prisma.campaignMetric.findMany({
      where: { organizationId, campaignId, platform: { not: null } },
      orderBy: { createdAt: 'desc' },
    });

    // Ne garde que la ligne la plus récente par canal.
    const latestByPlatform = new Map<string, (typeof metrics)[number]>();
    for (const m of metrics) {
      if (m.platform && !latestByPlatform.has(m.platform)) latestByPlatform.set(m.platform, m);
    }
    return Array.from(latestByPlatform.values());
  }

  // Répartition par créative — répond à "laquelle de mes variations A/B a gagné ?".
  // Regroupe par contentVersionId pour agréger les impressions/clics de toutes les
  // publications ayant utilisé cette même version, même sur des canaux différents.
  async getContentBreakdown(organizationId: string, campaignId: string) {
    await this.assertCampaignOwnership(organizationId, campaignId);
    const metrics = await this.prisma.contentMetric.findMany({
      where: { organizationId, campaignId },
      include: {
        contentVersion: {
          select: { id: true, label: true, versionNumber: true, body: true, contentPiece: { select: { channel: true, type: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byVersion = new Map<string, { version: (typeof metrics)[number]['contentVersion']; impressions: number; clicks: number; spend: number; conversions: number; conversionValue: number }>();
    for (const m of metrics) {
      const key = m.contentVersionId;
      const entry = byVersion.get(key) ?? { version: m.contentVersion, impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 };
      entry.impressions += m.impressions ?? 0;
      entry.clicks += m.clicks ?? 0;
      entry.spend += m.spend ?? 0;
      entry.conversions += m.conversions ?? 0;
      entry.conversionValue += m.conversionValue ?? 0;
      byVersion.set(key, entry);
    }

    return Array.from(byVersion.values()).map((v) => ({
      ...v,
      ctr: v.impressions > 0 ? (v.clicks / v.impressions) * 100 : null,
    }));
  }

  // Vue transverse pour un dashboard d'organisation — toutes campagnes confondues sur
  // une fenêtre récente, triée par dépense décroissante.
  async getOrganizationOverview(organizationId: string, limit = 10) {
    const campaigns = await this.prisma.campaign.findMany({
      where: { organizationId, status: 'PUBLISHED' },
      select: { id: true, name: true },
    });

    const summaries = await Promise.all(
      campaigns.map(async (c) => ({
        campaignId: c.id,
        campaignName: c.name,
        ...(await this.getCampaignSummary(organizationId, c.id)),
      })),
    );

    return summaries.sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0)).slice(0, limit);
  }

  async recordManualConversion(organizationId: string, campaignId: string, params: { count: number; value: number; note?: string }) {
    await this.assertCampaignOwnership(organizationId, campaignId);
    return this.ingestion.recordManualConversion(organizationId, campaignId, params);
  }
}
