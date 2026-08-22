import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { logProcessEvent, recordActivity, serializeError } from '../common/observability/process-health';
import { CAMPAIGN_GENERATION_QUEUE } from './queue.module';
import { AiOrchestratorService, GenerateCampaignParams } from '../ai/ai-orchestrator/ai-orchestrator.service';
import { ModerationService, ModerationInputText, ModerationInputImage } from '../moderation/moderation.service';
import { BrandConsistencyService } from '../brand-consistency/brand-consistency.service';
import { ContentStudioService } from '../content-studio/content-studio.service';
import { AssetsService } from '../content-studio/assets.service';
import { StorageService } from '../storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VideoQualityLoopService, QualityLoopAttemptTrace, QualityLoopOutcome } from '../ai/video-judge/video-quality-loop.service';
import { CreativeGenerationTraceService, ShotPlanVersion } from '../ai/video-judge/creative-generation-trace.service';
import { buildQualityReport, computeTimeBudgetStatus, StructuredQualityReport } from '../ai/video-judge/quality-report';
import { evaluateFinalDelivery } from '../ai/video-judge/final-delivery-gate';
import { classifyRootCause, projectToGoalFirstRootCause, RootCauseLevel } from '../ai/video-judge/root-cause';
import { StoryboardGateStatus, StoryboardGateResult } from '../ai/video-direction/storyboard-gate.types';
import { CreativeGateStatus } from '../ai/creative-intelligence/creative-gate.types';
import { PlanLimitExceededException } from '../plans/plan-limit.exception';
import { ProductFactConflict } from '../ai/product-intelligence/product-fact.types';
import { ProductUrlFacts } from '../ai/product-intelligence/product-page/product-url-facts.types';

