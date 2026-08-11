import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService } from '../ai/ai-gateway/ai-gateway.service';
import { AnalyticsIngestionService } from './analytics-ingestion.service';
import { BrandService } from '../brand/brand.service';
import { EntitlementsService } from '../plans/entitlements.service';

// Module 16 — AI Optimizer : "Chaque nuit, Campaign-ai analysera toutes les campagnes puis
// proposera nouveaux textes / nouveaux visuels / nouveau ciblage / nouveau budget / nouveau
// calendrier." C'est ce mécanisme qui justifie un abonnement récurrent plutôt qu'un outil
// ponctuel — la valeur de Campaign-ai continue de croître après la publication initiale.
//
// Principe non négociable, cohérent avec le reste de la plateforme : l'Optimizer PROPOSE,
// il n'applique JAMAIS automatiquement une modification sur une campagne ou un compte
// publicitaire réel. Chaque recommandation reste PENDING jusqu'à décision humaine explicite
// (cf. OptimizerService.applyRecommendation / dismissRecommendation).
@Injectable()
export class AiOptimizerService {
  private readonly logger = new Logger(AiOptimizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiGateway: AiGatewayService,
    private readonly analyticsIngestion: AnalyticsIngestionService,
    private readonly brandService: BrandService,
    private readonly entitlements: EntitlementsService,
    private readonly config: ConfigService,
  ) {}

  // Exécution nocturne automatique. 2h du matin : après la fin probable des pics de trafic
  // du jour, avant le début de la journée de travail des équipes marketing qui liront les
  // recommandations le lendemain matin.
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyOptimization() {
    this.logger.log("Démarrage de l'analyse nocturne AI Optimizer");

    const organizations = await this.prisma.organization.findMany({
      where: { subscription: { status: { in: ['active', 'trialing'] } } },
      select: { id: true },
    });

    let processed = 0;
    for (const org of organizations) {
      processed += await this.runForOrganization(org.id);
    }

    this.logger.log(`AI Optimizer terminé : ${processed} campagne(s) analysée(s) sur ${organizations.length} organisation(s)`);
  }

  // Exposé séparément pour permettre un déclenchement manuel (tests, démo) sans attendre
  // le cron — cf. OptimizerController.
  async runForOrganization(organizationId: string): Promise<number> {
    const campaigns = await this.prisma.campaign.findMany({
      where: { organizationId, status: 'PUBLISHED' },
      include: { organization: { include: { brandKit: true } } },
    });

    let count = 0;
    for (const campaign of campaigns) {
      try {
        await this.analyzeCampaign(campaign.id, organizationId);
        count++;
      } catch (error) {
        this.logger.error(`Échec de l'analyse de la campagne ${campaign.id}: ${error}`);
      }
    }
    return count;
  }

