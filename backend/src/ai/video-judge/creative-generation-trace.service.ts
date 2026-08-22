import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreativeIntelligence } from '../creative-intelligence/creative-intelligence.types';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { ShotPlan } from '../video-direction/video-director.service';
import { ShotRepetitionWarning } from '../video-direction/shot-diversity';
import { QualityLoopAttemptTrace } from './video-quality-loop.service';
import { StructuredQualityReport } from './quality-report';
import { QualityTarget } from '../quality/quality-target';
import { StoryboardGateResult } from '../video-direction/storyboard-gate.types';
import { ProductFactConflict } from '../product-intelligence/product-fact.types';
import { ProductUrlFacts } from '../product-intelligence/product-page/product-url-facts.types';
import { isLegacyNarrationExperimentMode } from '../creative-intelligence/narration-experiment-flag';

export interface ShotPlanVersion {
  attempt: number;
  shots: ShotPlan;
  repetitionWarnings: ShotRepetitionWarning[];
}

export interface UpsertTraceParams {
  organizationId: string;
  campaignId: string;
  creativeIntelligence: CreativeIntelligence;
  creativeConcept: CreativeConcept;
  shotPlanVersions: ShotPlanVersion[];
  attempts: QualityLoopAttemptTrace[];
  costEstimate: { checkpointA: number; checkpointBFinalMaxRepairAttempts: number };
  finalOutcome: 'PASSED' | 'REPAIR_EXHAUSTED' | 'SKIPPED_NO_VIDEO';
  // Phase Q (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — le rapport structuré
  // (buildQualityReport, déjà calculé depuis la Phase F) était jusqu'ici jamais persisté, jamais
  // consultable après coup, seulement utilisé pour construire un message d'erreur éphémère.
  // Optionnels : les sites d'appel historiques (avant ce chantier) restent valides sans eux.
  report?: StructuredQualityReport;
  elapsedMs?: number;
  attemptCount?: number;
  escalationLevel?: 'SCENE' | 'STORYBOARD' | 'CONCEPT';
  // Mission 4.3 (Goal-First Quality Architecture, Phase 1, Étape 1) — QualityTarget de la
  // génération, créé avant le Creative Concept (cf. AiOrchestratorService.generateCampaign()) et
  // menée jusqu'ici sans recalcul. Optionnel : les tests/appelants antérieurs à ce chantier
  // restent valides sans lui.
  qualityTarget?: QualityTarget;
  // Mission 4.3 (Goal-First Quality Architecture, Phase 6b, Étape 23) — résultat COMPLET du
  // dernier Storyboard Gate/PreProductionQualityJudge (Phase 5b) franchi pour cette génération :
  // criterionScores/blockingDefects/risks/requiredChanges/rootCauseLevel/readyForGeneration.
  // Optionnel : les appelants/tests antérieurs à ce chantier restent valides sans lui.
  preProductionJudge?: StoryboardGateResult;
  // Mission 4.4 (Product URL Intelligence, Phase T) — additif, optionnel. Ne crée jamais une 2e
  // trace concurrente : prolonge CreativeGenerationTrace existante.
  productUrl?: string | null;
  productUrlFacts?: ProductUrlFacts | null;
  productConflicts?: ProductFactConflict[];
}

// P0.11 — Observabilité (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Persistance simple (upsert par campaignId, PrismaModule étant @Global() aucun
// import de module n'est nécessaire — même situation que les autres services de ce chantier) :
// répond directement aux questions du brief (pourquoi cette scène a été régénérée, quel
// provider, combien ça a coûté, pourquoi la vidéo a été acceptée/refusée), en dérivant
// judgeAttempts/repairs directement de la trace déjà produite par VideoQualityLoopService — rien
// n'est recalculé ici, uniquement transformé pour la persistance en base.
@Injectable()
export class CreativeGenerationTraceService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertTrace(params: UpsertTraceParams): Promise<void> {
    const judgeAttempts = params.attempts.map((a) => ({ attempt: a.attempt, criteria: a.judge.criteria, globalScore: a.judge.globalScore, verdict: a.judge.verdict }));
    const repairs = params.attempts.flatMap((a) => a.repairsApplied.map((r) => ({ attempt: a.attempt, ...r })));

    const data = {
      creativeIntelligence: params.creativeIntelligence as object,
      creativeConcept: params.creativeConcept as object,
      shotPlanVersions: params.shotPlanVersions as unknown as object,
      judgeAttempts: judgeAttempts as unknown as object,
      repairs: repairs as unknown as object,
      costEstimate: params.costEstimate as object,
      finalOutcome: params.finalOutcome,
      report: (params.report as unknown as object) ?? undefined,
      elapsedMs: params.elapsedMs,
      attemptCount: params.attemptCount,
      escalationLevel: params.escalationLevel,
      qualityTarget: (params.qualityTarget as unknown as object) ?? undefined,
      preProductionJudge: (params.preProductionJudge as unknown as object) ?? undefined,
      productUrl: params.productUrl ?? undefined,
      productUrlFacts: (params.productUrlFacts as unknown as object) ?? undefined,
      productConflicts: (params.productConflicts as unknown as object) ?? undefined,
      // Mission 4.5 — lu au moment de l'écriture (pas transmis en paramètre) : reflète l'état
      // RÉEL du flag pendant cette génération, cf. narration-experiment-flag.ts.
      narrationLegacyMode: isLegacyNarrationExperimentMode(),
    };

    await this.prisma.creativeGenerationTrace.upsert({
      where: { campaignId: params.campaignId },
      create: { organizationId: params.organizationId, campaignId: params.campaignId, ...data },
      update: data,
    });
  }
}
