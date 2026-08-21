import { Injectable, Logger } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { getPlan, getRecommendedUpgrade, CREDIT_COSTS } from './plan-catalog';
import { PlanLimitExceededException } from './plan-limit.exception';

// P0.9 — Cost Control (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18, Phase 14 du brief). La génération scène par scène + Video Judge + réparations
// peut faire grimper le coût réel d'une campagne bien au-delà d'un simple appel vidéo — ce
// service ESTIME ce coût AVANT de le dépenser, en réutilisant CREDIT_COSTS (plan-catalog.ts)
// comme SEULE grille tarifaire (jamais redéfinie ici).
//
// Deux points de contrôle, car scenesCount n'est connu qu'APRÈS le Creative Concept (lui-même
// un appel IA) :
//  - Checkpoint A (assertBeforeGeneration) : avant TOUT appel IA, hypothèse prudente de 3
//    scènes (cf. DEFAULT_ASSUMED_SCENES) — bloque net si même ce pire cas grossier ne rentre pas.
//  - Checkpoint B (checkBeforeVideoLoop) : juste avant la boucle vidéo (150 crédits/plan), une
//    fois scenesCount RÉEL connu — DÉGRADE le budget de réparation (MAX_REPAIR_ATTEMPTS) plutôt
//    que de bloquer si le budget est juste, ne bloque que si même le plancher zéro-réparation
//    ne rentre pas (le texte/image déjà généré ne doit jamais être gâché pour ça).
@Injectable()
export class CostControlService {
  private readonly logger = new Logger(CostControlService.name);

  private static readonly DEFAULT_ASSUMED_SCENES = 3;
  // Pire cas réel du mécanisme déjà en production (génération initiale + 1 régénération,
  // cf. AiOrchestratorService.generateShotPlanVideoOrDegrade, `for (attempt < 2)`).
  private static readonly WORST_CASE_ATTEMPTS_PER_SCENE = 2;
  // 1 appel analyzeImage (10) + 1 appel generateText groupé (8) par passage du Video Judge,
  // quel que soit le nombre de critères réellement évalués (cf. VideoJudgeService).
  private static readonly JUDGE_PASS_COST = 10 + 8;

  constructor(private readonly entitlements: EntitlementsService) {}

  // Coût fixe hors vidéo — 5 appels generateText (identification, stratégie, Creative
  // Intelligence, Creative Concept, Shot Plan), 2 analyses produit vision (legacy + v2) + 1
  // analyse ADN visuel, 1 visuel, audio + transcription. Bug corrigé le 2026-08-18 (constaté
  // lors d'un test réel) : le Shot Plan manquait dans le décompte, sous-estimant légèrement le
  // coût fixe réel — sans incidence pratique (le vrai blocage venait du point suivant).
  private fixedCost(): number {
    const c = CREDIT_COSTS.campaign_generation;
    return c.analyzeImage * 3 + c.generateText * 5 + c.generateImage + c.generateAudio + c.transcribeAudio;
  }

  // Coût vidéo (génération de plans + Video Judge + réparations), BORNÉ par le plafond RÉEL déjà
  // appliqué en base par EntitlementsService.assertVideoQuotaAvailable (PlanDefinition.
  // maxVideoShotsPerCampaign — cf. plan-catalog.ts) : chaque appel generateVideo, qu'il vienne de
  // la génération initiale d'un plan OU d'une réparation CLIP_REGEN, passe par CE MÊME garde-fou.
  // Bug corrigé le 2026-08-18 (constaté lors d'un premier test réel) : la version précédente
  // additionnait le pire cas de génération (3 scènes × 2 essais) ET le pire cas de réparation
  // (maxRepairAttempts régénérations de clip) comme s'ils étaient INDÉPENDANTS, alors que le
  // système les compte dans le MÊME compteur et ne peut de toute façon jamais dépasser ce
  // plafond — l'estimation dépassait donc largement ce qui pouvait réellement être dépensé,
  // bloquant des campagnes légitimes (essai à 1100 crédits refusé pour un pire cas estimé à
  // 1361, alors que le plafond réel de clips vidéo borne ce poste à 900).
  private async videoCost(organizationId: string, scenesCount: number, maxRepairAttempts: number): Promise<number> {
    const c = CREDIT_COSTS.campaign_generation;
    const theoreticalClips = scenesCount * CostControlService.WORST_CASE_ATTEMPTS_PER_SCENE + maxRepairAttempts;
    const judgePasses = (maxRepairAttempts + 1) * CostControlService.JUDGE_PASS_COST;

    const plan = await this.entitlements.getCurrentPlan(organizationId);
    const clipCeiling = plan.maxVideoShotsPerCampaign !== null ? Math.min(theoreticalClips, plan.maxVideoShotsPerCampaign) : theoreticalClips;

    return clipCeiling * c.generateVideo + judgePasses;
  }