  private async analyzeCampaign(campaignId: string, organizationId: string) {
    // Étape 1 : rafraîchir les métriques avant d'analyser, pour raisonner sur des données à jour.
    await this.analyticsIngestion.syncCampaignMetrics(organizationId, campaignId);

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { organization: { include: { brandKit: true } } },
    });
    if (!campaign) return;

    const latestMetric = await this.analyticsIngestion.getAggregatedMetric(organizationId, campaignId);
    if (!latestMetric) {
      this.logger.debug(`Pas encore de métriques pour la campagne ${campaignId}, analyse reportée`);
      return;
    }

    // Plafond dédié (essai gratuit) : "1 analyse Optimizer" pour toute la durée de l'essai —
    // vérifié ici, juste avant l'appel IA qui a un coût réel, pas avant (les étapes
    // précédentes — sync des métriques — ne coûtent rien). Lève une exception attrapée par
    // le try/catch de runForOrganization() : les campagnes suivantes de la boucle ne sont
    // simplement pas analysées une fois le quota atteint, sans interrompre le run entier.
    await this.entitlements.assertOptimizerRunAvailable(organizationId);

    const recommendation = await this.generateRecommendation(organizationId, campaignId, campaign, latestMetric);
    if (!recommendation) return;

    // Éligibilité à une automatisation FUTURE (non exécutée aujourd'hui, cf. AutomationService) :
    // seules les recommandations dont TOUTES les actions sont d'un type jugé sûr à automatiser
    // (pause_channel — réversible, sans impact créatif) sont marquées éligibles. Un changement
    // créatif ou une réallocation budgétaire exigent toujours un jugement humain.
    const SAFE_ACTION_TYPES = ['pause_channel'];
    const actions = (recommendation.details as { actions?: Array<{ type: string }> })?.actions ?? [];
    const automationEligible = actions.length > 0 && actions.every((a) => SAFE_ACTION_TYPES.includes(a.type));

    await this.prisma.optimizationRecommendation.create({
      data: {
        organizationId,
        campaignId,
        summary: recommendation.summary,
        details: recommendation.details as any,
        status: 'PENDING',
        automationEligible,
      },
    });
    this.logger.log(`Nouvelle recommandation générée pour la campagne ${campaignId}`);

    // Brand Brain : seules les performances notables (au-dessus ou en-dessous de l'objectif)
    // méritent de nourrir la mémoire de marque — un simple "on_track" répété chaque nuit
    // n'apporterait aucun signal utile aux futures générations, seulement du bruit.
    const performance = (recommendation.details as { performance?: string })?.performance;
    if (performance === 'under' || performance === 'over') {
      await this.brandService.logMemory(
        organizationId,
        'PERFORMANCE_INSIGHT',
        `Campagne "${campaign.name}" (objectif: ${campaign.objective ?? 'non précisé'}) — performance ${performance === 'under' ? 'en-dessous' : 'au-dessus'} de l'attendu : ${recommendation.summary}`,
        campaignId,
      );
    }
  }

  private async generateRecommendation(
    organizationId: string,
    campaignId: string,
    campaign: {
      name: string;
      objective: string | null;
      budget: number | null;
      channels: unknown;
      organization: { brandKit: { toneOfVoice: string | null } | null };
    },
    metric: {
      impressions: number | null;
      clicks: number | null;
      spend: number | null;
      ctr: number | null;
      cpa: number | null;
      conversions?: number | null;
      conversionValue?: number | null;
      roas?: number | null;
    },
  ): Promise<{ summary: string; details: unknown } | null> {
    if (this.config.get<string>('AI_MODE', 'mock') === 'mock') {
      return {
        summary: `(simulation) Campagne "${campaign.name}" en ligne avec l'objectif, marge d'optimisation sur le ciblage`,
        details: {
          performance: 'on_track',
          actions: [
            {
              type: 'creative_refresh',
              description: 'Tester une nouvelle accroche mettant davantage en avant le bénéfice principal identifié à l\'analyse produit',
              expectedImpact: '+10 à 15% de CTR estimé',
            },
            {
              type: 'targeting_adjustment',
              description: 'Élargir légèrement l\'audience sur le canal le plus performant',
              expectedImpact: 'Réduction du CPA de ~5%',
            },
          ],
        },
      };
    }

    const prompt = `Tu es l'AI Optimizer d'une plateforme marketing. Analyse la performance de cette campagne publiée et propose des ajustements concrets.

Campagne : ${campaign.name}
Objectif : ${campaign.objective ?? 'non précisé'}
Budget : ${campaign.budget ?? 'non précisé'} €
Canaux : ${JSON.stringify(campaign.channels ?? [])}
Ton de marque : ${campaign.organization.brandKit?.toneOfVoice ?? 'non précisé'}

Performance des dernières 24h :
- Impressions : ${metric.impressions ?? 'N/A'}
- Clics : ${metric.clicks ?? 'N/A'}
- Dépense : ${metric.spend ?? 'N/A'} €
- CTR : ${metric.ctr?.toFixed(2) ?? 'N/A'}%
- CPA : ${metric.cpa?.toFixed(2) ?? 'N/A'} €
- Conversions : ${metric.conversions ?? 'N/A'}
- ROAS : ${metric.roas ? metric.roas.toFixed(2) + 'x' : 'N/A (aucune valeur de conversion enregistrée)'}

Réponds UNIQUEMENT en JSON strict, sans texte autour :
{
  "performance": "under" | "on_track" | "over",
  "summary": "résumé en une phrase de l'état de la campagne",
  "actions": [
    {"type": "budget_reallocation" | "creative_refresh" | "targeting_adjustment" | "pause_channel" | "schedule_change", "description": "...", "expectedImpact": "..."}
  ]
}
Propose 1 à 3 actions maximum, concrètes et directement actionnables par un marketeur.`;

    try {
      const ctx = { organizationId, campaignId, purpose: 'optimizer' as const };
      const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic'); // raisonnement -> Claude, cf. chapitre 5.4 du Volume 2
      const parsed = JSON.parse(result.content);
      return { summary: parsed.summary, details: { performance: parsed.performance, actions: parsed.actions } };
    } catch (error) {
      this.logger.error(`Échec de génération de recommandation: ${error}`);
      return null;
    }
  }
}
