import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsIngestionService } from './analytics-ingestion.service';

// Referme la boucle "l'IA propose -> un humain applique -> qu'est-ce que ça a changé ?" —
// sans cette mesure a posteriori, une recommandation "appliquée" n'est qu'une déclaration
// d'intention, jamais vérifiée. C'est le prérequis explicite avant toute automatisation
// contrôlée future (cf. AutomationService) : on ne peut pas automatiser en confiance des
// actions dont on n'a jamais mesuré l'effet réel.
@Injectable()
export class OptimizerOutcomeService {
  private readonly logger = new Logger(OptimizerOutcomeService.name);

  // Délai avant mesure : assez long pour qu'un changement (créatif, ciblage, budget) ait
  // eu le temps de produire un effet mesurable, assez court pour rester exploitable par
  // l'équipe marketing qui a appliqué la recommandation.
  private static readonly MEASUREMENT_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

  constructor(
    private readonly prisma: PrismaService,
    private readonly analyticsIngestion: AnalyticsIngestionService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async measurePendingOutcomes() {
    const cutoff = new Date(Date.now() - OptimizerOutcomeService.MEASUREMENT_DELAY_MS);

    const dueForMeasurement = await this.prisma.optimizationRecommendation.findMany({
      where: { status: 'APPLIED', outcomeCheckedAt: null, reviewedAt: { lte: cutoff } },
    });

    if (dueForMeasurement.length === 0) return;
    this.logger.log(`${dueForMeasurement.length} recommandation(s) à évaluer`);

    for (const rec of dueForMeasurement) {
      try {
        await this.measureOutcome(rec.id, rec.organizationId, rec.campaignId, rec.reviewedAt!);
      } catch (error) {
        this.logger.error(`Échec de mesure de la recommandation ${rec.id}: ${error}`);
      }
    }
  }

  private async measureOutcome(recommendationId: string, organizationId: string, campaignId: string, appliedAt: Date) {
    // "Avant" : la métrique agrégée la plus proche AVANT l'application (déjà en base au
    // moment où la recommandation a été appliquée). "Après" : rafraîchit puis relit.
    const before = await this.getSnapshotBefore(organizationId, campaignId, appliedAt);
    await this.analyticsIngestion.syncCampaignMetrics(organizationId, campaignId);
    const after = await this.analyticsIngestion.getAggregatedMetric(organizationId, campaignId);

    const measuredImpact = {
      ctr: { before: before?.ctr ?? null, after: after?.ctr ?? null },
      cpa: { before: before?.cpa ?? null, after: after?.cpa ?? null },
      roas: { before: before?.roas ?? null, after: after?.roas ?? null },
      measuredAt: new Date().toISOString(),
    };

    await this.prisma.optimizationRecommendation.update({
      where: { id: recommendationId },
      data: { measuredImpact, outcomeCheckedAt: new Date() },
    });
    this.logger.log(`Impact mesuré pour la recommandation ${recommendationId}`);
  }

  private async getSnapshotBefore(organizationId: string, campaignId: string, appliedAt: Date) {
    const metricsBeforeApplication = await this.prisma.campaignMetric.findMany({
      where: { organizationId, campaignId, createdAt: { lte: appliedAt } },
      orderBy: { createdAt: 'desc' },
    });
    if (metricsBeforeApplication.length === 0) return null;

    const latestByPlatform = new Map<string, (typeof metricsBeforeApplication)[number]>();
    for (const m of metricsBeforeApplication) {
      const key = m.platform ?? 'unknown';
      if (!latestByPlatform.has(key)) latestByPlatform.set(key, m);
    }
    const totals = Array.from(latestByPlatform.values()).reduce(
      (acc, m) => ({
        impressions: acc.impressions + (m.impressions ?? 0),
        clicks: acc.clicks + (m.clicks ?? 0),
        spend: acc.spend + (m.spend ?? 0),
        conversionValue: acc.conversionValue + (m.conversionValue ?? 0),
      }),
      { impressions: 0, clicks: 0, spend: 0, conversionValue: 0 },
    );

    return {
      ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null,
      cpa: totals.clicks > 0 && totals.spend > 0 ? totals.spend / totals.clicks : null,
      roas: totals.spend > 0 && totals.conversionValue > 0 ? totals.conversionValue / totals.spend : null,
    };
  }
}
