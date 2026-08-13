import { AnalyticsIngestionService } from './analytics-ingestion.service';
import { PrismaService } from '../prisma/prisma.service';

function buildService(metrics: any[]) {
  const campaignMetricFindMany = jest.fn().mockResolvedValue(metrics);
  const prisma = { campaignMetric: { findMany: campaignMetricFindMany } } as unknown as PrismaService;

  const service = new AnalyticsIngestionService(prisma, {} as any, {} as any, {} as any);
  return { service };
}

function metric(overrides: Partial<{ platform: string | null; impressions: number; clicks: number; spend: number; conversions: number; conversionValue: number }>) {
  return { platform: null, impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, ...overrides };
}

// Couvre la correction de l'audit : recordManualConversion() ne renseigne jamais `platform`,
// donc toutes les déclarations manuelles partageaient la même clé 'unknown' — avec l'ancienne
// logique "la plus récente par plateforme", une seconde déclaration manuelle écrasait
// silencieusement la première dans le ROAS/CPA agrégé au lieu de s'y ajouter.
describe('AnalyticsIngestionService.getAggregatedMetric', () => {
  it('somme TOUTES les conversions manuelles (platform=null), jamais seulement la plus récente', async () => {
    const { service } = buildService([
      metric({ platform: null, conversions: 5, conversionValue: 100, spend: 0 }), // plus récente (ordre desc simulé par le mock)
      metric({ platform: null, conversions: 3, conversionValue: 60, spend: 0 }), // ancienne déclaration — doit compter aussi
    ]);

    const result = await service.getAggregatedMetric('org-1', 'campaign-1');

    expect(result!.conversions).toBe(8);
    expect(result!.conversionValue).toBe(160);
  });

  it('ne garde que la ligne la plus RÉCENTE par plateforme réelle (snapshot cumulatif, jamais sommé)', async () => {
    const { service } = buildService([
      metric({ platform: 'META_FACEBOOK', impressions: 1000, clicks: 20, spend: 50 }), // plus récente
      metric({ platform: 'META_FACEBOOK', impressions: 400, clicks: 8, spend: 20 }), // snapshot précédent — ignoré
    ]);

    const result = await service.getAggregatedMetric('org-1', 'campaign-1');

    expect(result!.impressions).toBe(1000);
    expect(result!.spend).toBe(50);
  });

  it('combine correctement plateformes réelles (dernière seulement) et conversions manuelles (toutes sommées)', async () => {
    const { service } = buildService([
      metric({ platform: 'META_FACEBOOK', impressions: 1000, clicks: 20, spend: 50, conversions: 2, conversionValue: 40 }),
      metric({ platform: 'META_FACEBOOK', impressions: 400, clicks: 8, spend: 20, conversions: 1, conversionValue: 20 }), // snapshot précédent, ignoré
      metric({ platform: null, conversions: 5, conversionValue: 100 }), // conversion manuelle 1
      metric({ platform: null, conversions: 3, conversionValue: 60 }), // conversion manuelle 2
    ]);

    const result = await service.getAggregatedMetric('org-1', 'campaign-1');

    expect(result!.impressions).toBe(1000); // dernier snapshot Facebook uniquement
    expect(result!.spend).toBe(50);
    expect(result!.conversions).toBe(10); // 2 (Facebook, dernier snapshot) + 5 + 3 (manuelles, toutes)
    expect(result!.conversionValue).toBe(200); // 40 + 100 + 60
  });

  it('renvoie null quand aucune métrique n\'existe', async () => {
    const { service } = buildService([]);

    expect(await service.getAggregatedMetric('org-1', 'campaign-1')).toBeNull();
  });
});
