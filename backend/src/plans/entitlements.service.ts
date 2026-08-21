import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanDefinition, getPlan, getRecommendedUpgrade } from './plan-catalog';
import { PLAN_CATALOG } from './plan-catalog';
import { PlanLimitExceededException, PlanLimitExceededPayload } from './plan-limit.exception';

// Point de passage obligé pour toute action qui doit respecter les limites d'un plan
// (sièges, campagnes actives, canaux, fonctionnalités, crédits IA, statut d'abonnement).
// Principe : chaque service métier (TeamsService, CampaignsService, SocialConnectionsService...)
// appelle une méthode assert*() ici plutôt que de coder ses propres seuils — un changement
// de grille tarifaire ne se répercute qu'à un seul endroit (plan-catalog.ts).
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentPlan(organizationId: string): Promise<PlanDefinition> {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription) throw new NotFoundException('Abonnement introuvable pour cette organisation');
    return getPlan(subscription.plan);
  }

  // Construit systématiquement une exception structurée (jamais un ForbiddenException nu)
  // pour tout plafond de plan — c'est ce qui permet au frontend de transformer un refus en
  // moment de conversion ciblé ("Passez à Growth") plutôt qu'un message d'erreur générique.
  private buildLimitException(
    limitType: PlanLimitExceededPayload['limitType'],
    plan: PlanDefinition,
    current: number,
    limit: number,
    resourceLabel: string,
  ): PlanLimitExceededException {
    const recommendedPlan = getRecommendedUpgrade(plan.key);
    const message = recommendedPlan
      ? `Quota ${resourceLabel} atteint (${current}/${limit}) — passez au plan ${getPlan(recommendedPlan).name} pour continuer`
      : `Quota ${resourceLabel} atteint (${current}/${limit}) — contactez-nous pour discuter d'un accompagnement sur mesure`;

    return new PlanLimitExceededException({
      message,
      code: 'PLAN_LIMIT_EXCEEDED',
      limitType,
      currentPlan: plan.key,
      current,
      limit,
      recommendedPlan,
    });
  }

  // Bloque toute action de création/publication si l'abonnement n'est plus valide —
  // essai expiré sans conversion, ou résiliation arrivée à son terme. Les actions de
  // lecture restent toujours autorisées (l'organisation garde accès à son historique).
  async assertActiveSubscription(organizationId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    // NotFoundException, pas ForbiddenException : même condition (aucune ligne Subscription)
    // que getCurrentPlan() ci-dessus, qui lève déjà NotFoundException pour ce cas — corrigé
    // pour que l'absence d'abonnement produise toujours le même code HTTP (404) quel que soit
    // le point d'entrée, au lieu d'un 403 ici et d'un 404 ailleurs pour la même cause racine.
    if (!subscription) throw new NotFoundException('Abonnement introuvable pour cette organisation');
    if (subscription.status === 'expired' || subscription.status === 'canceled') {
      throw new ForbiddenException(
        `Abonnement ${subscription.status === 'expired' ? 'expiré' : 'résilié'} — veuillez souscrire un plan pour continuer`,
      );
    }
    if (subscription.status === 'past_due') {
      throw new ForbiddenException(
        'Paiement en échec sur votre abonnement — veuillez mettre à jour votre moyen de paiement (portail de facturation)',
      );
    }
    // 'suspended' : statut posé exclusivement par une action d'administration plateforme
    // (cf. AdminService.suspendOrganization) — jamais atteint par un webhook Stripe ou un
    // cycle de facturation normal. Distinct de 'canceled' : une organisation résiliée l'a
    // décidé elle-même, une organisation suspendue l'a été par l'équipe Campaign-ai
    // (abus, impayé au-delà du délai de grâce, investigation en cours).
    if (subscription.status === 'suspended') {
      throw new ForbiddenException(
        'Ce compte a été suspendu par l\'équipe Campaign-ai — contactez le support pour plus d\'informations',
      );
    }
  }

  // Sièges : compte les membres actifs + invitations en attente (une invitation en cours
  // réserve un siège, pour éviter d'inviter au-delà de la limite puis de bloquer l'acceptation).
  async assertSeatAvailable(organizationId: string): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);
    if (plan.maxSeats === null) return; // illimité

    const [memberCount, pendingInvitations] = await Promise.all([
      this.prisma.membership.count({ where: { organizationId } }),
      this.prisma.invitation.count({ where: { organizationId, status: 'PENDING' } }),
    ]);
    const occupiedSeats = memberCount + pendingInvitations;

    if (occupiedSeats >= plan.maxSeats) {
      throw this.buildLimitException('seats', plan, occupiedSeats, plan.maxSeats, 'de sièges');
    }
  }

  async assertActiveCampaignAvailable(organizationId: string): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);
    if (plan.maxActiveCampaigns === null) return;

    const activeCount = await this.prisma.campaign.count({
      where: { organizationId, status: { notIn: ['ARCHIVED', 'REJECTED'] } },
    });
    if (activeCount >= plan.maxActiveCampaigns) {
      throw this.buildLimitException('activeCampaigns', plan, activeCount, plan.maxActiveCampaigns, 'de campagnes actives');
    }
  }

  async assertChannelAvailable(organizationId: string, requestedChannelCount: number): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);
    if (plan.maxChannels === null) return;
    if (requestedChannelCount > plan.maxChannels) {
      throw this.buildLimitException('channels', plan, requestedChannelCount, plan.maxChannels, 'de canaux simultanés');
    }
  }

  async assertFeature(organizationId: string, feature: keyof PlanDefinition['features']): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);
    if (!plan.features[feature]) {
      throw new ForbiddenException(`Cette fonctionnalité n'est pas incluse dans le plan ${plan.name}`);
    }
  }

  // Un compte n'est bloqué que si À LA FOIS le quota du plan ET le solde de packs achetés
  // sont épuisés — un client qui a acheté un pack continue de fonctionner même si son
  // quota mensuel est à zéro, tant que son solde extraCredits n'est pas lui-même épuisé.
  // P0.9 (chantier "Creative Intelligence Engine & Video Quality Loop", 2026-08-18) — extrait
  // l'arithmétique déjà en dur dans assertCreditsAvailable() ci-dessous pour que
  // CostControlService puisse ESTIMER un coût à venir contre le solde réel, sans dupliquer la
  // formule ni interroger Subscription une 2e fois indépendamment.
  async getRemainingCredits(organizationId: string): Promise<number> {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription) throw new NotFoundException('Abonnement introuvable pour cette organisation');
    return Math.max(0, subscription.aiCreditsIncluded - subscription.aiCreditsUsed) + subscription.extraCredits;
  }

  async assertCreditsAvailable(organizationId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    // NotFoundException : même correction et même raison qu'assertActiveSubscription() ci-dessus.
    if (!subscription) throw new NotFoundException('Abonnement introuvable pour cette organisation');

    const planRemaining = subscription.aiCreditsIncluded - subscription.aiCreditsUsed;
    const totalAvailable = planRemaining + subscription.extraCredits;

    if (totalAvailable <= 0) {
      const plan = getPlan(subscription.plan);
      // Limite affichée = quota du plan + solde de packs, pour refléter fidèlement ce que
      // le client a réellement payé — pas seulement le quota de base du plan.
      throw this.buildLimitException(
        'credits',
        plan,
        subscription.aiCreditsUsed,
        subscription.aiCreditsIncluded + subscription.extraCredits,
        'de crédits IA',
      );
    }
  }

  // Décompte réel après un appel IA réussi — appelé par AiGatewayService, jamais par un
  // service métier directement. Consomme extraCredits EN PRIORITÉ : un client qui a payé
  // pour un pack doit voir ce solde s'épuiser avant de toucher au quota mensuel du plan,
  // pas l'inverse (cf. bug corrigé : l'ancienne logique incrémentait aiCreditsIncluded
  // directement à l'achat, gonflant le quota de façon permanente au lieu d'un solde qui
  // s'épuise réellement à l'usage).
  async consumeCredits(organizationId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    await this.prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.findUnique({ where: { organizationId } });
      if (!subscription) return;

      const fromExtra = Math.min(subscription.extraCredits, amount);
      const remainder = amount - fromExtra;

      await tx.subscription.update({
        where: { organizationId },
        data: {
          extraCredits: { decrement: fromExtra },
          aiCreditsUsed: { increment: remainder },
        },
      });
    });
  }

  // Plafonds dédiés (essai gratuit) — comptage GLOBAL depuis la création de l'abonnement,
  // jamais remis à zéro mensuellement contrairement aux crédits : un essai de 14 jours n'a
  // pas de "cycle de facturation" au sens où un abonnement payant en a un, donc "10 images
  // incluses" signifie 10 images sur toute la durée de l'essai, pas 10 par mois. Ces plafonds
  // ne s'appliquent qu'aux plans qui les définissent (non-null) — tous les plans payants les
  // laissent à null (illimité), donc ces vérifications deviennent des no-op après conversion.
  async assertImageQuotaAvailable(organizationId: string): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);
    if (plan.maxImages === null) return;

    const count = await this.prisma.aiGeneration.count({
      where: { organizationId, taskType: 'generateImage', purpose: 'campaign_generation', status: 'SUCCEEDED' },
    });
    if (count >= plan.maxImages) {
      throw this.buildLimitException('images', plan, count, plan.maxImages, "d'images IA de l'essai");
    }
  }

  // Deux plafonds indépendants (cf. commentaires sur PlanDefinition.maxVideos /
  // maxVideoShotsPerCampaign dans plan-catalog.ts) :
  //  1. maxVideoShotsPerCampaign borne le nombre de CLIPS déjà réussis DANS cette campagne —
  //     vérifié en premier, et seul plafond qui peut interrompre un storyboard EN COURS de
  //     génération (2e/3e plan d'une même campagne).
  //  2. maxVideos borne le nombre de CAMPAGNES DISTINCTES ayant déjà eu droit à une vidéo —
  //     ne s'applique qu'à une NOUVELLE campagne (dont aucun clip n'a encore réussi) ; une
  //     campagne déjà en cours de génération vidéo n'est jamais bloquée par ce plafond-là au
  //     milieu de son propre storyboard, même si elle est la campagne "consommée".
  // Bug corrigé le 2026-08-18 : l'ancienne version comptait CHAQUE clip (tous plans confondus)
  // comme "une vidéo" via un unique plafond `maxVideos: 1` — la génération du 2e plan d'une
  // même campagne échouait donc systématiquement, dégradant tout storyboard à 1 seul plan figé.
  // tx optionnel (Phase M, chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — même
  // pattern déjà établi par assertOptimizerRunAvailable ci-dessous : englobe la lecture dans la
  // même transaction que l'écriture qui suit, quand l'appelant le souhaite. Disponible pour un
  // usage futur plus strict (cf. plan, "Hors périmètre") ; ce chantier l'utilise en lecture seule
  // via getRemainingVideoShotSlots pour plafonner un lot de génération parallèle une seule fois
  // en amont, plutôt que de fiabiliser CHAQUE appel individuel par une réservation atomique.
  async assertVideoQuotaAvailable(
    organizationId: string,
    campaignId?: string,
    tx: Pick<PrismaService, 'aiGeneration'> = this.prisma,
  ): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);

    if (plan.maxVideoShotsPerCampaign !== null && campaignId) {
      const shotsForThisCampaign = await tx.aiGeneration.count({
        where: { organizationId, campaignId, taskType: 'generateVideo', purpose: 'campaign_generation', status: 'SUCCEEDED' },
      });
      if (shotsForThisCampaign >= plan.maxVideoShotsPerCampaign) {
        throw this.buildLimitException('videoShots', plan, shotsForThisCampaign, plan.maxVideoShotsPerCampaign, 'de plans vidéo pour cette campagne');
      }
    }

    if (plan.maxVideos !== null) {
      // Campagnes DISTINCTES (autres que la campagne courante) ayant déjà au moins un clip
      // réussi — la campagne courante ne doit jamais se compter elle-même, sinon son propre
      // 2e/3e plan la ferait échouer dès qu'elle a son 1er clip réussi.
      const otherVideoCampaigns = await tx.aiGeneration.findMany({
        where: {
          organizationId,
          taskType: 'generateVideo',
          purpose: 'campaign_generation',
          status: 'SUCCEEDED',
          campaignId: campaignId ? { not: campaignId } : undefined,
        },
        distinct: ['campaignId'],
        select: { campaignId: true },
      });
      const count = otherVideoCampaigns.filter((g) => g.campaignId !== null).length;
      if (count >= plan.maxVideos) {
        throw this.buildLimitException('videos', plan, count, plan.maxVideos, 'de campagnes vidéo de l\'essai');
      }
    }
  }

  // Phase M — lecture seule du nombre de plans vidéo ENCORE disponibles pour cette campagne
  // (maxVideoShotsPerCampaign - déjà réussis), utilisée par AiOrchestratorService pour plafonner
  // la TAILLE d'un lot de génération parallèle avant de le lancer — une seule lecture fixe le lot,
  // élimine le TOCTOU (plusieurs vérifications concurrentes indépendantes lisant le même compte
  // avant qu'aucune n'ait persisté) SANS transaction distribuée par appel. `null` = illimité
  // (plan.maxVideoShotsPerCampaign === null) : jamais plafonné dans ce cas.
  async getRemainingVideoShotSlots(organizationId: string, campaignId: string): Promise<number | null> {
    const plan = await this.getCurrentPlan(organizationId);
    if (plan.maxVideoShotsPerCampaign === null) return null;

    const shotsForThisCampaign = await this.prisma.aiGeneration.count({
      where: { organizationId, campaignId, taskType: 'generateVideo', purpose: 'campaign_generation', status: 'SUCCEEDED' },
    });
    return Math.max(0, plan.maxVideoShotsPerCampaign - shotsForThisCampaign);
  }

  // Publications RÉELLES uniquement (status PUBLISHED) — une tentative échouée ne doit
  // jamais consommer le quota, elle n'a produit aucun coût de diffusion ni de valeur.
  async assertSocialPostQuotaAvailable(organizationId: string): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);
    if (plan.maxSocialPosts === null) return;

    const count = await this.prisma.publishedPost.count({ where: { organizationId, status: 'PUBLISHED' } });
    if (count >= plan.maxSocialPosts) {
      throw this.buildLimitException('socialPosts', plan, count, plan.maxSocialPosts, 'de publications de l\'essai');
    }
  }

  // tx optionnel : permet à l'appelant (AiOptimizerService) d'exécuter cette vérification
  // DANS la même transaction Prisma que la création de la recommandation qui suit
  // immédiatement — corrige une race condition (TOCTOU) identifiée à l'audit : le cron
  // nocturne et un déclenchement manuel (POST /optimizer/run) pouvaient tous deux lire un
  // count() sous le plafond avant qu'aucun n'ait encore créé sa recommandation, dépassant
  // ainsi silencieusement maxOptimizerRuns (notamment le plafond "1 analyse" de l'essai).
  async assertOptimizerRunAvailable(organizationId: string, tx: Pick<PrismaService, 'optimizationRecommendation'> = this.prisma): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);
    if (plan.maxOptimizerRuns === null) return;

    const count = await tx.optimizationRecommendation.count({ where: { organizationId } });
    if (count >= plan.maxOptimizerRuns) {
      throw this.buildLimitException('optimizerRuns', plan, count, plan.maxOptimizerRuns, "d'analyses Optimizer de l'essai");
    }
  }

  // Restreint aux plateformes autorisées par le plan (ex: essai limité à Meta/LinkedIn,
  // sans Google Ads ni TikTok) — distinct de assertChannelAvailable, qui limite un NOMBRE
  // de canaux simultanés, pas LESQUELS. Les deux vérifications sont complémentaires.
  async assertChannelsAllowed(organizationId: string, platforms: string[]): Promise<void> {
    const plan = await this.getCurrentPlan(organizationId);
    if (plan.allowedChannels === null) return;

    const disallowed = platforms.filter((p) => !plan.allowedChannels!.includes(p));
    if (disallowed.length > 0) {
      throw new ForbiddenException(
        `Le plan ${plan.name} n'inclut pas ${disallowed.join(', ')} — plateformes disponibles : ${plan.allowedChannels.join(', ')}`,
      );
    }
  }

  // Économie de l'IA : plafond optionnel en coût réel ($), indépendant du système de crédits.
  // Les crédits sont une unité commerciale (cf. CREDIT_COSTS) qui peut se désynchroniser du
  // coût réel payé aux fournisseurs (hausse tarifaire, choix d'un modèle premium) — ce
  // plafond est le filet de sécurité qui protège la marge même si le compteur de crédits
  // semble encore correct. Non défini (monthlyBudgetUsd=null) = pas de plafond dur, seul le
  // système de crédits limite la consommation.
  async assertBudgetAvailable(organizationId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription?.monthlyBudgetUsd) return; // pas de plafond configuré

    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);

    const { _sum } = await this.prisma.aiGeneration.aggregate({
      where: { organizationId, createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
      _sum: { costEstimate: true },
    });
    const spent = _sum.costEstimate ?? 0;

    if (spent >= subscription.monthlyBudgetUsd) {
      throw new ForbiddenException(
        `Plafond budgétaire IA atteint (${spent.toFixed(2)}$ / ${subscription.monthlyBudgetUsd.toFixed(2)}$ ce mois-ci) — contactez votre administrateur pour l'ajuster`,
      );
    }
  }

  // Vue d'ensemble consommable par le frontend pour afficher barres de progression,
  // bannières d'essai, et boutons d'upgrade contextuels.
  async getUsageSummary(organizationId: string) {
    const [subscription, plan, memberCount, pendingInvitations, activeCampaigns, imageCount, videoCount, postCount, optimizerRunCount] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { organizationId } }),
      this.getCurrentPlan(organizationId),
      this.prisma.membership.count({ where: { organizationId } }),
      this.prisma.invitation.count({ where: { organizationId, status: 'PENDING' } }),
      this.prisma.campaign.count({ where: { organizationId, status: { notIn: ['ARCHIVED', 'REJECTED'] } } }),
      this.prisma.aiGeneration.count({ where: { organizationId, taskType: 'generateImage', purpose: 'campaign_generation', status: 'SUCCEEDED' } }),
      this.prisma.aiGeneration.count({ where: { organizationId, taskType: 'generateVideo', purpose: 'campaign_generation', status: 'SUCCEEDED' } }),
      this.prisma.publishedPost.count({ where: { organizationId, status: 'PUBLISHED' } }),
      this.prisma.optimizationRecommendation.count({ where: { organizationId } }),
    ]);

    return {
      plan,
      subscription,
      usage: {
        seats: { used: memberCount + pendingInvitations, limit: plan.maxSeats },
        activeCampaigns: { used: activeCampaigns, limit: plan.maxActiveCampaigns },
        aiCredits: { used: subscription?.aiCreditsUsed ?? 0, limit: subscription?.aiCreditsIncluded ?? 0 },
        // Solde de packs achetés, distinct du quota du plan — consommé en priorité
        // (cf. consumeCredits) mais affiché séparément pour que le client voie exactement
        // ce qu'il a payé en plus de son abonnement.
        extraCredits: subscription?.extraCredits ?? 0,
        // Uniquement significatif quand le plan définit un plafond dédié (essai) — les
        // limites restent `null` sur les plans payants, cf. PlanDefinition.
        images: { used: imageCount, limit: plan.maxImages },
        videos: { used: videoCount, limit: plan.maxVideos },
        socialPosts: { used: postCount, limit: plan.maxSocialPosts },
        optimizerRuns: { used: optimizerRunCount, limit: plan.maxOptimizerRuns },
      },
    };
  }

  // Le plan 'trial' n'apparaît jamais dans le catalogue public — il n'a pas de Price ID
  // Stripe (stripePriceEnvKey: null) et n'est jamais choisi via Checkout, uniquement
  // accordé automatiquement à l'inscription (cf. AuthService.register).
  listAvailablePlans() {
    return Object.values(PLAN_CATALOG).filter((p) => p.key !== 'trial');
  }
}
