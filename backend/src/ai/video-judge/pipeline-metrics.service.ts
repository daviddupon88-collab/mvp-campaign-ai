import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductUrlFacts } from '../product-intelligence/product-page/product-url-facts.types';
import { ProductFactConflict } from '../product-intelligence/product-fact.types';
import { CRITICAL_IDENTITY_ATTRIBUTES } from '../video-direction/preflight-quality-gate';
import { PROMPT_VERSIONS } from '../prompt-versions';

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

  // Mission 4.5 (Phase 1 — instrumentation Product Grounding). MÊME pattern que
  // getPipelineMetrics : calcul dérivé, jamais un tableau de bord ni un endpoint HTTP dédié —
  // réutilise CreativeGenerationTrace.productUrlFacts/productConflicts (Mission 4.4, déjà
  // persistés, additifs) plutôt que d'introduire une 4e forme de journalisation/métriques.
  // Le coût/tokens réels du repli LLM ne sont PAS ré-estimés ici : ils existent déjà, exacts,
  // dans AiGeneration (promptVersion=PROMPT_VERSIONS.productPageExtraction) — dupliquer une
  // estimation à côté d'un chiffre exact déjà mesuré serait une source d'incohérence, pas une
  // preuve supplémentaire (cf. mission, Phase 12 : "ne pas ajouter une nouvelle abstraction sans
  // preuve").
  async getProductGroundingMetrics(organizationId: string, since?: Date): Promise<ProductGroundingMetrics> {
    const where = { organizationId, productUrl: { not: null }, ...(since ? { createdAt: { gte: since } } : {}) };

    const traces = await this.prisma.creativeGenerationTrace.findMany({
      where,
      select: { campaignId: true, productUrlFacts: true, productConflicts: true },
    });

    const totalWithUrl = traces.length;
    if (totalWithUrl === 0) {
      return {
        totalCampaignsWithUrl: 0,
        deterministicSucceededCount: 0,
        llmFallbackTriggeredCount: 0,
        cacheHitCount: 0,
        averageFetchDurationMs: null,
        averageRedirectCount: null,
        averageLlmFallbackDurationMs: null,
        totalConflicts: 0,
        totalUnresolvedConflicts: 0,
        totalCriticalUnresolvedConflicts: 0,
        llmFallback: { totalGenerations: 0, totalCostEstimate: 0, totalTokensUsed: 0, averageDurationMs: null },
      };
    }

    let deterministicSucceededCount = 0;
    let llmFallbackTriggeredCount = 0;
    let cacheHitCount = 0;
    let totalConflicts = 0;
    let totalUnresolvedConflicts = 0;
    let totalCriticalUnresolvedConflicts = 0;
    const fetchDurations: number[] = [];
    const redirectCounts: number[] = [];
    const llmFallbackDurations: number[] = [];

    for (const trace of traces) {
      const facts = trace.productUrlFacts as unknown as ProductUrlFacts | null;
      if (facts) {
        const usedLlm = facts.extractionMethod === 'LLM' || facts.extractionMethod === 'MIXED';
        if (usedLlm) llmFallbackTriggeredCount += 1;
        else deterministicSucceededCount += 1;
        if (facts.cacheHit) cacheHitCount += 1;
        if (typeof facts.fetchDurationMs === 'number') fetchDurations.push(facts.fetchDurationMs);
        if (typeof facts.redirectCount === 'number') redirectCounts.push(facts.redirectCount);
        if (typeof facts.llmFallbackDurationMs === 'number') llmFallbackDurations.push(facts.llmFallbackDurationMs);
      }

      const conflicts = (trace.productConflicts as unknown as ProductFactConflict[] | null) ?? [];
      totalConflicts += conflicts.length;
      const unresolved = conflicts.filter((c) => c.resolution === 'UNRESOLVED');
      totalUnresolvedConflicts += unresolved.length;
      totalCriticalUnresolvedConflicts += unresolved.filter((c) => CRITICAL_IDENTITY_ATTRIBUTES.has(c.attribute)).length;
    }

    const campaignIds = traces.map((t) => t.campaignId).filter((id): id is string => !!id);
    const llmGenerationAgg = campaignIds.length
      ? await this.prisma.aiGeneration.aggregate({
          where: { organizationId, campaignId: { in: campaignIds }, promptVersion: PROMPT_VERSIONS.productPageExtraction },
          _sum: { costEstimate: true, tokensUsed: true },
          _avg: { durationMs: true },
          _count: true,
        })
      : null;

    return {
      totalCampaignsWithUrl: totalWithUrl,
      deterministicSucceededCount,
      llmFallbackTriggeredCount,
      cacheHitCount,
      averageFetchDurationMs: average(fetchDurations),
      averageRedirectCount: average(redirectCounts),
      averageLlmFallbackDurationMs: average(llmFallbackDurations),
      totalConflicts,
      totalUnresolvedConflicts,
      totalCriticalUnresolvedConflicts,
      llmFallback: {
        totalGenerations: llmGenerationAgg?._count ?? 0,
        totalCostEstimate: llmGenerationAgg?._sum.costEstimate ?? 0,
        totalTokensUsed: llmGenerationAgg?._sum.tokensUsed ?? 0,
        averageDurationMs: llmGenerationAgg?._avg.durationMs ?? null,
      },
    };
  }
}

