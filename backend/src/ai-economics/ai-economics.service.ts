import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getPlan } from '../plans/plan-catalog';

// Économie de l'IA (volet reporting) : rend visible ce que AiGatewayService journalise
// désormais de façon exhaustive — coût réel par fournisseur, par type de tâche, par
// campagne, et la marge qui en résulte face au prix payé par le client. Sans ce service,
// la traçabilité de AiGeneration resterait une donnée brute inexploitée.
@Injectable()
export class AiEconomicsService {
  constructor(private readonly prisma: PrismaService) {}

  private currentPeriodStart(): Date {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  }

  // Vue consommable par le frontend : coût total, répartition par fournisseur/tâche/origine,
  // et rapprochement avec le système de crédits (combien de crédits pour combien de $ réels).
  async getUsageSummary(organizationId: string) {
    const periodStart = this.currentPeriodStart();

    const [totalAgg, byProvider, byPurpose, byTaskType, subscription] = await Promise.all([
      this.prisma.aiGeneration.aggregate({
        where: { organizationId, createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
        _sum: { costEstimate: true, tokensUsed: true },
        _count: { _all: true },
      }),
      this.prisma.aiGeneration.groupBy({
        by: ['provider'],
        where: { organizationId, createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
        _sum: { costEstimate: true },
        _count: { _all: true },
      }),
      this.prisma.aiGeneration.groupBy({
        by: ['purpose'],
        where: { organizationId, createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
        _sum: { costEstimate: true },
        _count: { _all: true },
      }),
      this.prisma.aiGeneration.groupBy({
        by: ['taskType'],
        where: { organizationId, createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
        _sum: { costEstimate: true },
        _count: { _all: true },
      }),
      this.prisma.subscription.findUnique({ where: { organizationId } }),
    ]);

    return {
      periodStart,
      totalCostUsd: totalAgg._sum.costEstimate ?? 0,
      totalTokens: totalAgg._sum.tokensUsed ?? 0,
      totalCalls: totalAgg._count._all,
      budgetUsd: subscription?.monthlyBudgetUsd ?? null,
      byProvider: byProvider.map((r) => ({ provider: r.provider, costUsd: r._sum.costEstimate ?? 0, calls: r._count._all })),
      byPurpose: byPurpose.map((r) => ({ purpose: r.purpose, costUsd: r._sum.costEstimate ?? 0, calls: r._count._all })),
      byTaskType: byTaskType.map((r) => ({ taskType: r.taskType, costUsd: r._sum.costEstimate ?? 0, calls: r._count._all })),
      credits: {
        used: subscription?.aiCreditsUsed ?? 0,
        included: subscription?.aiCreditsIncluded ?? 0,
      },
    };
  }

  // Marge brute réelle : prix du plan (revenu mensuel) vs coût réel payé aux fournisseurs
  // d'IA ce mois-ci. Réservé à ADMIN/OWNER (donnée sensible) — cf. controller.
  async getMarginSummary(organizationId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription) return null;

    const plan = getPlan(subscription.plan);
    const periodStart = this.currentPeriodStart();

    const { _sum } = await this.prisma.aiGeneration.aggregate({
      where: { organizationId, createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
      _sum: { costEstimate: true },
    });
    const aiCostUsd = _sum.costEstimate ?? 0;
    const revenueUsd = plan.priceMonthly ?? 0;
    const grossMarginUsd = revenueUsd - aiCostUsd;
    const grossMarginPct = revenueUsd > 0 ? (grossMarginUsd / revenueUsd) * 100 : null;

    return {
      plan: plan.key,
      revenueUsd,
      aiCostUsd,
      grossMarginUsd,
      grossMarginPct,
      // Rappel volontaire : ce coût IA ne représente qu'une partie du coût de service total
      // (infrastructure, support, etc. — cf. chapitre 3 du Volume 2 du business plan) ;
      // cette marge est donc une borne haute, pas la marge nette réelle de l'organisation.
    };
  }

  async listGenerations(organizationId: string, filters: { campaignId?: string; purpose?: string; limit?: number }) {
    return this.prisma.aiGeneration.findMany({
      where: {
        organizationId,
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(filters.purpose ? { purpose: filters.purpose } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 50, 200),
    });
  }
}