  async estimateWorstCase(params: { organizationId: string; channelCount: number; scenesCount: number; maxRepairAttempts: number }): Promise<number> {
    const channelCost = params.channelCount * CREDIT_COSTS.campaign_generation.generateText;
    const video = await this.videoCost(params.organizationId, params.scenesCount, params.maxRepairAttempts);
    return this.fixedCost() + channelCost + video;
  }

  // Checkpoint A — AUCUN appel IA n'a encore été effectué à ce stade. Retourne l'estimation
  // (Phase A, chantier V2, 2026-08-19 — bug corrigé : cette méthode était `void`, l'estimation
  // réelle n'était jamais remontée à l'appelant, qui persistait `costEstimate.checkpointA: 0` en
  // dur dans CreativeGenerationTrace à 3 endroits, cf. campaign-generation.processor.ts).
  async assertBeforeGeneration(organizationId: string, channelCount: number, maxRepairAttempts: number): Promise<number> {
    const estimated = await this.estimateWorstCase({ organizationId, channelCount, scenesCount: CostControlService.DEFAULT_ASSUMED_SCENES, maxRepairAttempts });
    const remaining = await this.entitlements.getRemainingCredits(organizationId);

    if (estimated > remaining) {
      throw await this.buildException(organizationId, estimated, remaining);
    }

    return estimated;
  }

  // Checkpoint B — scenesCount réel connu (post-Concept). Dégrade le budget de réparation
  // plutôt que de bloquer une génération dont le texte/image sont déjà payés, sauf si même le
  // plancher zéro-réparation dépasse le solde restant.
  //
  // Bug corrigé le 2026-08-18 (constaté lors d'un test réel : remaining=997, estimé=1033,
  // alors que le solde couvrait largement le coût RÉEL restant à engager) : ce checkpoint est
  // appelé APRÈS que fixedCost() + channelCount×generateText ont déjà été réellement dépensés
  // (stratégie, Creative Intelligence, Creative Concept, texte par canal, visuel, Visual DNA —
  // tous exécutés avant ce point, cf. AiOrchestratorService.generateCampaign). `remaining`
  // (EntitlementsService.getRemainingCredits) reflète déjà cette dépense. Ré-ajouter
  // fixedCost()+channelCost à l'estimation ici les comptait UNE SECONDE FOIS : le solde
  // restant se voyait comparé à "coût total de la campagne depuis zéro" au lieu de "coût qui
  // reste RÉELLEMENT à engager" (uniquement la vidéo, seul poste non encore dépensé à ce
  // stade) — bloquant des campagnes qui avaient largement les crédits nécessaires pour la
  // seule vidéo restante.
  async checkBeforeVideoLoop(organizationId: string, channelCount: number, scenesCount: number, maxRepairAttempts: number): Promise<{ maxRepairAttempts: number }> {
    const remaining = await this.entitlements.getRemainingCredits(organizationId);

    for (let attempts = maxRepairAttempts; attempts >= 0; attempts--) {
      const estimated = await this.videoCost(organizationId, scenesCount, attempts);
      if (estimated <= remaining) {
        if (attempts < maxRepairAttempts) {
          this.logger.warn(`Budget de réparation vidéo dégradé de ${maxRepairAttempts} à ${attempts} tentative(s) pour l'organisation ${organizationId} (crédits restants insuffisants pour le budget complet).`);
        }
        return { maxRepairAttempts: attempts };
      }
    }

    const zeroRepairEstimate = await this.videoCost(organizationId, scenesCount, 0);
    throw await this.buildException(organizationId, zeroRepairEstimate, remaining);
  }

  private async buildException(organizationId: string, estimated: number, remaining: number): Promise<PlanLimitExceededException> {
    const plan = await this.entitlements.getCurrentPlan(organizationId);
    const recommendedPlan = getRecommendedUpgrade(plan.key);
    const message = recommendedPlan
      ? `Crédits IA insuffisants pour cette campagne vidéo (estimé ${estimated}, restant ${remaining}) — passez au plan ${getPlan(recommendedPlan).name} pour continuer`
      : `Crédits IA insuffisants pour cette campagne vidéo (estimé ${estimated}, restant ${remaining})`;

    return new PlanLimitExceededException({
      message,
      code: 'PLAN_LIMIT_EXCEEDED',
      limitType: 'credits',
      currentPlan: plan.key,
      current: remaining,
      limit: estimated,
      recommendedPlan,
    });
  }
}
