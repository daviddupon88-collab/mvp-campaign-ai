import { PipelineMetricsService } from './pipeline-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';

function buildPrismaMock(overrides: {
  traceCounts?: number[]; // [total, firstPass, escalated, regressed]
  aggregateAvg?: { attemptCount: number | null; elapsedMs: number | null };
  campaignCounts?: number[]; // [total, creativeGateRejections, storyboardGateRejections]
} = {}) {
  const traceCounts = overrides.traceCounts ?? [0, 0, 0, 0];
  const aggregateAvg = overrides.aggregateAvg ?? { attemptCount: null, elapsedMs: null };
  const campaignCounts = overrides.campaignCounts ?? [0, 0, 0];

  const traceCount = jest.fn();
  traceCounts.forEach((v) => traceCount.mockResolvedValueOnce(v));
  const campaignCount = jest.fn();
  campaignCounts.forEach((v) => campaignCount.mockResolvedValueOnce(v));

  return {
    creativeGenerationTrace: {
      count: traceCount,
      aggregate: jest.fn().mockResolvedValue({ _avg: aggregateAvg }),
    },
    campaign: {
      count: campaignCount,
    },
  } as unknown as PrismaService;
}

describe('PipelineMetricsService.getPipelineMetrics', () => {
  it('organisation sans aucune trace ni campagne : tous les taux à 0, moyennes à null, jamais une division par zéro qui plante', async () => {
    const prisma = buildPrismaMock();
    const service = new PipelineMetricsService(prisma);

    const metrics = await service.getPipelineMetrics('org-1');

    expect(metrics).toEqual({
      firstPassRate: 0,
      averageGenerationsToPass: null,
      averageElapsedMsToPass: null,
      creativeGateRejectionRate: 0,
      storyboardGateRejectionRate: 0,
      escalationRate: 0,
      regressionRate: 0,
    });
  });

  // Jeu de traces (spec Section 27) : 5 traces au total — 3 PASSED premier essai (aucune
  // escalade), 1 PASSED après escalade storyboard, 1 REPAIR_EXHAUSTED (jamais résolu, aucune
  // régression détectée dans ce cas précis) ; 10 campagnes au total, 2 rejetées par le Creative
  // Gate, 1 par le Storyboard Gate.
  it('calcule les taux/moyennes exactement selon le jeu de traces construit à la main', async () => {
    const prisma = buildPrismaMock({
      traceCounts: [5, 3, 1, 0], // total=5, firstPass=3 (les 3 PASSED sans escalade), escalated=1 (la PASSED escaladée), regressed=0
      aggregateAvg: { attemptCount: 1.5, elapsedMs: 42_000 }, // moyenne sur les 4 traces PASSED
      campaignCounts: [10, 2, 1],
    });
    const service = new PipelineMetricsService(prisma);

    const metrics = await service.getPipelineMetrics('org-1');

    expect(metrics.firstPassRate).toBeCloseTo(3 / 5);
    expect(metrics.averageGenerationsToPass).toBe(1.5);
    expect(metrics.averageElapsedMsToPass).toBe(42_000);
    expect(metrics.creativeGateRejectionRate).toBeCloseTo(2 / 10);
    expect(metrics.storyboardGateRejectionRate).toBeCloseTo(1 / 10);
    expect(metrics.escalationRate).toBeCloseTo(1 / 5);
    expect(metrics.regressionRate).toBe(0);
  });

  it('scope toujours par organizationId — jamais cross-tenant', async () => {
    const prisma = buildPrismaMock();
    const service = new PipelineMetricsService(prisma);

    await service.getPipelineMetrics('org-42');

    expect(prisma.creativeGenerationTrace.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-42' }) }));
    expect(prisma.campaign.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-42' }) }));
  });

  it('applique le filtre `since` (createdAt >= since) sur les traces ET les campagnes quand fourni', async () => {
    const prisma = buildPrismaMock();
    const service = new PipelineMetricsService(prisma);
    const since = new Date('2026-08-01T00:00:00Z');

    await service.getPipelineMetrics('org-1', since);

    expect(prisma.creativeGenerationTrace.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: since } }) }));
    expect(prisma.campaign.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: since } }) }));
  });

  it("n'applique aucun filtre createdAt quand `since` est omis", async () => {
    const prisma = buildPrismaMock();
    const service = new PipelineMetricsService(prisma);

    await service.getPipelineMetrics('org-1');

    const traceCall = (prisma.creativeGenerationTrace.count as jest.Mock).mock.calls[0][0];
    expect(traceCall.where.createdAt).toBeUndefined();
  });
});
