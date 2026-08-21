import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock Prisma minimal : seules les méthodes réellement appelées par EntitlementsService
// sont fournies, chacune contrôlable par test pour simuler différents états d'abonnement
// sans jamais toucher à une vraie base de données.
function buildPrismaMock(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    subscription: { findUnique: jest.fn() },
    membership: { count: jest.fn() },
    invitation: { count: jest.fn() },
    campaign: { count: jest.fn() },
    aiGeneration: { aggregate: jest.fn(), count: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    publishedPost: { count: jest.fn() },
    optimizationRecommendation: { count: jest.fn() },
    ...overrides,
  } as unknown as PrismaService;
}

describe('EntitlementsService', () => {
  describe('assertActiveSubscription', () => {
    it('n\'échoue pas pour un abonnement "active"', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ status: 'active' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertActiveSubscription('org-1')).resolves.toBeUndefined();
    });

    it('n\'échoue pas pour un essai en cours ("trialing")', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ status: 'trialing' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertActiveSubscription('org-1')).resolves.toBeUndefined();
    });

    it('bloque un essai expiré sans conversion', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ status: 'expired' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertActiveSubscription('org-1')).rejects.toThrow(ForbiddenException);
    });

    it('bloque un abonnement résilié', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ status: 'canceled' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertActiveSubscription('org-1')).rejects.toThrow(ForbiddenException);
    });

    it('bloque un paiement en échec (past_due)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ status: 'past_due' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertActiveSubscription('org-1')).rejects.toThrow(ForbiddenException);
    });

    // Statut posé exclusivement par une action d'administration plateforme (abus, impayé
    // au-delà du délai de grâce, investigation) — jamais par un webhook Stripe. Distinct de
    // 'canceled' (résiliation décidée par le client lui-même). Jamais testé avant cette passe.
    it('bloque un compte suspendu par l\'équipe Campaign-ai', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ status: 'suspended' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertActiveSubscription('org-1')).rejects.toThrow(ForbiddenException);
      await expect(service.assertActiveSubscription('org-1')).rejects.toThrow(/suspendu/);
    });

    // NotFoundException, pas ForbiddenException : corrigé pour que l'absence d'abonnement
    // produise toujours le même code HTTP (404) que getCurrentPlan(), quel que soit le point
    // d'entrée — avant ce correctif, cette même condition racine donnait un 403 ici mais un
    // 404 via getCurrentPlan() (appelé par assertSeatAvailable, assertFeature, etc.).
    it('bloque une organisation sans aucun abonnement (NotFoundException, alignée sur getCurrentPlan)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue(null);
      const service = new EntitlementsService(prisma);
      await expect(service.assertActiveSubscription('org-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('assertCreditsAvailable', () => {
    it('autorise quand des crédits du plan restent disponibles', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ aiCreditsUsed: 100, aiCreditsIncluded: 500, extraCredits: 0 });
      const service = new EntitlementsService(prisma);
      await expect(service.assertCreditsAvailable('org-1')).resolves.toBeUndefined();
    });

    it('bloque une organisation sans aucun abonnement (NotFoundException, même correction qu\'assertActiveSubscription)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue(null);
      const service = new EntitlementsService(prisma);
      await expect(service.assertCreditsAvailable('org-1')).rejects.toThrow(NotFoundException);
    });

    it('bloque quand le quota du plan ET le solde de packs sont tous deux épuisés', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'starter', aiCreditsUsed: 500, aiCreditsIncluded: 500, extraCredits: 0 });
      const service = new EntitlementsService(prisma);
      await expect(service.assertCreditsAvailable('org-1')).rejects.toThrow(ForbiddenException);
    });

    // Le cœur du correctif demandé : un quota de plan épuisé ne doit JAMAIS bloquer un
    // client qui a un solde de pack payant restant — sinon l'achat n'aurait servi à rien.
    it('autorise quand le quota du plan est épuisé MAIS qu\'un solde de pack reste disponible', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'starter', aiCreditsUsed: 500, aiCreditsIncluded: 500, extraCredits: 200 });
      const service = new EntitlementsService(prisma);
      await expect(service.assertCreditsAvailable('org-1')).resolves.toBeUndefined();
    });
  });

  describe('consumeCredits', () => {
    it('consomme le solde de packs achetés (extraCredits) en priorité, jamais aiCreditsUsed tant qu\'il en reste', async () => {
      const update = jest.fn().mockResolvedValue({});
      const findUnique = jest.fn().mockResolvedValue({ extraCredits: 50, aiCreditsUsed: 100 });
      const prisma = {
        subscription: { findUnique, update },
        $transaction: jest.fn((cb: any) => cb({ subscription: { findUnique, update } })),
      } as unknown as PrismaService;
      const service = new EntitlementsService(prisma);

      await service.consumeCredits('org-1', 8);

      expect(update).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
        data: { extraCredits: { decrement: 8 }, aiCreditsUsed: { increment: 0 } },
      });
    });

    it('répartit la consommation entre extraCredits et aiCreditsUsed quand le solde de pack ne couvre pas tout le coût', async () => {
      const update = jest.fn().mockResolvedValue({});
      const findUnique = jest.fn().mockResolvedValue({ extraCredits: 3, aiCreditsUsed: 100 });
      const prisma = {
        subscription: { findUnique, update },
        $transaction: jest.fn((cb: any) => cb({ subscription: { findUnique, update } })),
      } as unknown as PrismaService;
      const service = new EntitlementsService(prisma);

      // Coût de 8 crédits, seulement 3 disponibles en pack : 3 pris sur extraCredits, les
      // 5 restants tombent sur le quota du plan (aiCreditsUsed) — jamais l'inverse.
      await service.consumeCredits('org-1', 8);

      expect(update).toHaveBeenCalledWith({
        where: { organizationId: 'org-1' },
        data: { extraCredits: { decrement: 3 }, aiCreditsUsed: { increment: 5 } },
      });
    });

    it('ne fait rien pour un montant nul ou négatif (ex: modération, jamais facturée)', async () => {
      const update = jest.fn();
      const prisma = { subscription: { update }, $transaction: jest.fn() } as unknown as PrismaService;
      const service = new EntitlementsService(prisma);

      await service.consumeCredits('org-1', 0);

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('assertBudgetAvailable', () => {
    it('n\'effectue aucune vérification si monthlyBudgetUsd n\'est pas configuré', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ monthlyBudgetUsd: null });
      const service = new EntitlementsService(prisma);
      await expect(service.assertBudgetAvailable('org-1')).resolves.toBeUndefined();
      // Le point important : aucune requête d'agrégation n'est faite si le plafond n'existe pas.
      expect(prisma.aiGeneration.aggregate).not.toHaveBeenCalled();
    });

    it('bloque quand la dépense réelle du mois atteint le plafond configuré', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ monthlyBudgetUsd: 50 });
      (prisma.aiGeneration.aggregate as jest.Mock).mockResolvedValue({ _sum: { costEstimate: 55 } });
      const service = new EntitlementsService(prisma);
      await expect(service.assertBudgetAvailable('org-1')).rejects.toThrow(ForbiddenException);
    });

    it('autorise quand la dépense reste sous le plafond', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ monthlyBudgetUsd: 50 });
      (prisma.aiGeneration.aggregate as jest.Mock).mockResolvedValue({ _sum: { costEstimate: 10 } });
      const service = new EntitlementsService(prisma);
      await expect(service.assertBudgetAvailable('org-1')).resolves.toBeUndefined();
    });
  });

  describe('assertSeatAvailable', () => {
    it('compte les membres ET les invitations en attente comme sièges occupés (plan starter: 3 max)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'starter' });
      (prisma.membership.count as jest.Mock).mockResolvedValue(2);
      (prisma.invitation.count as jest.Mock).mockResolvedValue(1); // 2 + 1 = 3 = limite du plan starter
      const service = new EntitlementsService(prisma);
      await expect(service.assertSeatAvailable('org-1')).rejects.toThrow(ForbiddenException);
    });

    it('autorise en dessous de la limite de sièges', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'starter' });
      (prisma.membership.count as jest.Mock).mockResolvedValue(1);
      (prisma.invitation.count as jest.Mock).mockResolvedValue(0);
      const service = new EntitlementsService(prisma);
      await expect(service.assertSeatAvailable('org-1')).resolves.toBeUndefined();
    });
  });

  // P0.9 (chantier "Creative Intelligence Engine & Video Quality Loop", 2026-08-18) — extrait
  // pour que CostControlService puisse estimer un coût à venir contre le solde réel.
  describe('getRemainingCredits', () => {
    it('quota du plan restant + solde de packs achetés', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ aiCreditsIncluded: 500, aiCreditsUsed: 300, extraCredits: 50 });
      const service = new EntitlementsService(prisma);

      await expect(service.getRemainingCredits('org-1')).resolves.toBe(250);
    });

    it('jamais négatif même si aiCreditsUsed dépasse aiCreditsIncluded (le solde de packs reste ajouté)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ aiCreditsIncluded: 300, aiCreditsUsed: 350, extraCredits: 20 });
      const service = new EntitlementsService(prisma);

      await expect(service.getRemainingCredits('org-1')).resolves.toBe(20);
    });

    it('aucun abonnement : lève NotFoundException, même comportement que les autres assert*', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue(null);
      const service = new EntitlementsService(prisma);

      await expect(service.getRemainingCredits('org-1')).rejects.toThrow(NotFoundException);
    });
  });

  // Plafonds dédiés de l'essai gratuit — cf. plan-catalog.ts (plan 'trial') : ces tests
  // utilisent le VRAI catalogue de plans (getPlan n'est pas mocké), pour vérifier les
  // valeurs réelles annoncées commercialement (300 crédits, 10 images, 1 vidéo, 10
  // publications, 1 analyse Optimizer, Meta/Instagram/LinkedIn uniquement).
  describe('plafonds dédiés du plan "trial"', () => {
    it('assertImageQuotaAvailable bloque à partir de 10 images générées', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(10);
      const service = new EntitlementsService(prisma);
      await expect(service.assertImageQuotaAvailable('org-1')).rejects.toThrow(ForbiddenException);
    });

    it('assertImageQuotaAvailable autorise sous la limite', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(9);
      const service = new EntitlementsService(prisma);
      await expect(service.assertImageQuotaAvailable('org-1')).resolves.toBeUndefined();
    });

    // Bug corrigé le 2026-08-18 : avant la séparation en deux plafonds, le 2e/3e plan d'UNE
    // MÊME campagne (storyboard multi-plans, cf. VideoDirectorService) échouait dès qu'un
    // premier clip avait réussi — chaque campagne dégradait systématiquement à 1 seul plan
    // figé. Ces tests couvrent explicitement le cas qui a motivé la correction.
    describe('assertVideoQuotaAvailable — plafond par campagne (maxVideoShotsPerCampaign)', () => {
      it('autorise le 2e plan de LA MÊME campagne (storyboard en cours, sous le plafond de 6)', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        // 1 clip déjà réussi pour cette campagne (le compte est filtré par campaignId).
        (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(1);
        const service = new EntitlementsService(prisma);
        await expect(service.assertVideoQuotaAvailable('org-1', 'camp-1')).resolves.toBeUndefined();
      });

      it('bloque le 7e plan de la même campagne (limite = 6, pire cas 3 plans × 2 essais)', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(6);
        const service = new EntitlementsService(prisma);
        await expect(service.assertVideoQuotaAvailable('org-1', 'camp-1')).rejects.toThrow(ForbiddenException);
      });
    });

    describe('assertVideoQuotaAvailable — plafond par organisation (maxVideos, campagnes distinctes)', () => {
      it('autorise une toute première campagne vidéo (aucune campagne distincte avec vidéo)', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(0);
        (prisma.aiGeneration.findMany as jest.Mock).mockResolvedValue([]);
        const service = new EntitlementsService(prisma);
        await expect(service.assertVideoQuotaAvailable('org-1', 'camp-1')).resolves.toBeUndefined();
      });

      it('bloque une NOUVELLE campagne vidéo quand une autre campagne a déjà consommé le quota (limite = 1)', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(0);
        (prisma.aiGeneration.findMany as jest.Mock).mockResolvedValue([{ campaignId: 'autre-campagne' }]);
        const service = new EntitlementsService(prisma);
        await expect(service.assertVideoQuotaAvailable('org-1', 'camp-2')).rejects.toThrow(ForbiddenException);
      });

      it('ne bloque JAMAIS la campagne déjà en cours à cause d\'elle-même (exclue du comptage)', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(2); // sous maxVideoShotsPerCampaign (6)
        (prisma.aiGeneration.findMany as jest.Mock).mockResolvedValue([]); // camp-1 exclue par le filtre "not: campaignId"
        const service = new EntitlementsService(prisma);
        await expect(service.assertVideoQuotaAvailable('org-1', 'camp-1')).resolves.toBeUndefined();
        expect(prisma.aiGeneration.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ campaignId: { not: 'camp-1' } }) }),
        );
      });
    });

    describe('assertVideoQuotaAvailable — paramètre tx optionnel (Phase M)', () => {
      it('fonctionne identiquement à l\'appel sans tx (non-régression) quand tx est omis', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(1);
        const service = new EntitlementsService(prisma);
        await expect(service.assertVideoQuotaAvailable('org-1', 'camp-1')).resolves.toBeUndefined();
      });

      it('utilise tx.aiGeneration au lieu de this.prisma.aiGeneration quand tx est fourni', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        const tx = { aiGeneration: { count: jest.fn().mockResolvedValue(1), findMany: jest.fn().mockResolvedValue([]) } };
        const service = new EntitlementsService(prisma);

        await expect(service.assertVideoQuotaAvailable('org-1', 'camp-1', tx as any)).resolves.toBeUndefined();

        expect(tx.aiGeneration.count).toHaveBeenCalled();
        expect(prisma.aiGeneration.count).not.toHaveBeenCalled();
      });

      it('rejette via tx exactement comme via this.prisma quand le plafond est atteint', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        const tx = { aiGeneration: { count: jest.fn().mockResolvedValue(6), findMany: jest.fn().mockResolvedValue([]) } };
        const service = new EntitlementsService(prisma);

        await expect(service.assertVideoQuotaAvailable('org-1', 'camp-1', tx as any)).rejects.toThrow(ForbiddenException);
      });
    });

    describe('getRemainingVideoShotSlots (Phase M)', () => {
      it('retourne le nombre de créneaux restants (plafond - déjà réussis)', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(4); // plafond trial = 6
        const service = new EntitlementsService(prisma);

        await expect(service.getRemainingVideoShotSlots('org-1', 'camp-1')).resolves.toBe(2);
      });

      it('ne descend jamais sous 0 même si le compte dépasse le plafond', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
        (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(9);
        const service = new EntitlementsService(prisma);

        await expect(service.getRemainingVideoShotSlots('org-1', 'camp-1')).resolves.toBe(0);
      });

      it('retourne null (illimité) quand maxVideoShotsPerCampaign est null, sans requête de comptage', async () => {
        const prisma = buildPrismaMock();
        (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'growth' });
        const service = new EntitlementsService(prisma);

        await expect(service.getRemainingVideoShotSlots('org-1', 'camp-1')).resolves.toBeNull();
        expect(prisma.aiGeneration.count).not.toHaveBeenCalled();
      });
    });

    it('assertSocialPostQuotaAvailable bloque à partir de 10 publications réelles', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      (prisma.publishedPost.count as jest.Mock).mockResolvedValue(10);
      const service = new EntitlementsService(prisma);
      await expect(service.assertSocialPostQuotaAvailable('org-1')).rejects.toThrow(ForbiddenException);
    });

    it('assertOptimizerRunAvailable bloque dès la 1ère analyse (limite = 1)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      (prisma.optimizationRecommendation.count as jest.Mock).mockResolvedValue(1);
      const service = new EntitlementsService(prisma);
      await expect(service.assertOptimizerRunAvailable('org-1')).rejects.toThrow(ForbiddenException);
    });

    it('assertChannelsAllowed autorise Meta et LinkedIn pendant l\'essai', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertChannelsAllowed('org-1', ['META_FACEBOOK', 'LINKEDIN'])).resolves.toBeUndefined();
    });

    it('assertChannelsAllowed bloque Google Ads et TikTok pendant l\'essai', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertChannelsAllowed('org-1', ['GOOGLE_ADS'])).rejects.toThrow(ForbiddenException);
      await expect(service.assertChannelsAllowed('org-1', ['TIKTOK'])).rejects.toThrow(ForbiddenException);
    });

    it('ces plafonds ne s\'appliquent JAMAIS aux plans payants (maxImages=null etc.)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'growth' });
      const service = new EntitlementsService(prisma);

      await expect(service.assertImageQuotaAvailable('org-1')).resolves.toBeUndefined();
      await expect(service.assertVideoQuotaAvailable('org-1')).resolves.toBeUndefined();
      await expect(service.assertSocialPostQuotaAvailable('org-1')).resolves.toBeUndefined();
      await expect(service.assertOptimizerRunAvailable('org-1')).resolves.toBeUndefined();
      await expect(service.assertChannelsAllowed('org-1', ['GOOGLE_ADS', 'TIKTOK'])).resolves.toBeUndefined();
      // Aucune requête de comptage n'est nécessaire quand la limite est null — vérifie
      // que le "no-op" est réel, pas juste une coïncidence de mock par défaut.
      expect(prisma.aiGeneration.count).not.toHaveBeenCalled();
      expect(prisma.aiGeneration.findMany).not.toHaveBeenCalled();
      expect(prisma.publishedPost.count).not.toHaveBeenCalled();
      expect(prisma.optimizationRecommendation.count).not.toHaveBeenCalled();
    });
  });

  // Le cœur de la demande : un plafond atteint doit porter les données structurées
  // nécessaires au frontend pour proposer explicitement le plan supérieur, pas juste
  // un message d'erreur générique — cf. PlanLimitExceededException et le correctif de
  // GlobalExceptionFilter (qui préservait auparavant seulement `.message`).
  describe('invitation à l\'upgrade (PlanLimitExceededException)', () => {
    it('un essai qui atteint un plafond recommande explicitement le plan Growth', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      // Pas de campaignId transmis (nouvelle campagne encore sans clip) : seul le plafond
      // maxVideos (campagnes distinctes, via findMany) s'applique.
      (prisma.aiGeneration.findMany as jest.Mock).mockResolvedValue([{ campaignId: 'autre-campagne' }]);
      const service = new EntitlementsService(prisma);

      try {
        await service.assertVideoQuotaAvailable('org-1');
        fail('devait lever une exception');
      } catch (error: any) {
        const body = error.getResponse();
        expect(body.code).toBe('PLAN_LIMIT_EXCEEDED');
        expect(body.limitType).toBe('videos');
        expect(body.currentPlan).toBe('trial');
        expect(body.recommendedPlan).toBe('growth');
        expect(body.current).toBe(1);
        expect(body.limit).toBe(1);
      }
    });

    it('un plan Business qui atteint sa limite de sièges recommande Enterprise, pas Growth', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'business' });
      (prisma.membership.count as jest.Mock).mockResolvedValue(30);
      (prisma.invitation.count as jest.Mock).mockResolvedValue(0);
      const service = new EntitlementsService(prisma);

      try {
        await service.assertSeatAvailable('org-1');
        fail('devait lever une exception');
      } catch (error: any) {
        expect(error.getResponse().recommendedPlan).toBe('enterprise');
      }
    });

    it('un plan Enterprise qui atteint une limite ne recommande aucun upgrade (déjà au sommet)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'enterprise', aiCreditsUsed: 30000, aiCreditsIncluded: 30000, extraCredits: 0 });
      const service = new EntitlementsService(prisma);

      try {
        await service.assertCreditsAvailable('org-1');
        fail('devait lever une exception');
      } catch (error: any) {
        expect(error.getResponse().recommendedPlan).toBeNull();
        expect(error.getResponse().message).toContain('contactez-nous');
      }
    });
  });

  // Jamais testées avant cette passe (audit du 2026-08-13).
  describe('assertFeature', () => {
    it('autorise une fonctionnalité incluse dans le plan (apiAccess pour Business)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'business' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertFeature('org-1', 'apiAccess')).resolves.toBeUndefined();
    });

    it('bloque une fonctionnalité absente du plan (apiAccess pour Starter)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'starter' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertFeature('org-1', 'apiAccess')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('assertChannelAvailable', () => {
    it('bloque une demande de canaux simultanés au-delà du plafond du plan (essai : 3)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertChannelAvailable('org-1', 4)).rejects.toThrow(ForbiddenException);
    });

    it('autorise sous le plafond', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'trial' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertChannelAvailable('org-1', 3)).resolves.toBeUndefined();
    });

    it('illimité sur les plans où maxChannels est null (ex: Growth)', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({ plan: 'growth' });
      const service = new EntitlementsService(prisma);
      await expect(service.assertChannelAvailable('org-1', 50)).resolves.toBeUndefined();
    });
  });

  describe('getUsageSummary', () => {
    it('agrège sièges/campagnes/crédits/quotas dédiés en une seule vue, avec les bons libellés de limite par plan', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({
        plan: 'trial', aiCreditsUsed: 120, aiCreditsIncluded: 300, extraCredits: 50,
      });
      (prisma.membership.count as jest.Mock).mockResolvedValue(2);
      (prisma.invitation.count as jest.Mock).mockResolvedValue(1);
      (prisma.campaign.count as jest.Mock).mockResolvedValue(2);
      (prisma.aiGeneration.count as jest.Mock).mockResolvedValueOnce(5).mockResolvedValueOnce(1); // images puis vidéos
      (prisma.publishedPost.count as jest.Mock).mockResolvedValue(3);
      (prisma.optimizationRecommendation.count as jest.Mock).mockResolvedValue(0);
      const service = new EntitlementsService(prisma);

      const summary = await service.getUsageSummary('org-1');

      expect(summary.plan.key).toBe('trial');
      expect(summary.usage.seats).toEqual({ used: 3, limit: 2 }); // 2 membres + 1 invitation en attente
      expect(summary.usage.activeCampaigns).toEqual({ used: 2, limit: 3 });
      expect(summary.usage.aiCredits).toEqual({ used: 120, limit: 300 });
      expect(summary.usage.extraCredits).toBe(50);
      expect(summary.usage.images).toEqual({ used: 5, limit: 10 });
      expect(summary.usage.videos).toEqual({ used: 1, limit: 1 });
      expect(summary.usage.socialPosts).toEqual({ used: 3, limit: 10 });
      expect(summary.usage.optimizerRuns).toEqual({ used: 0, limit: 1 });
    });

    it('ne plante pas sans abonnement (subscription null) : crédits à 0, pas une exception', async () => {
      const prisma = buildPrismaMock();
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.membership.count as jest.Mock).mockResolvedValue(0);
      (prisma.invitation.count as jest.Mock).mockResolvedValue(0);
      (prisma.campaign.count as jest.Mock).mockResolvedValue(0);
      (prisma.aiGeneration.count as jest.Mock).mockResolvedValue(0);
      (prisma.publishedPost.count as jest.Mock).mockResolvedValue(0);
      (prisma.optimizationRecommendation.count as jest.Mock).mockResolvedValue(0);
      const service = new EntitlementsService(prisma);

      // getCurrentPlan() lève NotFoundException sans abonnement — getUsageSummary() en dépend
      // via Promise.all, donc l'absence d'abonnement reste une 404 cohérente avec le reste du
      // service (cf. items 83 de l'audit), pas un crash générique.
      await expect(service.getUsageSummary('org-1')).rejects.toThrow(NotFoundException);
    });
  });
});
