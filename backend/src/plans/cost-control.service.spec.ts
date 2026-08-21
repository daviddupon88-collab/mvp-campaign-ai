import { CostControlService } from './cost-control.service';
import { EntitlementsService } from './entitlements.service';
import { PlanLimitExceededException } from './plan-limit.exception';
import { getPlan } from './plan-catalog';

function buildEntitlementsMock(remainingCredits: number, planKey = 'trial') {
  return {
    getRemainingCredits: jest.fn().mockResolvedValue(remainingCredits),
    getCurrentPlan: jest.fn().mockResolvedValue(getPlan(planKey)),
  } as unknown as EntitlementsService;
}

describe('CostControlService.estimateWorstCase', () => {
  it('coût croissant avec le nombre de canaux et de scènes (pas une constante figée)', async () => {
    const entitlements = buildEntitlementsMock(10000);
    const service = new CostControlService(entitlements);

    const small = await service.estimateWorstCase({ organizationId: 'org-1', channelCount: 1, scenesCount: 2, maxRepairAttempts: 0 });
    const bigger = await service.estimateWorstCase({ organizationId: 'org-1', channelCount: 3, scenesCount: 5, maxRepairAttempts: 2 });

    expect(bigger).toBeGreaterThan(small);
  });

  it('scenesCount pèse le plus lourd dans l\'estimation (150 crédits/plan × 2 essais pire cas)', async () => {
    const entitlements = buildEntitlementsMock(10000);
    const service = new CostControlService(entitlements);

    const oneScene = await service.estimateWorstCase({ organizationId: 'org-1', channelCount: 1, scenesCount: 1, maxRepairAttempts: 0 });
    const twoScenes = await service.estimateWorstCase({ organizationId: 'org-1', channelCount: 1, scenesCount: 2, maxRepairAttempts: 0 });

    // +1 scène = +2×150 (pire cas 2 essais) au minimum.
    expect(twoScenes - oneScene).toBeGreaterThanOrEqual(300);
  });

  // Bug corrigé le 2026-08-18 (constaté lors d'un premier test réel : un essai à 1100 crédits
  // refusé pour un pire cas estimé à 1361) : le nombre de clips vidéo comptés (génération +
  // réparations) ne doit jamais dépasser le plafond RÉEL déjà appliqué en base
  // (PlanDefinition.maxVideoShotsPerCampaign, cf. EntitlementsService.assertVideoQuotaAvailable)
  // — les deux mécanismes de retry partagent le MÊME compteur, jamais additionnés comme s'ils
  // étaient indépendants.
  it('le coût vidéo ne dépasse jamais le plafond réel de clips du plan (maxVideoShotsPerCampaign), même avec un pire cas théorique plus élevé', async () => {
    const entitlements = buildEntitlementsMock(10000, 'trial'); // trial: maxVideoShotsPerCampaign = 6
    const service = new CostControlService(entitlements);

    // Pire cas théorique (avant plafonnement) : 5 scènes × 2 essais + 2 réparations = 12 clips.
    // Plafonné à 6 clips réels (cf. plan-catalog.ts) → 6×150 = 900 crédits pour le poste vidéo.
    const estimated = await service.estimateWorstCase({ organizationId: 'org-1', channelCount: 1, scenesCount: 5, maxRepairAttempts: 2 });

    // fixedCost (99) + 1 canal (8) + vidéo plafonnée (900 + 3 passages Judge × 18 = 954) = 1061.
    expect(estimated).toBe(99 + 8 + 954);
  });
});

