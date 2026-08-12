import { AiOptimizerService } from './ai-optimizer.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService } from '../ai/ai-gateway/ai-gateway.service';
import { AnalyticsIngestionService } from './analytics-ingestion.service';
import { BrandLearningService } from '../brand/brand-learning.service';
import { EntitlementsService } from '../plans/entitlements.service';
import { ConfigService } from '@nestjs/config';

const CAMPAIGN = {
  id: 'campaign-1',
  name: 'Lancement gamme running',
  objective: 'Vendre 100 paires',
  budget: 500,
  channels: ['facebook'],
  organization: { brandKit: { toneOfVoice: 'Direct' } },
};

const METRIC = { impressions: 1000, clicks: 20, spend: 50, ctr: 2, cpa: 2.5, conversions: 3, conversionValue: 90, roas: 1.8 };

function buildService(recommendationJson: unknown) {
  const campaignFindMany = jest.fn().mockResolvedValue([CAMPAIGN]);
  const campaignFindUnique = jest.fn().mockResolvedValue(CAMPAIGN);
  const optimizationRecommendationCreate = jest.fn().mockResolvedValue({ id: 'reco-1' });

  const prisma = {
    campaign: { findMany: campaignFindMany, findUnique: campaignFindUnique },
    optimizationRecommendation: { create: optimizationRecommendationCreate },
  } as unknown as PrismaService;

  const generateText = jest.fn().mockResolvedValue({ content: JSON.stringify(recommendationJson), provider: 'anthropic', model: 'test', durationMs: 5 });
  const aiGateway = { generateText } as unknown as AiGatewayService;

  const syncCampaignMetrics = jest.fn().mockResolvedValue(undefined);
  const getAggregatedMetric = jest.fn().mockResolvedValue(METRIC);
  const analyticsIngestion = { syncCampaignMetrics, getAggregatedMetric } as unknown as AnalyticsIngestionService;

  const recordObservation = jest.fn().mockResolvedValue({});
  const brandLearning = { recordObservation } as unknown as BrandLearningService;

  const assertOptimizerRunAvailable = jest.fn().mockResolvedValue(undefined);
  const entitlements = { assertOptimizerRunAvailable } as unknown as EntitlementsService;

  // AI_MODE != 'mock' pour emprunter le chemin AiGateway (contrôlable), plutôt que la
  // simulation figée à "on_track" qui ne permet jamais de tester le cas under/over.
  const config = { get: jest.fn().mockReturnValue('real') } as unknown as ConfigService;

  const service = new AiOptimizerService(prisma, aiGateway, analyticsIngestion, brandLearning, entitlements, config);
  return { service, recordObservation, optimizationRecommendationCreate };
}

describe('AiOptimizerService — intégration Brand Brain (Phase 15)', () => {
  it('enregistre un INSIGHT quand la performance est en-dessous de l\'objectif ("under")', async () => {
    const { service, recordObservation } = buildService({
      performance: 'under',
      summary: 'Sous-performance sur le ciblage',
      actions: [{ type: 'targeting_adjustment', description: '...', expectedImpact: '...' }],
    });

    await service.runForOrganization('org-1');

    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        type: 'INSIGHT',
        category: 'PERFORMANCE',
        scope: 'CAMPAIGN',
        signal: 'negative',
        source: 'optimizer',
        sourceId: 'reco-1',
        sourceCampaignId: 'campaign-1',
        dedupKey: 'optimizer:org-1:under:targeting_adjustment',
      }),
    );
  });

  it('enregistre un signal positif quand la performance dépasse l\'objectif ("over")', async () => {
    const { service, recordObservation } = buildService({
      performance: 'over',
      summary: 'Dépasse largement l\'objectif',
      actions: [{ type: 'budget_reallocation', description: '...', expectedImpact: '...' }],
    });

    await service.runForOrganization('org-1');

    expect(recordObservation).toHaveBeenCalledWith(expect.objectContaining({ signal: 'positive', dedupKey: 'optimizer:org-1:over:budget_reallocation' }));
  });

  it('n\'enregistre rien pour une performance "on_track" — aucun signal utile, seulement du bruit', async () => {
    const { service, recordObservation } = buildService({ performance: 'on_track', summary: 'Conforme', actions: [] });

    await service.runForOrganization('org-1');

    expect(recordObservation).not.toHaveBeenCalled();
  });

  it('ne fait jamais échouer la génération de recommandation si l\'enregistrement Brand Brain échoue (best-effort)', async () => {
    const { service, recordObservation, optimizationRecommendationCreate } = buildService({
      performance: 'under',
      summary: 'Sous-performance',
      actions: [{ type: 'targeting_adjustment', description: '...', expectedImpact: '...' }],
    });
    recordObservation.mockRejectedValue(new Error('panne'));

    const count = await service.runForOrganization('org-1');

    expect(count).toBe(1); // la campagne est bien comptée comme analysée malgré l'échec Brand Brain
    expect(optimizationRecommendationCreate).toHaveBeenCalled();
  });
});
