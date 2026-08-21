import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreativeIntelligence } from '../creative-intelligence/creative-intelligence.types';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { ShotPlan } from '../video-direction/video-director.service';
import { ShotRepetitionWarning } from '../video-direction/shot-diversity';
import { QualityLoopAttemptTrace } from './video-quality-loop.service';
import { StructuredQualityReport } from './quality-report';

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
    };

    await this.prisma.creativeGenerationTrace.upsert({
      where: { campaignId: params.campaignId },
      create: { organizationId: params.organizationId, campaignId: params.campaignId, ...data },
      update: data,
    });
  }
}