describe('CostControlService.assertBeforeGeneration (Checkpoint A)', () => {
  it('crédits largement suffisants : ne lève pas', async () => {
    const entitlements = buildEntitlementsMock(100000);
    const service = new CostControlService(entitlements);

    await expect(service.assertBeforeGeneration('org-1', 2, 2)).resolves.toEqual(expect.any(Number));
  });

  // Phase A (chantier V2, 2026-08-19) — bug corrigé : cette méthode était `void`, l'estimation
  // réelle n'était jamais remontée à l'appelant (persistée en dur à 0 dans CreativeGenerationTrace).
  it("retourne l'estimation réellement calculée (pas void) — thread jusqu'à CreativeGenerationTrace.costEstimate.checkpointA", async () => {
    const entitlements = buildEntitlementsMock(100000);
    const service = new CostControlService(entitlements);

    const estimated = await service.assertBeforeGeneration('org-1', 2, 2);
    const expected = await service.estimateWorstCase({ organizationId: 'org-1', channelCount: 2, scenesCount: 3, maxRepairAttempts: 2 });

    expect(estimated).toBe(expected);
  });

  it('crédits manifestement insuffisants même pour le pire cas grossier (3 scènes assumées) : lève PlanLimitExceededException', async () => {
    const entitlements = buildEntitlementsMock(10);
    const service = new CostControlService(entitlements);

    await expect(service.assertBeforeGeneration('org-1', 2, 2)).rejects.toThrow(PlanLimitExceededException);
  });

  it("l'exception porte le code PLAN_LIMIT_EXCEEDED et limitType 'credits', structurée pour le frontend", async () => {
    const entitlements = buildEntitlementsMock(10);
    const service = new CostControlService(entitlements);

    try {
      await service.assertBeforeGeneration('org-1', 2, 2);
      fail('devait lever une exception');
    } catch (error: any) {
      const body = error.getResponse();
      expect(body.code).toBe('PLAN_LIMIT_EXCEEDED');
      expect(body.limitType).toBe('credits');
      expect(body.current).toBe(10);
    }
  });

  it('aucun appel IA nécessaire avant ce checkpoint : vérifié indirectement (le service ne dépend que de EntitlementsService)', async () => {
    const entitlements = buildEntitlementsMock(100000);
    const service = new CostControlService(entitlements);

    await service.assertBeforeGeneration('org-1', 1, 2);

    expect(entitlements.getRemainingCredits).toHaveBeenCalledWith('org-1');
  });

  // Cas réel qui a révélé le bug ci-dessus : essai (1100 crédits), 2 canaux, budget de
  // réparation complet (2) — doit désormais passer sans lever.
  it('essai (1100 crédits), 2 canaux, budget de réparation complet : ne lève plus (régression du 2026-08-18)', async () => {
    const entitlements = buildEntitlementsMock(1100, 'trial');
    const service = new CostControlService(entitlements);

    await expect(service.assertBeforeGeneration('org-1', 2, 2)).resolves.toEqual(expect.any(Number));
  });
});

describe('CostControlService.checkBeforeVideoLoop (Checkpoint B)', () => {
  it('budget confortable : conserve le maxRepairAttempts demandé, aucune dégradation', async () => {
    const entitlements = buildEntitlementsMock(100000);
    const service = new CostControlService(entitlements);

    const result = await service.checkBeforeVideoLoop('org-1', 2, 3, 2);

    expect(result.maxRepairAttempts).toBe(2);
  });

  it('budget juste (insuffisant pour 2 réparations, suffisant pour 1) : dégrade à 1, ne bloque pas', async () => {
    const entitlements = buildEntitlementsMock(0);
    const service = new CostControlService(entitlements);
    // Calibre le solde pile entre le coût VIDÉO SEUL (ce qu'il reste réellement à engager à ce
    // checkpoint, cf. bug corrigé le 2026-08-18) à 1 réparation et à 2 réparations — pas
    // estimateWorstCase (qui recompte fixedCost+canaux, déjà dépensés à ce stade).
    const videoCostWith1 = await (service as any).videoCost('org-1', 3, 1);
    const videoCostWith2 = await (service as any).videoCost('org-1', 3, 2);
    (entitlements.getRemainingCredits as jest.Mock).mockResolvedValue(Math.floor((videoCostWith1 + videoCostWith2) / 2));

    const result = await service.checkBeforeVideoLoop('org-1', 2, 3, 2);

    expect(result.maxRepairAttempts).toBe(1);
  });

  it('budget insuffisant même pour 0 réparation (plancher) : lève PlanLimitExceededException, ne dégrade pas indéfiniment', async () => {
    const entitlements = buildEntitlementsMock(1);
    const service = new CostControlService(entitlements);

    await expect(service.checkBeforeVideoLoop('org-1', 2, 3, 2)).rejects.toThrow(PlanLimitExceededException);
  });

  it('recommande explicitement le plan supérieur (Growth) pour un essai qui atteint ce plafond', async () => {
    const entitlements = buildEntitlementsMock(1, 'trial');
    const service = new CostControlService(entitlements);

    try {
      await service.checkBeforeVideoLoop('org-1', 2, 3, 2);
      fail('devait lever une exception');
    } catch (error: any) {
      const body = error.getResponse();
      expect(body.recommendedPlan).toBe('growth');
    }
  });

  // Bug corrigé le 2026-08-18 (constaté lors d'un test réel : essai à 1100 crédits, 103 déjà
  // dépensés en amont — stratégie/Creative Intelligence/Concept/canaux/visuel/Visual DNA —,
  // solde restant 997, mais l'ancienne formule recomptait fixedCost+canaux une SECONDE fois
  // (déjà inclus dans le solde restant), exigeant ~1033 alors que le coût RÉELLEMENT restant
  // — la vidéo seule — n'était que de 954) : ne doit plus bloquer une campagne dont le solde
  // couvre le coût vidéo restant, même s'il ne couvrirait plus le coût total recalculé depuis
  // zéro.
  it("ne recompte pas fixedCost/canaux déjà dépensés : un solde qui couvre seulement le coût vidéo restant ne bloque plus (régression du 2026-08-18)", async () => {
    const entitlements = buildEntitlementsMock(997, 'trial');
    const service = new CostControlService(entitlements);

    const result = await service.checkBeforeVideoLoop('org-1', 2, 3, 2);

    expect(result.maxRepairAttempts).toBe(2);
  });
});
