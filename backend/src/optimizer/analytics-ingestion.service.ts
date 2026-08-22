import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SocialConnectionsService } from '../social/social-connections.service';
import { TokenCryptoService } from '../common/crypto/token-crypto.service';
import { withRetry } from '../social/retry.util';
import { MetaCapiService } from '../integrations/meta-capi.service';

// Devise unique de l'application — cf. plan-catalog.ts, tous les prix sont en EUR, aucun
// support multi-devise ailleurs dans le produit. Pas une nouvelle incohérence introduite ici.
const DEFAULT_CURRENCY = 'EUR';

interface RawInsights {
  impressions?: number;
  clicks?: number;
  spend?: number;
  conversions?: number;
  conversionValue?: number;
}

// Alimente à la fois CampaignMetric (une ligne PAR CANAL, pas une somme globale — c'est ce
// qui préserve la possibilité de comparer Facebook vs Instagram) et ContentMetric (une ligne
// par publication rattachée à une créative précise, ce qui permet de comparer des variations
// A/B réellement diffusées). Avant cette refonte, tous les posts d'une campagne étaient
// sommés dans une seule ligne, perdant irrémédiablement ces deux granularités.
@Injectable()
export class AnalyticsIngestionService {
  private readonly logger = new Logger(AnalyticsIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionsService: SocialConnectionsService,
    private readonly tokenCrypto: TokenCryptoService,
    private readonly config: ConfigService,
    private readonly metaCapi: MetaCapiService,
  ) {}

  private useMock(): boolean {
    return this.config.get<string>('AI_MODE', 'mock') === 'mock';
  }

  // Récupère les insights de chaque publication de la campagne, groupe par canal pour
  // CampaignMetric, et enregistre une ligne ContentMetric par publication rattachée à une
  // créative connue — sans jamais perdre la granularité en sommant tout ensemble.
  async syncCampaignMetrics(organizationId: string, campaignId: string) {
    const posts = await this.prisma.publishedPost.findMany({
      where: { organizationId, campaignId, status: 'PUBLISHED', externalPostId: { not: null } },
      include: { socialConnection: true },
    });

    if (posts.length === 0) {
      this.logger.debug(`Aucune publication à analyser pour la campagne ${campaignId}`);
      return null;
    }

    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);

    const byPlatform = new Map<string, RawInsights & { count: number }>();
    let anyData = false;

    for (const post of posts) {
      const insights = await this.fetchInsightsForPost(post);
      if (!insights) continue;
      anyData = true;

      // Granularité créative : une ligne ContentMetric par publication rattachée à une
      // version de contenu connue (les publications antérieures à ce chantier, ou publiées
      // hors Content Studio, n'ont pas de contentVersionId — simplement ignorées ici).
      if (post.contentVersionId) {
        await this.prisma.contentMetric.create({
          data: {
            organizationId,
            campaignId,
            contentVersionId: post.contentVersionId,
            publishedPostId: post.id,
            periodStart,
            periodEnd,
            impressions: insights.impressions,
            clicks: insights.clicks,
            spend: insights.spend,
            conversions: insights.conversions,
            conversionValue: insights.conversionValue,
            ctr: insights.impressions && insights.clicks ? (insights.clicks / insights.impressions) * 100 : undefined,
          },
        });
      }

      const agg = byPlatform.get(post.platform) ?? { count: 0 };
      agg.count++;
      agg.impressions = (agg.impressions ?? 0) + (insights.impressions ?? 0);
      agg.clicks = (agg.clicks ?? 0) + (insights.clicks ?? 0);
      agg.spend = (agg.spend ?? 0) + (insights.spend ?? 0);
      agg.conversions = (agg.conversions ?? 0) + (insights.conversions ?? 0);
      agg.conversionValue = (agg.conversionValue ?? 0) + (insights.conversionValue ?? 0);
      byPlatform.set(post.platform, agg);
    }

    if (!anyData) return null;

    // Une ligne CampaignMetric PAR CANAL — jamais une somme tous canaux confondus, qui
    // interdirait ensuite de répondre à "quel canal performe le mieux ?".
    const created = await Promise.all(
      Array.from(byPlatform.entries()).map(([platform, agg]) => {
        const ctr = agg.impressions ? ((agg.clicks ?? 0) / agg.impressions) * 100 : undefined;
        const cpa = agg.clicks && agg.spend ? agg.spend / agg.clicks : undefined;
        const roas = agg.spend && agg.conversionValue ? agg.conversionValue / agg.spend : undefined;

        return this.prisma.campaignMetric.create({
          data: {
            organizationId,
            campaignId,
            platform: platform as any,
            periodStart,
            periodEnd,
            impressions: agg.impressions || undefined,
            clicks: agg.clicks || undefined,
            spend: agg.spend || undefined,
            conversions: agg.conversions || undefined,
            conversionValue: agg.conversionValue || undefined,
            ctr,
            cpa,
            roas,
          },
        });
      }),
    );

