import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// Phase R — Métriques d'optimisation cross-campagnes, périmètre RÉDUIT (chantier "Optimisation
// du pipeline vidéo — V2.1", 2026-08-19, spec Section 27) : ce service livre le CALCUL, jamais un
// tableau de bord ni un endpoint HTTP (hors périmètre explicite, cf. plan) — réutilisable par un
// futur `GET /api/ai-usage/pipeline-metrics`, suivant le pattern déjà établi par
// AiEconomicsService (aggregate/groupBy sur AiGeneration, appliqué ici à CreativeGenerationTrace).
//
// creativeGateRejectionRate/storyboardGateRejectionRate NE PEUVENT PAS être dérivés de
// CreativeGenerationTrace : un rejet du Creative Gate ou du Storyboard Gate lève une exception
// AVANT tout appel à CreativeGenerationTraceService.upsertTrace (cf.
// AiOrchestratorService.generateCampaign) — aucune trace n'est JAMAIS écrite pour une campagne
// ainsi rejetée, quel que soit ce qu'on y persisterait. Dérivés à la place de Campaign.failureReason
// (status FAILED), en réutilisant les messages désormais distincts posés par
// CampaignGenerationProcessor.toUserFacingFailureReason (bug corrigé au passage : le rejet du
// Storyboard Gate ne matchait auparavant aucun sous-cas dédié et se confondait avec l'épuisement
// de la Quality Loop).
export interface PipelineMetrics {
  firstPassRate: number; // PASSED sans AUCUNE escalade (escalationLevel SCENE/null) / total des traces
  averageGenerationsToPass: number | null; // moyenne de attemptCount sur les traces PASSED
  averageElapsedMsToPass: number | null; // moyenne de elapsedMs sur les traces PASSED
  creativeGateRejectionRate: number; // campagnes FAILED par le Creative Gate / total des campagnes
  storyboardGateRejectionRate: number; // campagnes FAILED par le Storyboard Gate / total des campagnes
  escalationRate: number; // traces ayant atteint STORYBOARD ou CONCEPT / total des traces
  regressionRate: number; // traces où au moins une réparation a été reverted (report.risqueDeRegression) / total des traces
}

@Injectable()
export class PipelineMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getPipelineMetrics(organizationId: string, since?: Date): Promise<PipelineMetrics> {
    const traceWhere = { organizationId, ...(since ? { createdAt: { gte: since } } : {}) };
    const campaignWhere = { organizationId, ...(since ? { createdAt: { gte: since } } : {}) };

    // Requêtes indépendantes, exécutées en parallèle — même principe que les Promise.all déjà
    // établis ailleurs dans l'Orchestrator (aucune ne dépend du résultat d'une autre).
    const [totalTraces, firstPassTraces, escalatedTraces, regressedTraces, passedAgg, totalCampaigns, creativeGateRejections, storyboardGateRejections] =
      await Promise.all([
        this.prisma.creativeGenerationTrace.count({ where: traceWhere }),
        this.prisma.creativeGenerationTrace.count({
          where: { ...traceWhere, finalOutcome: 'PASSED', OR: [{ escalationLevel: null }, { escalationLevel: 'SCENE' }] },
        }),
        this.prisma.creativeGenerationTrace.count({ where: { ...traceWhere, escalationLevel: { in: ['STORYBOARD', 'CONCEPT'] } } }),
        this.prisma.creativeGenerationTrace.count({ where: { ...traceWhere, report: { path: ['risqueDeRegression'], equals: true } } }),
        this.prisma.creativeGenerationTrace.aggregate({ where: { ...traceWhere, finalOutcome: 'PASSED' }, _avg: { attemptCount: true, elapsedMs: true } }),
        this.prisma.campaign.count({ where: campaignWhere }),
        this.prisma.campaign.count({ where: { ...campaignWhere, status: 'FAILED', failureReason: { contains: 'idée publicitaire' } } }),
        this.prisma.campaign.count({ where: { ...campaignWhere, status: 'FAILED', failureReason: { contains: 'plan de tournage' } } }),
      ]);

    return {
      firstPassRate: totalTraces > 0 ? firstPassTraces / totalTraces : 0,
      averageGenerationsToPass: passedAgg._avg.attemptCount,
      averageElapsedMsToPass: passedAgg._avg.elapsedMs,
      creativeGateRejectionRate: totalCampaigns > 0 ? creativeGateRejections / totalCampaigns : 0,
      storyboardGateRejectionRate: totalCampaigns > 0 ? storyboardGateRejections / totalCampaigns : 0,
      escalationRate: totalTraces > 0 ? escalatedTraces / totalTraces : 0,
      regressionRate: totalTraces > 0 ? regressedTraces / totalTraces : 0,
    };
  }
}