export interface ProductGroundingMetrics {
  totalCampaignsWithUrl: number;
  deterministicSucceededCount: number;
  llmFallbackTriggeredCount: number;
  cacheHitCount: number;
  averageFetchDurationMs: number | null;
  averageRedirectCount: number | null;
  averageLlmFallbackDurationMs: number | null;
  totalConflicts: number;
  totalUnresolvedConflicts: number;
  totalCriticalUnresolvedConflicts: number;
  llmFallback: {
    totalGenerations: number;
    totalCostEstimate: number;
    totalTokensUsed: number;
    averageDurationMs: number | null;
  };
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// Mission 4.5 (préparation Phases 3-11) — UNE ligne comparable par campagne, croisant les 3
// sources qui portent aujourd'hui chacune une partie de la vérité (aucune ne suffit seule) :
//   - Campaign.status/failureReason : seule source pour un échec PROVIDER (crédits épuisés,
//     panne réseau) — CE CAS N'ÉCRIT JAMAIS de CreativeGenerationTrace (cf. commentaire
//     getPipelineMetrics ci-dessus : l'exception part avant tout upsertTrace).
//   - CreativeGenerationTrace : verdict qualité (finalOutcome/judgeAttempts/preProductionJudge/
//     report.rootCause) — n'existe QUE si le pipeline a atteint au moins le Storyboard Gate.
//   - AiGeneration (agrégat) : coût/tokens RÉELS. Piège explicite déjà rencontré dans ce
//     chantier : CreativeGenerationTrace.costEstimate n'est PAS le coût réel dépensé — c'est un
//     checkpoint de BUDGET PRÉVISIONNEL (checkpointA/checkpointBFinalMaxRepairAttempts, posé en
//     cours de pipeline pour arbitrer les réparations), un nom qui prête à confusion avec le vrai
//     coût ci-dessous. Ne jamais lire l'un pour l'autre.
// Lecture seule, aucun appel IA, déterministe — sûr à exécuter à tout moment, y compris crédits
// OpenAI épuisés.
export interface CampaignComparisonRow {
  campaignId: string;
  status: string;
  failureReason: string | null;
  productUrl: string | null;
  hasTrace: boolean;
  finalOutcome: string | null;
  lastJudgeGlobalScore: number | null;
  lastJudgeVerdict: string | null;
  lastJudgeCriteria: unknown | null; // JudgeCriterionResult[] du dernier essai — cf. video-judge.types.ts
  preProductionJudge: unknown | null; // StoryboardGateResult complet (criterionScores/blockingDefects/rootCauseLevel/readyForGeneration)
  rootCause: string | null;
  attemptCount: number | null;
  elapsedMs: number | null;
  escalationLevel: string | null;
  productConflicts: unknown | null;
  realCostEstimateTotal: number;
  realTokensUsedTotal: number;
  aiGenerationCount: number;
  providerErrorCount: number; // AiGeneration.status = 'FAILED', tous appels confondus
}

@Injectable()
export class CampaignComparisonService {
  constructor(private readonly prisma: PrismaService) {}

  async getCampaignComparisonRows(campaignIds: string[]): Promise<CampaignComparisonRow[]> {
    if (campaignIds.length === 0) return [];

    const [campaigns, traces, generations] = await Promise.all([
      this.prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, status: true, failureReason: true, productUrl: true } }),
      this.prisma.creativeGenerationTrace.findMany({ where: { campaignId: { in: campaignIds } } }),
      this.prisma.aiGeneration.findMany({
        where: { campaignId: { in: campaignIds } },
        select: { campaignId: true, costEstimate: true, tokensUsed: true, status: true },
      }),
    ]);

    const traceByCampaign = new Map(traces.map((t) => [t.campaignId, t]));

    return campaignIds.map((campaignId) => {
      const campaign = campaigns.find((c) => c.id === campaignId);
      const trace = traceByCampaign.get(campaignId);
      const campaignGenerations = generations.filter((g) => g.campaignId === campaignId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const judgeAttempts = (trace?.judgeAttempts as any[]) ?? [];
      const lastAttempt = judgeAttempts[judgeAttempts.length - 1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = trace?.report as any;

      return {
        campaignId,
        status: campaign?.status ?? 'INCONNU (campagne introuvable)',
        failureReason: campaign?.failureReason ?? null,
        productUrl: campaign?.productUrl ?? null,
        hasTrace: !!trace,
        finalOutcome: trace?.finalOutcome ?? null,
        lastJudgeGlobalScore: lastAttempt?.globalScore ?? null,
        lastJudgeVerdict: lastAttempt?.verdict ?? null,
        lastJudgeCriteria: lastAttempt?.criteria ?? null,
        preProductionJudge: trace?.preProductionJudge ?? null,
        rootCause: report?.goalFirstRootCause ?? report?.rootCause ?? null,
        attemptCount: trace?.attemptCount ?? null,
        elapsedMs: trace?.elapsedMs ?? null,
        escalationLevel: trace?.escalationLevel ?? null,
        productConflicts: trace?.productConflicts ?? null,
        realCostEstimateTotal: campaignGenerations.reduce((sum, g) => sum + (g.costEstimate ?? 0), 0),
        realTokensUsedTotal: campaignGenerations.reduce((sum, g) => sum + (g.tokensUsed ?? 0), 0),
        aiGenerationCount: campaignGenerations.length,
        providerErrorCount: campaignGenerations.filter((g) => g.status === 'FAILED').length,
      };
    });
  }
}
