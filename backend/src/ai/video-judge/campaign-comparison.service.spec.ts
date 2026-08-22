import { CampaignComparisonService } from './pipeline-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';

function buildPrisma(opts: {
  campaigns?: Array<{ id: string; status: string; failureReason: string | null; productUrl: string | null }>;
  traces?: Array<Record<string, unknown>>;
  generations?: Array<{ campaignId: string; costEstimate: number | null; tokensUsed: number | null; status: string }>;
} = {}) {
  const campaignFindMany = jest.fn().mockResolvedValue(opts.campaigns ?? []);
  const traceFindMany = jest.fn().mockResolvedValue(opts.traces ?? []);
  const generationFindMany = jest.fn().mockResolvedValue(opts.generations ?? []);
  return {
    prisma: {
      campaign: { findMany: campaignFindMany },
      creativeGenerationTrace: { findMany: traceFindMany },
      aiGeneration: { findMany: generationFindMany },
    } as unknown as PrismaService,
    campaignFindMany,
    traceFindMany,
    generationFindMany,
  };
}

// Mission 4.5 (préparation Phases 3-11) — lecture seule, croise 3 sources pour UNE ligne
// comparable par campagne, sans jamais faire d'appel IA.
describe('CampaignComparisonService.getCampaignComparisonRows', () => {
  it('liste vide : retourne [] sans appeler Prisma', async () => {
    const { prisma, campaignFindMany } = buildPrisma();
    const service = new CampaignComparisonService(prisma);

    const rows = await service.getCampaignComparisonRows([]);

    expect(rows).toEqual([]);
    expect(campaignFindMany).not.toHaveBeenCalled();
  });

  it('campagne échouée côté provider (crédits épuisés) : AUCUNE trace n\'existe — hasTrace=false, failureReason lisible, providerErrorCount reflète les appels IA échoués', async () => {
    const { prisma } = buildPrisma({
      campaigns: [{ id: 'c1', status: 'FAILED', failureReason: "Le compte du fournisseur IA n'a plus de solde réel.", productUrl: 'https://example.com/produit' }],
      traces: [],
      generations: [{ campaignId: 'c1', costEstimate: 0, tokensUsed: 0, status: 'FAILED' }],
    });
    const service = new CampaignComparisonService(prisma);

    const [row] = await service.getCampaignComparisonRows(['c1']);

    expect(row.hasTrace).toBe(false);
    expect(row.finalOutcome).toBeNull();
    expect(row.status).toBe('FAILED');
    expect(row.providerErrorCount).toBe(1);
  });

  it('campagne PASSED avec trace complète : expose le dernier essai Judge, le root cause, et le coût RÉEL (distinct du checkpoint budget de la trace)', async () => {
    const { prisma } = buildPrisma({
      campaigns: [{ id: 'c2', status: 'APPROVED', failureReason: null, productUrl: null }],
      traces: [
        {
          campaignId: 'c2',
          finalOutcome: 'PASSED',
          judgeAttempts: [
            { attempt: 1, globalScore: 58, verdict: 'REPAIR_REQUIRED', criteria: [{ name: 'hookStrength', score: 50 }] },
            { attempt: 2, globalScore: 79, verdict: 'PASS', criteria: [{ name: 'hookStrength', score: 85 }] },
          ],
          preProductionJudge: { readyForGeneration: true },
          report: { goalFirstRootCause: 'CONCEPT' },
          attemptCount: 2,
          elapsedMs: 45000,
          escalationLevel: 'SCENE',
          productConflicts: null,
          // Piège volontaire du test : ce costEstimate (checkpoint budget prévisionnel) ne doit
          // JAMAIS être confondu avec le coût réel agrégé depuis AiGeneration ci-dessous.
          costEstimate: { checkpointA: 999 },
        },
      ],
      generations: [
        { campaignId: 'c2', costEstimate: 0.05, tokensUsed: 1200, status: 'SUCCEEDED' },
        { campaignId: 'c2', costEstimate: 0.03, tokensUsed: 800, status: 'SUCCEEDED' },
      ],
    });
    const service = new CampaignComparisonService(prisma);

    const [row] = await service.getCampaignComparisonRows(['c2']);

    expect(row.hasTrace).toBe(true);
    expect(row.finalOutcome).toBe('PASSED');
    expect(row.lastJudgeGlobalScore).toBe(79); // le DERNIER essai, pas le premier
    expect(row.lastJudgeVerdict).toBe('PASS');
    expect(row.rootCause).toBe('CONCEPT');
    expect(row.realCostEstimateTotal).toBeCloseTo(0.08); // 0.05 + 0.03, PAS 999
    expect(row.realTokensUsedTotal).toBe(2000);
    expect(row.aiGenerationCount).toBe(2);
    expect(row.providerErrorCount).toBe(0);
  });

  it("campagne introuvable dans la liste (id invalide) : ne plante jamais, statut explicite", async () => {
    const { prisma } = buildPrisma({ campaigns: [], traces: [], generations: [] });
    const service = new CampaignComparisonService(prisma);

    const [row] = await service.getCampaignComparisonRows(['inconnu']);

    expect(row.status).toContain('introuvable');
    expect(row.hasTrace).toBe(false);
  });

  it('interroge Campaign/CreativeGenerationTrace/AiGeneration filtrés sur exactement les campaignIds fournis', async () => {
    const { prisma, campaignFindMany, traceFindMany, generationFindMany } = buildPrisma();
    const service = new CampaignComparisonService(prisma);

    await service.getCampaignComparisonRows(['c1', 'c2']);

    expect(campaignFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['c1', 'c2'] } } }));
    expect(traceFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { campaignId: { in: ['c1', 'c2'] } } }));
    expect(generationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { campaignId: { in: ['c1', 'c2'] } } }));
  });
});