// Worker : génère le contenu de la campagne, le PERSISTE dans le Content Studio (auparavant,
// le contenu généré n'existait que le temps de la requête IA, jamais conservé au-delà —
// cf. persistGeneratedContent), puis le fait systématiquement passer par deux vérifications
// indépendantes avant de le rendre visible pour validation humaine :
//  - ModerationService (sécurité/légalité) : peut rejeter automatiquement (BLOCKED).
//  - BrandConsistencyService (qualité éditoriale) : ne bloque jamais, informe seulement.
// Ordre : génération -> persistance Content Studio -> modération + cohérence de marque
// (en parallèle) -> (BLOCKED => REJECTED) ou (sinon => READY_FOR_REVIEW). Le statut PUBLISHED
// n'est JAMAIS atteint depuis ce worker — uniquement via l'action explicite d'un humain
// habilité (cf. CampaignsController.approve + SocialController.publish).
// concurrency: 1 explicite — l'assemblage vidéo final (VideoQualityLoopService, via
// VideoFinalizationService) lance un processus ffmpeg réel par job, CPU-intensif, contrairement
// au reste du pipeline (uniquement des appels HTTP). La concurrence à 1 était jusqu'ici
// implicite (comportement par défaut de BullMQ, jamais pensé comme une décision) ; désormais une
// contrainte volontaire pour éviter que plusieurs encodages ffmpeg se disputent le CPU du worker
// en même temps.
@Processor(CAMPAIGN_GENERATION_QUEUE, { concurrency: 1 })
export class CampaignGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignGenerationProcessor.name);

  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly moderation: ModerationService,
    private readonly brandConsistency: BrandConsistencyService,
    private readonly contentStudio: ContentStudioService,
    private readonly assets: AssetsService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    // Creative Intelligence Engine & Video Quality Loop (2026-08-18) — remplace l'accès direct à
    // VideoFinalizationService : la boucle GENERATE→JUDGE→REPAIR (P0.7) encapsule désormais
    // l'assemblage, jamais un succès automatique parce qu'un fichier a été produit.
    private readonly videoQualityLoop: VideoQualityLoopService,
    private readonly creativeGenerationTrace: CreativeGenerationTraceService,
  ) {
    super();
  }

  // Stabilisation infrastructure (Mission 4.5, 2026-08-22) — CAUSE PROBABLE identifiée de
  // l'arrêt silencieux du backend : ce processeur n'avait AUCUN listener sur l'événement
  // 'error' du Worker BullMQ sous-jacent (vérifié : aucun @OnWorkerEvent nulle part dans ce
  // fichier avant ce correctif). Or bullmq.Worker émet 'error' pour des incidents SANS lien
  // avec un job en cours (perte de connexion Redis, échec de renouvellement de lock, etc. —
  // cf. node_modules/bullmq/dist/cjs/classes/worker.js, plusieurs this.emit('error', ...)) —
  // en Node, un événement 'error' émis SANS AUCUN listener est levé comme une exception
  // JAVASCRIPT NON INTERCEPTÉE (comportement spécial d'EventEmitter, pas une particularité de
  // bullmq). Ce comportement correspond exactement à ce qui a été observé : un arrêt survenu
  // PENDANT une période d'inactivité entre deux requêtes, sans aucune trace applicative — une
  // erreur de fond du Worker (pas un job), jamais journalisée nulle part, faisait planter tout
  // le process via le filet de sécurité uncaughtException (cf. main.ts). Non certain à 100 % en
  // l'absence de la stack trace historique, mais c'est la seule cause structurelle identifiée
  // avec preuve à l'appui dans le code — cf. rapport de la mission.
  @OnWorkerEvent('error')
  onWorkerError(error: unknown) {
    logProcessEvent('bullmq_worker_error', { error: serializeError(error) });
  }

  async process(job: Job<GenerateCampaignParams>) {
    recordActivity('campaign_job_started', { campaignId: job.data.campaignId, organizationId: job.data.organizationId, jobId: job.id, attempt: job.attemptsMade + 1 });
    try {
      const result = await this.processInternal(job);
      recordActivity('campaign_job_completed', { campaignId: job.data.campaignId, jobId: job.id });
      return result;
    } catch (error) {
      // Bug corrigé le 2026-08-18 (constaté en conditions réelles — campagnes dépassant 1h) :
      // un échec MÉTIER définitif (seuil qualité vidéo jamais atteint après réparations, crédits
      // ou quota de plans vidéo épuisés) ne se résoudra JAMAIS en relançant le pipeline entier
      // depuis zéro — recommencer double juste le temps (souvent 15-20 min) et le coût réel
      // (nouveaux appels IA facturés) sans aucune chance de succès différent. Seule une erreur
      // vraiment TRANSITOIRE (timeout réseau, panne fournisseur ponctuelle) justifie le retry
      // BullMQ existant (cf. attempts/backoff, queue.module.ts) — pensé à l'origine pour ça, avant
      // que QUALITY_GATE/PlanLimitExceededException n'existent.
      const isDefinitiveFailure = error instanceof PlanLimitExceededException || /^QUALITY_GATE:/.test(error instanceof Error ? error.message : String(error));
      const isLastAttempt = isDefinitiveFailure || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (!isLastAttempt) {
        // Tentatives BullMQ restantes : on relance l'exception telle quelle pour que le
        // worker programme un retry (cf. attempts/backoff sur la queue) — la campagne reste
        // IN_PROGRESS, aucune mise à jour ici.
        this.logger.warn(`Job ${job.id} (campagne ${job.data.campaignId}) en échec, nouvelle tentative programmée : ${error}`);
        throw error;
      }

      // Dernière tentative épuisée : avant cette correction, l'exception remontait ici sans
      // jamais mettre à jour la campagne, qui restait bloquée IN_PROGRESS indéfiniment, sans
      // notification ni moyen de le représenter (aucun état FAILED n'existait). On absorbe
      // l'exception (pas de re-throw) pour éviter un log dupliqué par BullMQ, et on informe
      // explicitement l'utilisateur plutôt que de le laisser face à un état muet.
      const failureReason = this.toUserFacingFailureReason(error);
      this.logger.error(`Job ${job.id} (campagne ${job.data.campaignId}) définitivement en échec : ${error}`);
      recordActivity('campaign_job_failed', { campaignId: job.data.campaignId, jobId: job.id, failureReason, error: serializeError(error) });
      await this.markCampaignFailed(job.data.organizationId, job.data.campaignId, failureReason);
      return { campaignStatus: 'FAILED', failureReason };
    }
  }

  private async processInternal(job: Job<GenerateCampaignParams>) {
    const { organizationId, campaignId } = job.data;
    this.logger.log(`Traitement du job ${job.id} — campagne ${campaignId}`);
    // Phase Q (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — horloge murale de
    // bout en bout, y compris les escalades (chacune relance generateShotPlanVideoOrDegrade +
    // toute la Quality Loop) : seul point de départ commun à tous les chemins de sortie.
    const startTime = Date.now();

    // Mission 4.3 (Goal-First Quality Architecture, Phase 7, Étape 19) — même job de queue pour
    // les deux chemins : reuseApprovedConcept n'est présent que quand CampaignsService.regenerate()
    // a déjà confirmé une réutilisation ciblée valide (cf. GenerateCampaignParams).
    const { reuseApprovedConcept, ...campaignParams } = job.data;
    const results = reuseApprovedConcept
      ? await this.orchestrator.regenerateFromApprovedConcept({ ...campaignParams, ...reuseApprovedConcept })
      : await this.orchestrator.generateCampaign(job.data);

    const { finalTranscript } = await this.persistGeneratedContent(organizationId, campaignId, results, startTime);

    const texts: ModerationInputText[] = [
      { label: 'productAnalysis', text: results.productAnalysis.content },
      { label: 'strategy', text: results.strategy.content },
      // Un texte distinct par canal, désormais réellement différent d'un canal à l'autre —
      // chacun vérifié indépendamment plutôt qu'une seule vérification représentative de tous.
      ...Object.entries(results.channelContent).map(([channel, result]) => ({
        label: `copywriting_${channel}`,
        text: result.content,
      })),
      // P0.10 (chantier "Creative Intelligence Engine & Video Quality Loop", 2026-08-18) —
      // sécurité factuelle élargie à la vidéo FINALE : avant ce chantier, le transcript réel
      // (Whisper) et le texte à l'écran planifié n'étaient JAMAIS envoyés à la modération, alors
      // qu'ils constituent ce que la publicité affirme réellement une fois montée. Purement
      // additif — élargit l'ENTRÉE des gates MISLEADING_CLAIMS/OBJECTIVE_ACHIEVEMENT déjà en
      // place, ne change jamais leur logique de décision. finalTranscript = état post-réparation
      // (cf. VideoQualityLoopService) quand un AUDIO_REGEN/SUBTITLE_ONLY a eu lieu — le texte
      // RÉELLEMENT livré, pas celui d'origine.
      ...(finalTranscript?.length ? [{ label: 'video_transcript', text: finalTranscript.map((s) => s.text).join(' ') }] : []),
      ...(results.shotPlan?.some((s) => s.onScreenText)
        ? [{ label: 'video_onscreen_text', text: results.shotPlan.map((s) => s.onScreenText).filter(Boolean).join(' | ') }]
        : []),
    ];
    const images: ModerationInputImage[] = [{ label: 'visual', url: results.visual.content }];

    // Les deux vérifications sont indépendantes (sécurité vs qualité éditoriale) — exécutées
    // en parallèle pour ne pas doubler le temps d'attente de l'utilisateur.
    const [moderationResult, brandResult] = await Promise.all([
      this.moderation.runCampaignModeration(organizationId, campaignId, job.data.objective, texts, images),
      this.brandConsistency.runCampaignBrandCheck(organizationId, campaignId, texts, images),
    ]);

    if (moderationResult.verdict === 'BLOCKED') {
      const blockedChecks = moderationResult.checks.filter((c) => c.status === 'BLOCKED');
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: 'REJECTED',
          moderationVerdict: 'BLOCKED',
          brandConsistencyScore: brandResult.overallScore,
          rejectionReason: `Rejet automatique (modération) : ${blockedChecks.map((c) => c.summary).join(' | ')}`,
        },
      });
      this.logger.warn(`Campagne ${campaignId} rejetée automatiquement par la modération`);
      return { ...results, moderationResult, brandResult, campaignStatus: 'REJECTED' };
    }

    // PASSED ou FLAGGED : la campagne est prête pour la validation humaine dans tous les cas —
    // le verdict de modération et le score de cohérence de marque sont simplement portés
    // à la connaissance du validateur, jamais utilisés pour approuver automatiquement.
    const campaign = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'READY_FOR_REVIEW',
        moderationVerdict: moderationResult.verdict,
        brandConsistencyScore: brandResult.overallScore,
      },
    });

    // Notifie tous les Marketing Manager+ — auparavant silencieux, il fallait consulter
    // le dashboard pour découvrir qu'une campagne attendait une validation.
    await this.notifications.notifyOrganization(organizationId, ['MARKETING_MANAGER', 'ADMIN', 'OWNER'], {
      organizationId,
      type: 'CAMPAIGN_READY_FOR_REVIEW',
      title: 'Campagne prête pour validation',
      body: `La campagne "${campaign.name}" attend votre validation.`,
      link: `/campaigns/${campaignId}`,
    });

    return { ...results, moderationResult, brandResult, campaignStatus: 'READY_FOR_REVIEW' };
  }

  private async markCampaignFailed(organizationId: string, campaignId: string, failureReason: string) {
    const campaign = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'FAILED', failureReason },
    });

    // Mêmes destinataires que "prête pour validation" — un échec définitif mérite la même
    // visibilité immédiate qu'une réussite, pas seulement un statut muet dans la liste.
    await this.notifications.notifyOrganization(organizationId, ['MARKETING_MANAGER', 'ADMIN', 'OWNER'], {
      organizationId,
      type: 'CAMPAIGN_GENERATION_FAILED',
      title: 'Échec de génération de campagne',
      body: `La génération de la campagne "${campaign.name}" a échoué : ${failureReason}`,
      link: `/campaigns/${campaignId}`,
    });
  }

  // Ne jamais exposer une trace d'erreur technique brute (stack, message de driver DB,
  // détail de provider IA) à l'utilisateur final — seuls les cas métier reconnus reçoivent un
  // message clair et actionnable ; tout le reste retombe sur un message générique, la trace
  // complète restant dans les logs serveur (this.logger.error ci-dessus) pour investigation.
  private toUserFacingFailureReason(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    // Bug corrigé le 2026-08-18 (constaté en conditions réelles — clé OpenAI à sec) : cette
    // branche captait AUSSI bien l'épuisement de NOTRE quota interne (PlanLimitExceededException,
    // limitType='credits') que l'épuisement du VRAI solde payant d'un fournisseur IA (ex. OpenAI
    // "insufficient_quota"/"credit_balance_exhausted") sous le même message — l'utilisateur ne
    // pouvait pas distinguer "rechargez votre plan" (actionnable côté produit) de "le compte
    // fournisseur externe est à sec" (actionnable uniquement côté facturation du fournisseur,
    // jamais résolu par une recharge de crédits internes). PlanLimitExceededException vérifiée
    // en premier (notre quota, cas réellement couvert par ce message) ; un second message dédié
    // couvre l'épuisement RÉEL d'un compte fournisseur.
    if (error instanceof PlanLimitExceededException) {
      return 'Crédits IA insuffisants pour terminer cette génération.';
    }
    if (/insufficient_quota|credit_balance_exhausted|no credits remaining|billing/i.test(message)) {
      return "Le compte du fournisseur IA (OpenAI, Anthropic...) utilisé n'a plus de solde réel — rechargez-le sur le portail de facturation du fournisseur, une recharge de crédits internes n'y changera rien.";
    }
    if (/crédits IA|credits/i.test(message)) {
      return 'Crédits IA insuffisants pour terminer cette génération.';
    }
    if (/plafond budgétaire|budget/i.test(message)) {
      return 'Plafond budgétaire IA atteint pour cette période.';
    }
    if (/abonnement|subscription/i.test(message)) {
      return "Abonnement inactif — impossible de terminer la génération.";
    }
    // QUALITY_GATE (P0.7, chantier "Creative Intelligence Engine & Video Quality Loop",
    // 2026-08-18) : préfixe distinctif posé par finalizeVideoAsset() quand la boucle qualité
    // épuise ses tentatives de réparation sans jamais atteindre le seuil — distinct d'un échec
    // technique générique (assemblage/QC), qui reste géré par la branche suivante.
    //
    // Sous-cas spécifique (Phase E, chantier "Moteur d'optimisation de la qualité vidéo — V2",
    // 2026-08-19) : un plan de tournage structurellement invalide échoue AVANT tout appel vidéo —
    // message distinct nécessaire, sinon le texte générique ci-dessous ("après plusieurs
    // tentatives de correction") serait factuellement faux ici (aucune vidéo n'a même été générée).
    if (/^QUALITY_GATE:.*plan de tournage généré est structurellement invalide/.test(message)) {
      return 'La planification de la campagne a produit un scénario incomplet ou incohérent. Réessayez, ou contactez le support si le problème persiste.';
    }
    // Phase G (chantier V2, spec Sections 35-45) : le Creative Gate rejette un concept publicitaire
    // insuffisant AVANT tout Shot Plan/vidéo — distinct des deux autres sous-cas QUALITY_GATE
    // (aucune vidéo n'a même été planifiée à ce stade).
    if (/^QUALITY_GATE:.*concept publicitaire insuffisant/.test(message)) {
      return "L'idée publicitaire générée pour cette campagne n'était pas assez solide pour être produite. Réessayez, ou contactez le support si le problème persiste.";
    }
    // Bug corrigé le 2026-08-19 (Phase R, chantier "Optimisation du pipeline vidéo — V2.1") :
    // le Storyboard Gate (Phase H, spec Sections 46-53) rejette un Shot Plan qui ne traduit pas
    // le concept en séquence exploitable AVANT tout generateVideo — comme le Creative Gate
    // ci-dessus, aucune vidéo n'a même été générée à ce stade. Ce cas ne matchait jusqu'ici AUCUN
    // des 2 sous-cas ci-dessus et retombait sur le message générique suivant ("après plusieurs
    // tentatives de correction"), factuellement faux ici — détecté en construisant
    // storyboardGateRejectionRate (Phase R) qui devait distinguer ce cas des échecs de la Quality
    // Loop, impossible tant que les deux partageaient le même message.
    if (/^QUALITY_GATE:.*storyboard insuffisant après révision/.test(message)) {
      return "Le plan de tournage généré pour cette campagne n'était pas assez abouti pour être produit. Réessayez, ou contactez le support si le problème persiste.";
    }
    // Mission 3 (validation empirique, 2026-08-20) — cf. finalizeVideoAsset/providerNote : quand
    // rootCause === 'PROVIDER' (l'appel Judge groupé a échoué, aucun contenu réellement évalué),
    // le message générique ci-dessous ("après plusieurs tentatives de correction") laisserait
    // croire à un problème créatif — distinction nécessaire, confirmée par l'audit de 3 campagnes
    // réelles historiques où ce cas précis s'est produit.
    if (/^QUALITY_GATE:.*n'a pas pu évaluer/.test(message)) {
      return "La vérification qualité de la vidéo finale n'a pas pu s'exécuter correctement (problème technique côté fournisseur IA, pas un problème de contenu). Réessayez, ou contactez le support si le problème persiste.";
    }
    // Bug réel constaté en conditions réelles (2026-08-21) : PreFlightQualityGate (Mission 4.3
    // Phase 5, Étape 7) bloque AVANT tout generateVideo — comme les 2 sous-cas Creative/Storyboard
    // Gate ci-dessus, aucune vidéo n'a même été générée à ce stade. Ce cas ne matchait jusqu'ici
    // aucun sous-cas et retombait sur le message générique post-vidéo suivant ("après plusieurs
    // tentatives de correction"), factuellement faux ici — cette branche manquait depuis
    // l'introduction du gate lui-même (Phase 5), pas un oubli de ce chantier-ci.
    if (/^QUALITY_GATE:.*pré-vol qualité échoué/.test(message)) {
      return "Le plan de tournage généré pour cette campagne présentait des incohérences internes (ex. narration/plan de tournage désynchronisés) détectées avant tout lancement de génération vidéo. Réessayez, ou contactez le support si le problème persiste.";
    }
    if (/^QUALITY_GATE:/.test(message)) {
      return "La vidéo finale n'a pas atteint le seuil de qualité requis après plusieurs tentatives de correction. Réessayez, ou contactez le support si le problème persiste.";
    }
    if (/assemblage vidéo|contrôle qualité de la vidéo|ffmpeg/i.test(message)) {
      return "L'assemblage final de la vidéo a échoué. Réessayez, ou contactez le support si le problème persiste.";
    }
    return "La génération a échoué suite à une erreur technique. Réessayez, ou contactez le support si le problème persiste.";
  }

  // Transforme le résultat transitoire de l'AI Orchestrator en pièces de contenu durables :
  // un ContentPiece TEXT par canal sélectionné, avec le texte SPÉCIFIQUE généré pour ce canal
  // (plus un texte générique dupliqué — cf. AiOrchestratorService.generateChannelCopy), un
  // ContentPiece IMAGE pour le visuel, et un ContentPiece VIDEO si une vidéo a été générée.
  // Chaque asset généré est enregistré dans la bibliothèque de médias avec sa traçabilité
  // de génération (coût, fournisseur). targetChannels dérive directement des clés de
  // channelContent — jamais recalculée indépendamment ici, pour rester en phase avec ce que
  // l'Orchestrator a réellement généré (cf. commentaire dans AiOrchestratorService).
  private async persistGeneratedContent(
    organizationId: string,
    campaignId: string,
    results: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>,
    startTime: number,
  ): Promise<{ finalTranscript: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['transcript'] }> {
    const targetChannels = Object.keys(results.channelContent);

    for (const [channel, channelResult] of Object.entries(results.channelContent)) {
      await this.contentStudio.createPiece({
        organizationId,
        campaignId,
        channel,
        type: 'TEXT',
        body: channelResult.content,
      });
    }

    const visualAsset = await this.registerGeneratedVisual(organizationId, 'IMAGE', results.visual.content, results.visual.generationId, 'visual');
    await this.contentStudio.createPiece({
      organizationId,
      campaignId,
      channel: targetChannels[0],
      type: 'IMAGE',
      assetId: visualAsset.id,
    });

    let finalTranscript = results.transcript;

    if (results.video) {
      const videoChannel = targetChannels.find((c) => ['tiktok', 'instagram'].includes(c)) ?? targetChannels[0];

      // Les bruts (vidéo Veo, narration TTS) restent tracés comme Assets — traçabilité/coût,
      // cohérent avec le reste du pipeline (chaque AiGeneration a déjà son propre suivi) — mais
      // n'apparaissent PLUS comme ContentPiece séparés : le reviewer ne doit voir qu'UNE vidéo
      // finale (son + sous-titres inclus), pas des fragments à côté les uns des autres.
      const rawVideoAsset = await this.registerGeneratedVisual(organizationId, 'VIDEO', results.video.content, results.video.generationId, 'video-brute');
      if (results.narration) {
        await this.registerGeneratedAudio(organizationId, results.narration.content, results.narration.generationId);
      }

      const finalizeOutcome = results.narration
        ? await this.finalizeVideoAsset(organizationId, campaignId, results, rawVideoAsset, startTime)
        : { asset: rawVideoAsset, finalTranscript: results.transcript };
      finalTranscript = finalizeOutcome.finalTranscript;

      await this.contentStudio.createPiece({
        organizationId,
        campaignId,
        channel: videoChannel,
        type: 'VIDEO',
        assetId: finalizeOutcome.asset.id,
      });
    }

    return { finalTranscript };
  }

  // Boucle GENERATE→JUDGE→REPAIR (P0.7) : assemble narration + musique + sous-titres, REGARDE
  // la vidéo finale (Video Judge, P0.5) avant de la considérer terminée, répare UNIQUEMENT les
  // parties défectueuses si besoin (P0.6), jamais plus de results.maxRepairAttempts fois (P0.9,
  // dégradé si le budget de crédits restant est juste). Persiste systématiquement la trace
  // d'observabilité (P0.11), succès ou échec. `REPAIR_EXHAUSTED` lève une exception
  // `QUALITY_GATE:` — jamais un faux succès parce qu'un fichier a été produit, cf. règle
  // absolue du brief. Mode mock (narration non réelle) : `finalized.status === 'skipped'`,
  // repli sur la vidéo brute, comportement historique inchangé.
  private async finalizeVideoAsset(
    organizationId: string,
    campaignId: string,
    results: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>,
    rawVideoAsset: Awaited<ReturnType<AssetsService['register']>>,
    startTime: number,
  ): Promise<{ asset: Awaited<ReturnType<AssetsService['register']>>; finalTranscript: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['transcript'] }> {
    const ctx = { organizationId, campaignId, purpose: 'campaign_generation' as const };
    // Phase Q — cycles Quality Loop consommés au total, TOUTES escalades confondues (chaque
    // escalade relance videoQualityLoop.run() depuis 0, cf. `continue` plus bas).
    let totalAttemptCount = 0;

    // Phase P (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19, spec Section 16-19)
    // — état COURANT (originale, ou escaladée) de chaque donnée nécessaire à la Quality Loop et
    // à la livraison finale. `results.*` reste la version D'ORIGINE (jamais mutée) — ces
    // variables locales sont ce qui avance au fil des escalades.
    let currentShotPlan = results.shotPlan;
    let currentVideo = results.video;
    let currentVideoClips = results.videoClips;
    let currentPerShotQuality = results.perShotQuality;
    let currentCreativeConcept = results.creativeConcept;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 4) — mise à jour INCONDITIONNELLEMENT
    // à chaque escalade réussie (STORYBOARD ou CONCEPT) : les deux retournent désormais un
    // blueprint enrichi (beats[].shotIds reflétant le Shot Plan de CETTE tentative), même quand
    // le concept/blueprint lui-même n'a pas changé (escalade STORYBOARD).
    let currentNarrativeBlueprint = results.narrativeBlueprint;
    let currentCreativeGateStatus: CreativeGateStatus = results.creativeGateStatus;
    let currentStoryboardGateStatus: StoryboardGateStatus = results.storyboardGateStatus;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 6b) — résultat COMPLET (criterionScores/
    // blockingDefects/risks/requiredChanges/rootCauseLevel) du dernier Storyboard Gate franchi,
    // persisté sur GoalFirstTrace même quand la campagne aboutit sans jamais escalader.
    let currentPreProductionJudge: StoryboardGateResult = results.storyboardGateResult;
    let currentNarrationText = results.narrationText;
    let currentNarrationDataUri = results.narration!.content;
    let currentTranscript = results.transcript;

    const shotPlanVersions: ShotPlanVersion[] = [{ attempt: 1, shots: results.shotPlan, repetitionWarnings: [] }];
    // Budget dur (spec Section 19) : 1 escalade storyboard + 1 escalade concept MAXIMUM par
    // campagne — chaque drapeau ne peut passer à true qu'une seule fois, ce qui plafonne
    // naturellement la boucle ci-dessous sans compteur séparé à synchroniser.
    let storyboardEscalated = false;
    let conceptEscalated = false;
    let escalationLevel: 'SCENE' | 'STORYBOARD' | 'CONCEPT' = 'SCENE';
    // Audit forensique Mission 4.2 (P1-4) : pure visibilité économique, cumulé sur toutes les
    // escalades de cette campagne — ne change jamais le comportement de génération lui-même.
    let discardedClipsOnEscalation = 0;

    for (;;) {
      const outcome = await this.videoQualityLoop.run(
        ctx,
        {
          rawVideoUrl: currentVideo!.content,
          videoClips: currentVideoClips,
          narrationDataUri: currentNarrationDataUri,
          narrationText: currentNarrationText,
          transcript: currentTranscript,
          shotPlan: currentShotPlan,
          perShotQuality: currentPerShotQuality,
          visualDna: results.visualDnaResult,
          referenceImageUrl: results.referenceImageUrl,
          concept: currentCreativeConcept,
          narrativeBlueprint: currentNarrativeBlueprint,
          productProfile: results.productProfile,
        },
        results.maxRepairAttempts,
      );
      totalAttemptCount += outcome.attempts.length;

      if (outcome.status === 'REPAIR_EXHAUSTED') {
        const { rootCause, result: escalation } = await this.tryEscalate(ctx, organizationId, campaignId, results, outcome, {
          currentShotPlan, currentCreativeConcept, storyboardEscalated, conceptEscalated,
        });

        if (escalation) {
          // Audit forensique Mission 4.2 (P1-4) : compté AVANT l'écrasement ci-dessous —
          // currentVideoClips représente encore les clips de la tentative sur le point d'être
          // jetée (aucun réemploi possible, cf. commentaire sur discardedClipsOnEscalation).
          discardedClipsOnEscalation += currentVideoClips.length;
          this.logger.warn(
            `Campagne ${campaignId} : escalade ${escalation.level} déclenchée (cause racine ${rootCause}) après épuisement des réparations locales — tentative ${shotPlanVersions.length + 1} (${currentVideoClips.length} clip(s) vidéo déjà généré(s) jeté(s), aucun réemploi possible après une régénération de plan).`,
          );
          currentShotPlan = escalation.shotPlan;
          currentVideo = escalation.video;
          currentVideoClips = escalation.videoClips;
          currentPerShotQuality = escalation.perShotQuality;
          currentStoryboardGateStatus = escalation.storyboardGateStatus;
          currentPreProductionJudge = escalation.storyboardGateResult;
          currentNarrativeBlueprint = escalation.narrativeBlueprint;
          if (escalation.level === 'STORYBOARD') {
            storyboardEscalated = true;
            escalationLevel = 'STORYBOARD';
          } else {
            conceptEscalated = true;
            escalationLevel = 'CONCEPT';
            currentCreativeConcept = escalation.creativeConcept!;
            currentCreativeGateStatus = escalation.creativeGateStatus!;
            currentNarrationText = escalation.narrationText!;
            currentNarrationDataUri = escalation.narrationDataUri!;
            currentTranscript = escalation.transcript!;
          }
          shotPlanVersions.push({ attempt: shotPlanVersions.length + 1, shots: currentShotPlan, repetitionWarnings: [] });
          continue; // relance la Quality Loop sur la version escaladée
        }

        // Budget d'escalade épuisé (storyboard ET concept déjà tentés) ou cause non escaladable
        // (BRAND/AUDIO/ASSEMBLY/PROVIDER/UNKNOWN, cf. tryEscalate) : échec définitif, comme avant
        // ce chantier — le rapport cite désormais aussi le niveau d'escalade atteint.
        // Phase F (chantier V2, 2026-08-19) — rapport structuré dérivé des données déjà calculées
        // (Phases A/B/C) : cause racine + action recommandée, un message réellement informatif au
        // lieu du seul score global. bestAttempt.judge peut différer de outcome.lastJudge (une
        // tentative antérieure meilleure, ou la dernière réparation ayant été reverted pour
        // régression) — le message ne doit jamais citer un score pire que la meilleure version
        // réellement produite, sous peine de sous-communiquer le résultat réel du pipeline.
        const baseReport = buildQualityReport(outcome);
        const elapsedMs = Date.now() - startTime;
        const enrichedReport: StructuredQualityReport = {
          ...baseReport,
          totalStoryboardRevisions: storyboardEscalated ? 1 : 0,
          totalConceptRevisions: conceptEscalated ? 1 : 0,
          totalCredits: await this.getTotalCreditsForCampaign(campaignId),
          elapsedMs,
          rootCause,
          goalFirstRootCause: rootCause ? projectToGoalFirstRootCause(rootCause) : null,
          escalationLevel,
          stopReason: 'REPAIR_EXHAUSTED — budget de réparation/escalade épuisé sans atteindre le seuil de qualité',
          timeBudgetStatus: computeTimeBudgetStatus(elapsedMs),
          plannedShotCount: currentShotPlan.length,
          deliveredShotCount: currentVideoClips.length,
          discardedClipsOnEscalation,
        };
        await this.creativeGenerationTrace.upsertTrace({
          organizationId,
          campaignId,
          creativeIntelligence: results.creativeIntelligence,
          creativeConcept: currentCreativeConcept,
          shotPlanVersions,
          attempts: outcome.attempts,
          costEstimate: { checkpointA: results.checkpointACost, checkpointBFinalMaxRepairAttempts: results.maxRepairAttempts },
          qualityTarget: results.qualityTarget,
          preProductionJudge: currentPreProductionJudge,
          productUrl: results.productProfile?.productUrl,
          productUrlFacts: results.productProfile?.productUrlFacts as unknown as ProductUrlFacts | null,
          productConflicts: results.productProfile?.productConflicts as unknown as ProductFactConflict[] | undefined,
          finalOutcome: 'REPAIR_EXHAUSTED',
          report: enrichedReport,
          elapsedMs,
          attemptCount: totalAttemptCount,
          escalationLevel,
        });
        const bestScoreNote =
          outcome.bestAttempt.attemptNumber !== outcome.attempts.length || outcome.bestAttempt.judge.globalScore !== outcome.lastJudge.globalScore
            ? ` Meilleur résultat obtenu : ${outcome.bestAttempt.judge.globalScore}/100 (tentative ${outcome.bestAttempt.attemptNumber}).`
            : '';
        const causeRacineNote = baseReport.causeRacine ? ` Défaut principal : ${baseReport.causeRacine}` : '';
        // Jamais le mot "budget" ici (même en partie de mot composé) : toUserFacingFailureReason
        // (cf. plus haut dans ce fichier) détecte /plafond budgétaire|budget/i AVANT les branches
        // QUALITY_GATE — un message contenant "budget" serait mal classé comme un dépassement de
        // budget IA générique, masquant le vrai motif (escalade épuisée) à l'utilisateur.
        const escalationNote = escalationLevel !== 'SCENE' ? ` Niveau d'escalade atteint : ${escalationLevel} (plafond d'escalade déjà consommé).` : '';
        // Mission 3 (validation empirique, 2026-08-20) — cause confirmée sur des campagnes
        // réelles historiques : distingue explicitement "le Judge n'a pas pu évaluer le contenu"
        // (fournisseur) de "le contenu a été évalué et jugé insuffisant" — sans cette note, le
        // message ci-dessus laisse croire à un problème créatif alors qu'aucun contenu n'a
        // réellement été mesuré.
        const providerNote =
          rootCause === 'PROVIDER'
            ? " Le Video Judge n'a pas pu évaluer plusieurs critères (appel fournisseur indisponible ou réponse non exploitable) — pas un problème de contenu créatif."
            : '';
        throw new Error(
          `QUALITY_GATE: la vidéo finale n'a pas atteint le seuil de qualité requis après ${results.maxRepairAttempts} tentative(s) de correction (score global ${outcome.lastJudge.globalScore}/100).${bestScoreNote}${causeRacineNote}${escalationNote}${providerNote}`,
        );
      }

      const attempts: QualityLoopAttemptTrace[] = outcome.attempts;

      if (outcome.finalized.status === 'skipped') {
        this.logger.warn(`Assemblage vidéo final ignoré (${outcome.finalized.reason}) — repli sur la vidéo brute.`);
        const elapsedMsSkipped = Date.now() - startTime;
        await this.creativeGenerationTrace.upsertTrace({
          organizationId,
          campaignId,
          creativeIntelligence: results.creativeIntelligence,
          creativeConcept: currentCreativeConcept,
          shotPlanVersions,
          attempts,
          costEstimate: { checkpointA: results.checkpointACost, checkpointBFinalMaxRepairAttempts: results.maxRepairAttempts },
          qualityTarget: results.qualityTarget,
          preProductionJudge: currentPreProductionJudge,
          productUrl: results.productProfile?.productUrl,
          productUrlFacts: results.productProfile?.productUrlFacts as unknown as ProductUrlFacts | null,
          productConflicts: results.productProfile?.productConflicts as unknown as ProductFactConflict[] | undefined,
          finalOutcome: 'SKIPPED_NO_VIDEO',
          report: {
            ...buildQualityReport(outcome),
            totalStoryboardRevisions: storyboardEscalated ? 1 : 0,
            totalConceptRevisions: conceptEscalated ? 1 : 0,
            totalCredits: await this.getTotalCreditsForCampaign(campaignId),
            elapsedMs: elapsedMsSkipped,
            rootCause: null,
            goalFirstRootCause: null,
            escalationLevel,
            stopReason: 'SKIPPED_NO_VIDEO — assemblage final ignoré (mode mock/narration indisponible)',
            timeBudgetStatus: computeTimeBudgetStatus(elapsedMsSkipped),
            plannedShotCount: currentShotPlan.length,
            deliveredShotCount: currentVideoClips.length,
            discardedClipsOnEscalation,
          },
          elapsedMs: elapsedMsSkipped,
          attemptCount: totalAttemptCount,
          escalationLevel,
        });
        return { asset: rawVideoAsset, finalTranscript: outcome.transcript };
      }

      const uploaded = await this.storage.upload(organizationId, outcome.finalized.buffer, 'campaign-final.mp4', outcome.finalized.mimeType);
      // generationId volontairement absent : cet Asset est un COMPOSITE de plusieurs générations
      // (vidéo + narration + transcription), aucune ne le représente 1:1 — et Asset.generationId
      // est @unique, déjà réclamé par rawVideoAsset et l'Asset de narration ci-dessus.
      const asset = await this.assets.register({
        organizationId,
        type: 'VIDEO',
        source: 'GENERATED',
        url: uploaded.url,
        storageKey: uploaded.key,
        mimeType: outcome.finalized.mimeType,
        fileSizeBytes: outcome.finalized.buffer.length,
      });

      const elapsedMsPassed = Date.now() - startTime;
      await this.creativeGenerationTrace.upsertTrace({
        organizationId,
        campaignId,
        creativeIntelligence: results.creativeIntelligence,
        creativeConcept: currentCreativeConcept,
        shotPlanVersions,
        attempts,
        costEstimate: { checkpointA: results.checkpointACost, checkpointBFinalMaxRepairAttempts: results.maxRepairAttempts },
        qualityTarget: results.qualityTarget,
        preProductionJudge: currentPreProductionJudge,
        productUrl: results.productProfile?.productUrl,
        productUrlFacts: results.productProfile?.productUrlFacts as unknown as ProductUrlFacts | null,
        productConflicts: results.productProfile?.productConflicts as unknown as ProductFactConflict[] | undefined,
        finalOutcome: 'PASSED',
        report: {
          ...buildQualityReport(outcome),
          totalStoryboardRevisions: storyboardEscalated ? 1 : 0,
          totalConceptRevisions: conceptEscalated ? 1 : 0,
          totalCredits: await this.getTotalCreditsForCampaign(campaignId),
          elapsedMs: elapsedMsPassed,
          rootCause: null,
          goalFirstRootCause: null,
          escalationLevel,
          stopReason: 'PASSED',
          timeBudgetStatus: computeTimeBudgetStatus(elapsedMsPassed),
          plannedShotCount: currentShotPlan.length,
          deliveredShotCount: currentVideoClips.length,
          discardedClipsOnEscalation,
        },
        elapsedMs: elapsedMsPassed,
        attemptCount: totalAttemptCount,
        escalationLevel,
      });

      // Phase J — Final Advertising Gate (chantier V2, 2026-08-19, spec Sections 59-61) : dernière
      // validation avant livraison — un Video Judge PASS seul ne suffit pas si une porte amont
      // (Creative Gate/Storyboard Gate) n'a pas été franchie ou si l'audio requis est incomplet.
      // Câblage pur, aucun nouveau jugement — ANDs les statuts déjà calculés plus haut (Phase P :
      // les statuts COURANTS, qui reflètent une éventuelle escalade, pas ceux de la 1ère tentative).
      const delivery = evaluateFinalDelivery({
        creativeGateStatus: currentCreativeGateStatus,
        storyboardGateStatus: currentStoryboardGateStatus,
        judge: outcome.lastJudge!,
        narrationDataUri: currentNarrationDataUri,
        transcript: outcome.transcript,
        format: currentCreativeConcept.format,
        plannedShotCount: currentShotPlan.length,
        deliveredShotCount: currentVideoClips.length,
      });
      // Mission 4.3 (Étape 14/18, tolérance zéro) — delivery.partialDelivery n'est plus jamais
      // acceptée séparément : evaluateFinalDelivery l'inclut désormais TOUJOURS dans
      // blockingReasons quand elle est vraie, donc le throw ci-dessus la couvre déjà.
      if (!delivery.deliverable) {
        throw new Error(`QUALITY_GATE: livraison finale refusée malgré un Video Judge PASS (${delivery.blockingReasons.join('; ')}).`);
      }

      return { asset, finalTranscript: outcome.transcript };
    }
  }

  // Phase P — décide SI et À QUEL NIVEAU escalader après un épuisement de la Quality Loop, puis
  // EXÉCUTE réellement cette escalade (pas seulement une recommandation, cf. Phase F/
  // buildQualityReport.actionRecommandee qui restait purement informative). classifyRootCause
  // (root-cause.ts) ne voit que l'historique SCÈNE de CETTE exécution de la Quality Loop — il ne
  // peut structurellement pas savoir qu'un storyboard a déjà été régénéré lors d'un tour
  // précédent de cette MÊME campagne. C'est pourquoi cette méthode, pas classifyRootCause,
  // porte la règle "storyboard avant concept, jamais l'inverse, jamais deux fois le même niveau"
  // (spec Section 5 et 19) — via les drapeaux déjà posés par l'appelant.
  private async tryEscalate(
    ctx: { organizationId: string; campaignId: string; purpose: 'campaign_generation' },
    organizationId: string,
    campaignId: string,
    results: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>,
    outcome: Extract<QualityLoopOutcome, { status: 'REPAIR_EXHAUSTED' }>,
    state: { currentShotPlan: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['shotPlan']; currentCreativeConcept: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['creativeConcept']; storyboardEscalated: boolean; conceptEscalated: boolean },
  ): Promise<{
    // Exposé QUE l'escalade ait eu lieu ou non (Phase Q en a besoin pour enrichir le rapport
    // persisté même quand aucune escalade n'a été tentée) — null uniquement si aucun défaut
    // exploitable n'a pu être identifié (ordreDePriorite vide).
    rootCause: RootCauseLevel | null;
    result:
      | {
          level: 'STORYBOARD' | 'CONCEPT';
          shotPlan: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['shotPlan'];
          video: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['video'];
          videoClips: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['videoClips'];
          perShotQuality: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['perShotQuality'];
          storyboardGateStatus: StoryboardGateStatus;
          // Mission 4.3 (Goal-First Quality Architecture, Phase 6b) — toujours présent, même
          // raisonnement que narrativeBlueprint ci-dessous : les deux branches STORYBOARD/CONCEPT
          // le retournent désormais systématiquement.
          storyboardGateResult: StoryboardGateResult;
          // Mission 4.3 (Goal-First Quality Architecture, Phase 4) — toujours présent (les deux
          // branches STORYBOARD/CONCEPT de regenerateShotPlanAndVideo/
          // regenerateConceptStoryboardAndVideo le retournent désormais systématiquement, enrichi).
          narrativeBlueprint: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['narrativeBlueprint'];
          creativeConcept?: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['creativeConcept'];
          creativeGateStatus?: CreativeGateStatus;
          narrationText?: string;
          narrationDataUri?: string;
          transcript?: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>['transcript'];
        }
      | null;
  }> {
    const report = buildQualityReport(outcome);
    // Audit forensic (2026-08-20, campagne 83cbcd41-2baf-4517-bb4e-edee62b1c910) — `rootCause`
    // se base désormais sur `report.mostSevereDefect` (le défaut le plus GRAVE par score, cf.
    // quality-report.ts::findMostSevereDefect), plus sur `ordreDePriorite[0]`. `ordreDePriorite`
    // est pondéré par computePriority (poids × sévérité ÷ coût de réparation) : un défaut
    // UNREPAIRABLE (coût infini) y retombe TOUJOURS à la priorité 0, donc ne peut jamais devenir
    // `topDefectName` même s'il est objectivement le plus grave — c'est exactement ce qui faisait
    // dériver `rootCause` vers "SUBTITLE" (pacing, réparable à 8 crédits) alors que le vrai défaut
    // était "storytelling" (score 38, UNREPAIRABLE — la voix off contredisait le concept), et donc
    // vers une classification jamais éligible à l'escalade storyboard/concept qui aurait pu
    // réellement corriger le problème.
    const topDefect = report.mostSevereDefect;
    // Mission 3 (validation empirique, 2026-08-20) — allCriteria transmis pour que
    // classifyRootCause puisse détecter un échec de l'appel Judge groupé (majorité des 9 critères
    // texte marqués UNAVAILABLE_DEFECT DANS CE MÊME jugement) même quand le défaut le plus grave
    // au sens de la sévérité est un AUTRE critère (un vrai défaut audio/produit coexistant, par
    // exemple) — sans cette liste complète, l'échec du Judge resterait invisible.
    const rootCause: RootCauseLevel | null = topDefect
      ? classifyRootCause(topDefect.name, { sceneRef: topDefect.sceneRef, history: outcome.history, allCriteria: outcome.bestAttempt.judge.criteria })
      : null;

    // Audit forensique Mission 4.2 (P1-3) : l'ancien gate ci-dessous se basait sur
    // report.actionRecommandee ('ESCALADE_STORYBOARD_RECOMMANDEE', dérivé dans quality-report.ts
    // de `outcome.history.some(h => h.outcome === 'ECHEC')`) — un effet de bord des stratégies de
    // réparation EFFECTIVEMENT tentées, pas de la classification réelle de la cause. Or les causes
    // STORYBOARD/CONCEPT (storytelling, hookStrength, advertisingEffectiveness) sont TOUJOURS
    // classées UNREPAIRABLE (cf. repair-dispatch.ts) : quand un tel défaut est seul en cause dès la
    // 1ère tentative, applyRepairs n'en tente jamais la réparation, l'historique reste vide,
    // actionRecommandee retombe à 'RETRY_LOCAL' — et l'ancien gate bloquait l'escalade AVANT même
    // de vérifier si rootCause l'autorisait, alors que c'est exactement le cas où l'escalade est
    // le plus nécessaire. Seule la classification RÉELLE de la cause (rootCause) décide désormais
    // de l'éligibilité — jamais un effet de bord de l'historique de réparation.
    if (!rootCause) return { rootCause, result: null };

    // Jamais une cause sans levier de régénération connu (BRAND/AUDIO/ASSEMBLY/PROVIDER/UNKNOWN)
    // — SAUF si le storyboard a déjà été escaladé sans succès : à ce stade, le concept reste le
    // dernier rung disponible, quelle que soit la classification précise du défaut qui a motivé
    // CE nouvel épuisement (spec Section 19 : jamais plus de 2 escalades au total).
    const escalatableCause = rootCause === 'SCENE' || rootCause === 'STORYBOARD' || rootCause === 'PRODUCT_FIDELITY' || rootCause === 'CONCEPT';
    if (!escalatableCause && !state.storyboardEscalated) return { rootCause, result: null };

    const escalationFeedback = topDefect?.defect
      ? `${topDefect.name}: ${topDefect.defect}`
      : outcome.bestAttempt.judge.criteria.filter((c) => c.defect).map((c) => `${c.name}: ${c.defect}`).join(' | ') || 'Qualité globale insuffisante après plusieurs tentatives de réparation locale.';

    if (!state.storyboardEscalated && rootCause !== 'CONCEPT') {
      const escalation = await this.orchestrator.regenerateShotPlanAndVideo(ctx, {
        creativeConcept: state.currentCreativeConcept,
        visualDnaResult: results.visualDnaResult,
        referenceImageUrl: results.referenceImageUrl,
        effectiveParams: results.effectiveParams,
        strategy: results.strategy.content,
        narrativeBlueprint: results.narrativeBlueprint,
        organizationId,
        escalationFeedback,
        qualityTarget: results.qualityTarget,
        productProfile: results.productProfile,
      });
      return { rootCause, result: { level: 'STORYBOARD', ...escalation } };
    }

    if (!state.conceptEscalated) {
      const escalation = await this.orchestrator.regenerateConceptStoryboardAndVideo(ctx, {
        creativeIntelligence: results.creativeIntelligence,
        visualDnaResult: results.visualDnaResult,
        referenceImageUrl: results.referenceImageUrl,
        effectiveParams: results.effectiveParams,
        strategy: results.strategy.content,
        organizationId,
        productProfile: results.productProfile,
        escalationFeedback,
        qualityTarget: results.qualityTarget,
      });
      return { rootCause, result: { level: 'CONCEPT', ...escalation } };
    }

    return { rootCause, result: null }; // budget d'escalade épuisé (storyboard ET concept déjà tentés)
  }

  // Phase Q — coût réel agrégé pour CETTE campagne, tous appels IA confondus (texte, image,
  // vidéo, audio, toutes escalades incluses) — même pattern `aggregate({ _sum: { costEstimate } })`
  // que AiEconomicsService utilise déjà pour ses propres rapports, appliqué ici filtré par
  // campaignId plutôt qu'organisation/période. Nommé `totalCredits` (spec Section 26) bien que
  // le champ sous-jacent (AiGeneration.costEstimate) soit le coût réel ($), pas l'unité crédit
  // commerciale (CREDIT_COSTS) — les deux sont proportionnels au même jeu d'appels, et bâtir un
  // second grand livre de crédits par campagne serait un chantier séparé, hors périmètre ici.
  private async getTotalCreditsForCampaign(campaignId: string): Promise<number> {
    const { _sum } = await this.prisma.aiGeneration.aggregate({
      where: { campaignId },
      _sum: { costEstimate: true },
    });
    return _sum.costEstimate ?? 0;
  }

  // L'audio TTS n'a, contrairement à l'image/la vidéo, aucune URL fournisseur temporaire à
  // re-héberger (cf. OpenAiProvider.generateAudio) : son "content" est déjà les octets bruts,
  // encodés en data URI. Décodé et stocké directement via StorageService.upload() — le même
  // mécanisme qu'un fichier téléversé manuellement, pas un re-hébergement depuis une URL.
  private async registerGeneratedAudio(organizationId: string, dataUri: string, generationId: string | undefined) {
    const match = /^data:(.+?);base64,(.+)$/.exec(dataUri);
    if (!match) {
      // Repli : provider mock (ou futur fournisseur renvoyant directement une URL hébergée)
      // plutôt qu'un data URI — jamais d'exception pour une forme de contenu inattendue ici.
      return this.assets.register({ organizationId, type: 'AUDIO', source: 'GENERATED', url: dataUri, generationId });
    }

    const [, mimeType, base64] = match;
    const buffer = Buffer.from(base64, 'base64');
    const extension = mimeType.split('/')[1] ?? 'bin';
    const uploaded = await this.storage.upload(organizationId, buffer, `narration.${extension}`, mimeType);

    return this.assets.register({
      organizationId,
      type: 'AUDIO',
      source: 'GENERATED',
      url: uploaded.url,
      storageKey: uploaded.key,
      mimeType,
      generationId,
    });
  }

  // Les fournisseurs d'IA (OpenAI, Flux, Ideogram, Google Veo) renvoient tous des URLs
  // TEMPORAIRES pour les images/vidéos générées (généralement quelques heures) — sans
  // re-hébergement, un visuel de campagne casserait silencieusement une fois cette fenêtre
  // passée. On tente donc systématiquement de rapatrier le fichier vers notre propre
  // stockage permanent ; en cas d'échec (timeout, contenu déjà expiré), on se rabat sur
  // l'URL d'origine plutôt que de faire échouer toute la génération de campagne pour un
  // problème de re-hébergement — mieux vaut un visuel qui expirera dans quelques heures
  // qu'une campagne entièrement bloquée.
  private async registerGeneratedVisual(
    organizationId: string,
    type: 'IMAGE' | 'VIDEO',
    providerUrl: string,
    generationId: string | undefined,
    fileNameHint: string,
  ) {
    const rehosted = await this.storage.uploadFromUrl(organizationId, providerUrl, fileNameHint);

    return this.assets.register({
      organizationId,
      type,
      source: 'GENERATED',
      url: rehosted?.url ?? providerUrl,
      storageKey: rehosted?.key,
      generationId,
    });
  }
}