    return created;
  }

  private async fetchInsightsForPost(post: {
    id: string;
    platform: string;
    externalPostId: string | null;
    socialConnection: { accessToken: string; externalAccountId: string };
  }): Promise<RawInsights | null> {
    const adapter = this.connectionsService.getAdapterFor(post.platform);

    if (adapter.fetchInsights) {
      try {
        return await withRetry(
          () =>
            adapter.fetchInsights!({
              accessToken: this.tokenCrypto.decrypt(post.socialConnection.accessToken),
              externalPostId: post.externalPostId!,
              externalAccountId: post.socialConnection.externalAccountId,
            }),
          { label: `fetchInsights ${post.platform}`, maxAttempts: 2 },
        );
      } catch (error) {
        this.logger.warn(`Échec de récupération des insights (${post.platform}, ${post.externalPostId}): ${error}`);
        return null;
      }
    }

    if (this.useMock()) {
      // Simulation déterministe pour les plateformes sans adaptateur d'insights encore
      // branché (LinkedIn, Google Ads, TikTok) — permet de tester le pipeline Analytics et
      // Optimizer de bout en bout sans attendre l'implémentation de chaque insights API.
      return this.simulateInsights(post.id);
    }

    this.logger.debug(`Pas d'insights disponibles pour la plateforme ${post.platform} (adaptateur non implémenté)`);
    return null;
  }

  private simulateInsights(seed: string): RawInsights {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    const impressions = 500 + (hash % 4000);
    const clicks = Math.round(impressions * (0.01 + (hash % 5) / 100));
    const spend = Math.round(clicks * (0.3 + (hash % 7) / 10) * 100) / 100;
    const conversions = Math.round(clicks * (0.02 + (hash % 3) / 100));
    const conversionValue = Math.round(conversions * (20 + (hash % 50)) * 100) / 100;
    return { impressions, clicks, spend, conversions, conversionValue };
  }

  // Manuel : enregistre une conversion attribuée par un autre moyen que l'API de la
  // plateforme (code promo, UTM, déclaration commerciale) — sans intégration Conversions
  // API dédiée (Meta/Google), c'est souvent la seule façon réaliste d'obtenir un vrai ROAS.
  async recordManualConversion(organizationId: string, campaignId: string, params: { count: number; value: number; note?: string }) {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);

    const metric = await this.prisma.campaignMetric.create({
      data: {
        organizationId,
        campaignId,
        periodStart,
        periodEnd,
        conversions: params.count,
        conversionValue: params.value,
        raw: params.note ? { note: params.note, source: 'manual' } : { source: 'manual' },
      },
    });

    // Best-effort, hors du chemin critique : la conversion est déjà enregistrée côté
    // Campaign-ai (ROAS calculable) même si ce push externe échoue ou est ignoré (aucune
    // config Meta CAPI, aucun clic récent à attribuer) — cf. MetaCapiService.
    // .catch() défensif (2026-08-22) : pushConversion() protège déjà tout son corps en interne,
    // mais un appel fire-and-forget sans filet ici redeviendrait un crash process-wide au moindre
    // refactor qui romprait cette garantie interne — cf. audit forensic, même classe de bug que
    // narrationPromise (ai-orchestrator.service.ts).
    this.metaCapi
      .pushConversion(organizationId, campaignId, { value: params.value, currency: DEFAULT_CURRENCY })
      .catch((error) => this.logger.error(`Push Meta CAPI non intercepté (campagne ${campaignId}) : ${error}`));

    return metric;
  }

  async getLatestMetric(organizationId: string, campaignId: string) {
    return this.prisma.campaignMetric.findFirst({
      where: { organizationId, campaignId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Vue agrégée tous canaux confondus — utilisée par l'AI Optimizer, qui raisonne au niveau
  // de la campagne entière plutôt que canal par canal. Prend la ligne la plus récente de
  // chaque canal (évite de mélanger un snapshot d'hier sur un canal avec celui du jour sur
  // un autre) et les somme ; les ratios (ctr/cpa/roas) sont recalculés sur les totaux plutôt
  // que moyennés, pour rester mathématiquement corrects.
  async getAggregatedMetric(organizationId: string, campaignId: string) {
    const allMetrics = await this.prisma.campaignMetric.findMany({
      where: { organizationId, campaignId },
      orderBy: { createdAt: 'desc' },
    });
    if (allMetrics.length === 0) return null;

    // Correction de l'audit : recordManualConversion() ne renseigne jamais `platform` (donc
    // clé 'unknown' pour toutes) — avec la logique "la plus récente par plateforme" ci-dessous
    // appliquée telle quelle, plusieurs conversions manuelles déclarées séparément pour la
    // même campagne s'écrasaient les unes les autres et seule la dernière comptait dans le
    // ROAS/CPA agrégé. Distinction nécessaire : une ligne PAR PLATEFORME (sync depuis l'API
    // d'un réseau réel) est un SNAPSHOT cumulatif à un instant donné — seule la plus récente
    // doit compter, la sommer avec les précédentes doublerait les totaux déjà cumulés côté
    // plateforme. Une ligne SANS plateforme (déclaration manuelle) est au contraire un
    // ÉVÉNEMENT ADDITIF discret (une déclaration = une conversion de plus) — toutes doivent
    // être sommées, jamais réduites à la seule plus récente.
    const platformMetrics = allMetrics.filter((m) => m.platform);
    const manualMetrics = allMetrics.filter((m) => !m.platform);

    const latestByPlatform = new Map<string, (typeof allMetrics)[number]>();
    for (const m of platformMetrics) {
      if (!latestByPlatform.has(m.platform!)) latestByPlatform.set(m.platform!, m);
    }

    const rowsToSum = [...latestByPlatform.values(), ...manualMetrics];

    const totals = rowsToSum.reduce(
      (acc, m) => ({
        impressions: acc.impressions + (m.impressions ?? 0),
        clicks: acc.clicks + (m.clicks ?? 0),
        spend: acc.spend + (m.spend ?? 0),
        conversions: acc.conversions + (m.conversions ?? 0),
        conversionValue: acc.conversionValue + (m.conversionValue ?? 0),
      }),
      { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 },
    );

    return {
      ...totals,
      ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null,
      cpa: totals.clicks > 0 && totals.spend > 0 ? totals.spend / totals.clicks : null,
      roas: totals.spend > 0 && totals.conversionValue > 0 ? totals.conversionValue / totals.spend : null,
    };
  }

  async listMetrics(organizationId: string, campaignId: string) {
    return this.prisma.campaignMetric.findMany({
      where: { organizationId, campaignId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
