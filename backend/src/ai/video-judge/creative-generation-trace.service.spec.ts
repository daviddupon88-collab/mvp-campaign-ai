import { CreativeGenerationTraceService } from './creative-generation-trace.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreativeIntelligence } from '../creative-intelligence/creative-intelligence.types';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { VideoJudgeResult } from './video-judge.types';
import { QUALITY_TARGET_V1 } from '../quality/quality-target';
import { StoryboardGateResult } from '../video-direction/storyboard-gate.types';
import * as narrationExperimentFlag from '../creative-intelligence/narration-experiment-flag';

const CREATIVE_INTELLIGENCE = {} as CreativeIntelligence;
const CONCEPT = {} as CreativeConcept;

function buildJudge(verdict: 'PASS' | 'REPAIR_REQUIRED'): VideoJudgeResult {
  return {
    criteria: [{ name: 'productConsistency', score: 90, justification: 'ok' }],
    globalScore: 90,
    visualQuality: { score: 90, criteria: ['productConsistency'] },
    advertisingEffectiveness: { score: 90, criteria: [] },
    verdict,
  };
}

function buildPrismaMock() {
  return { creativeGenerationTrace: { upsert: jest.fn().mockResolvedValue({}) } } as unknown as PrismaService;
}

describe('CreativeGenerationTraceService.upsertTrace', () => {
  it("upsert par campaignId : crée si absent, met à jour sinon (jamais un doublon)", async () => {
    const prisma = buildPrismaMock();
    const service = new CreativeGenerationTraceService(prisma);

    await service.upsertTrace({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      creativeIntelligence: CREATIVE_INTELLIGENCE,
      creativeConcept: CONCEPT,
      shotPlanVersions: [],
      attempts: [],
      costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 2 },
      finalOutcome: 'PASSED',
    });

    expect(prisma.creativeGenerationTrace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { campaignId: 'camp-1' },
        create: expect.objectContaining({ organizationId: 'org-1', campaignId: 'camp-1', finalOutcome: 'PASSED' }),
        update: expect.objectContaining({ finalOutcome: 'PASSED' }),
      }),
    );
  });

  it('dérive judgeAttempts/repairs directement des tentatives de la boucle qualité — répond à "pourquoi régénérée / quel coût / pourquoi acceptée"', async () => {
    const prisma = buildPrismaMock();
    const service = new CreativeGenerationTraceService(prisma);

    await service.upsertTrace({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      creativeIntelligence: CREATIVE_INTELLIGENCE,
      creativeConcept: CONCEPT,
      shotPlanVersions: [],
      attempts: [
        {
          attempt: 1,
          judge: buildJudge('REPAIR_REQUIRED'),
          repairsApplied: [{ criterion: 'motionDynamism', strategy: 'CLIP_REGEN', sceneId: 'shot-2', reason: 'trop statique' }],
        },
        { attempt: 2, judge: buildJudge('PASS'), repairsApplied: [] },
      ],
      costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 1 },
      finalOutcome: 'PASSED',
    });

    const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create.judgeAttempts).toEqual([
      { attempt: 1, criteria: expect.any(Array), globalScore: 90, verdict: 'REPAIR_REQUIRED' },
      { attempt: 2, criteria: expect.any(Array), globalScore: 90, verdict: 'PASS' },
    ]);
    expect(call.create.repairs).toEqual([{ attempt: 1, criterion: 'motionDynamism', strategy: 'CLIP_REGEN', sceneId: 'shot-2', reason: 'trop statique' }]);
  });

  it('finalOutcome REPAIR_EXHAUSTED persisté tel quel — jamais transformé en un faux PASSED', async () => {
    const prisma = buildPrismaMock();
    const service = new CreativeGenerationTraceService(prisma);

    await service.upsertTrace({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      creativeIntelligence: CREATIVE_INTELLIGENCE,
      creativeConcept: CONCEPT,
      shotPlanVersions: [],
      attempts: [],
      costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 0 },
      finalOutcome: 'REPAIR_EXHAUSTED',
    });

    const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create.finalOutcome).toBe('REPAIR_EXHAUSTED');
  });

  describe('Phase Q — report/elapsedMs/attemptCount/escalationLevel', () => {
    it('persiste le rapport structuré et les compteurs Phase Q quand fournis', async () => {
      const prisma = buildPrismaMock();
      const service = new CreativeGenerationTraceService(prisma);
      const report = { statut: 'PASSED', totalGenerations: 1, totalRepairs: 0 } as any;

      await service.upsertTrace({
        organizationId: 'org-1',
        campaignId: 'camp-1',
        creativeIntelligence: CREATIVE_INTELLIGENCE,
        creativeConcept: CONCEPT,
        shotPlanVersions: [],
        attempts: [],
        costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 2 },
        finalOutcome: 'PASSED',
        report,
        elapsedMs: 42_000,
        attemptCount: 3,
        escalationLevel: 'STORYBOARD',
      });

      const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
      expect(call.create.report).toEqual(report);
      expect(call.create.elapsedMs).toBe(42_000);
      expect(call.create.attemptCount).toBe(3);
      expect(call.create.escalationLevel).toBe('STORYBOARD');
    });

    it("reste valide sans ces champs (sites d'appel historiques, avant ce chantier) — jamais requis", async () => {
      const prisma = buildPrismaMock();
      const service = new CreativeGenerationTraceService(prisma);

      await service.upsertTrace({
        organizationId: 'org-1',
        campaignId: 'camp-1',
        creativeIntelligence: CREATIVE_INTELLIGENCE,
        creativeConcept: CONCEPT,
        shotPlanVersions: [],
        attempts: [],
        costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 2 },
        finalOutcome: 'PASSED',
      });

      const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
      expect(call.create.report).toBeUndefined();
      expect(call.create.elapsedMs).toBeUndefined();
    });
  });

  // Mission 4.3 (Goal-First Quality Architecture, Phase 1, Étape 1) — le QualityTarget créé avant
  // le Creative Concept doit survivre jusqu'à la trace persistée, pas seulement en mémoire pendant
  // la génération.
  it('persiste qualityTarget quand fourni', async () => {
    const prisma = buildPrismaMock();
    const service = new CreativeGenerationTraceService(prisma);

    await service.upsertTrace({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      creativeIntelligence: CREATIVE_INTELLIGENCE,
      creativeConcept: CONCEPT,
      shotPlanVersions: [],
      attempts: [],
      costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 2 },
      finalOutcome: 'PASSED',
      qualityTarget: QUALITY_TARGET_V1,
    });

    const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create.qualityTarget).toEqual(QUALITY_TARGET_V1);
  });

  // Mission 4.3 (Goal-First Quality Architecture, Phase 6b, Étape 23) — le résultat complet du
  // dernier Storyboard Gate/PreProductionQualityJudge (Phase 5b) doit survivre jusqu'à
  // GoalFirstTrace, même quand la campagne aboutit sans jamais avoir eu besoin d'escalader.
  it('persiste preProductionJudge quand fourni', async () => {
    const prisma = buildPrismaMock();
    const service = new CreativeGenerationTraceService(prisma);
    const preProductionJudge: StoryboardGateResult = {
      status: 'APPROVED', score: 88, scenesToRemove: [], faiblesses: [], recommandation: '',
      criterionScores: { productConsistency: 90, storytelling: 85, ctaClarity: 88 },
      blockingDefects: [], risks: [], requiredChanges: [], rootCauseLevel: null, readyForGeneration: true,
    };

    await service.upsertTrace({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      creativeIntelligence: CREATIVE_INTELLIGENCE,
      creativeConcept: CONCEPT,
      shotPlanVersions: [],
      attempts: [],
      costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 2 },
      finalOutcome: 'PASSED',
      preProductionJudge,
    });

    const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create.preProductionJudge).toEqual(preProductionJudge);
  });

  it("reste valide sans preProductionJudge (sites d'appel historiques, avant ce chantier) — jamais requis", async () => {
    const prisma = buildPrismaMock();
    const service = new CreativeGenerationTraceService(prisma);

    await service.upsertTrace({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      creativeIntelligence: CREATIVE_INTELLIGENCE,
      creativeConcept: CONCEPT,
      shotPlanVersions: [],
      attempts: [],
      costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 2 },
      finalOutcome: 'PASSED',
    });

    const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create.preProductionJudge).toBeUndefined();
  });

  // Mission 4.5 (stabilisation infrastructure) — narrationLegacyMode doit refléter l'état RÉEL
  // du flag au moment de l'écriture, jamais dérivé du nom de campagne (texte libre non fiable).
  describe('narrationLegacyMode (Mission 4.5)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('flag actif (contrôle Ax) : narrationLegacyMode=true persisté', async () => {
      jest.spyOn(narrationExperimentFlag, 'isLegacyNarrationExperimentMode').mockReturnValue(true);
      const prisma = buildPrismaMock();
      const service = new CreativeGenerationTraceService(prisma);

      await service.upsertTrace({
        organizationId: 'org-1', campaignId: 'camp-1', creativeIntelligence: CREATIVE_INTELLIGENCE, creativeConcept: CONCEPT,
        shotPlanVersions: [], attempts: [], costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 2 }, finalOutcome: 'PASSED',
      });

      const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
      expect(call.create.narrationLegacyMode).toBe(true);
    });

    it('flag inactif (expérimental Bx / production normale) : narrationLegacyMode=false persisté', async () => {
      jest.spyOn(narrationExperimentFlag, 'isLegacyNarrationExperimentMode').mockReturnValue(false);
      const prisma = buildPrismaMock();
      const service = new CreativeGenerationTraceService(prisma);

      await service.upsertTrace({
        organizationId: 'org-1', campaignId: 'camp-1', creativeIntelligence: CREATIVE_INTELLIGENCE, creativeConcept: CONCEPT,
        shotPlanVersions: [], attempts: [], costEstimate: { checkpointA: 500, checkpointBFinalMaxRepairAttempts: 2 }, finalOutcome: 'PASSED',
      });

      const call = (prisma.creativeGenerationTrace.upsert as jest.Mock).mock.calls[0][0];
      expect(call.create.narrationLegacyMode).toBe(false);
    });
  });
});
