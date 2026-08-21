import { CreativeGenerationTraceService } from './creative-generation-trace.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreativeIntelligence } from '../creative-intelligence/creative-intelligence.types';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { VideoJudgeResult } from './video-judge.types';

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
});
