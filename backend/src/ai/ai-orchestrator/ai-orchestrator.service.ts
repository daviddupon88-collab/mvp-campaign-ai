import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { AiGenerationResult, TranscriptSegment } from '../ai-gateway/providers/ai-provider.interface';
import { BrandContextBuilderService } from '../../brand/brand-context-builder.service';
import { VideoFinalizationService } from '../../video-assembly/video-finalization.service';
import { PlanLimitExceededException, PlanLimitExceededPayload } from '../../plans/plan-limit.exception';
import { VisualDnaService, VisualDna } from '../video-direction/visual-dna.service';
import { VideoDirectorService, ShotPlan, Shot, linkBeatsToShots } from '../video-direction/video-director.service';
import { VideoAnalyzerService, ShotQualityResult } from '../video-direction/video-analyzer.service';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { ProductIntelligenceService } from '../product-intelligence/product-intelligence.service';
import { renderGroundedContext } from '../product-intelligence/product-grounding';
import { ProductIntelligenceProfile } from '@prisma/client';
import { ProductFactConflict } from '../product-intelligence/product-fact.types';
import { CreativeIntelligenceService } from '../creative-intelligence/creative-intelligence.service';
import { CreativeConceptService } from '../creative-intelligence/creative-concept.service';
import { NarrativeBlueprintService } from '../creative-intelligence/narrative-blueprint.service';
import { NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';
import { buildNarrationFromBlueprint } from '../creative-intelligence/narrative-blueprint-narration';
import { ShotExecutionContext, compileShotExecutionInstruction } from '../video-direction/shot-execution-compiler';
import { evaluatePreFlightQuality } from '../video-direction/preflight-quality-gate';
import { CreativeGateService } from '../creative-intelligence/creative-gate.service';
import { CreativeGateStatus } from '../creative-intelligence/creative-gate.types';
import { CreativeIntelligence } from '../creative-intelligence/creative-intelligence.types';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { CostControlService } from '../../plans/cost-control.service';
import { VideoQualityLoopService, VideoClip } from '../video-judge/video-quality-loop.service';
import { detectShotRepetition, shouldRegeneratePlan, buildAvoidRepetitionHint, ShotRepetitionWarning } from '../video-direction/shot-diversity';
import { validateShotPlan } from '../video-direction/shot-plan-validator';
import { StoryboardGateService, applySafePruning } from '../video-direction/storyboard-gate.service';
import { StoryboardGateStatus, StoryboardGateResult } from '../video-direction/storyboard-gate.types';
import { sortByGenerationPriority } from '../video-direction/shot-risk';
import { EntitlementsService } from '../../plans/entitlements.service';
import { QualityTarget, QUALITY_TARGET_V1 } from '../quality/quality-target';

export interface GenerateCampaignParams {
  organizationId: string;
  campaignId: string;
  // Les deux sont optionnels côté type, mais CampaignsService.create() garantit qu'au moins
  // l'un des deux est fourni avant d'empiler le job — jamais les deux absents en pratique.
  productDescription?: string;
  productImageUrl?: string;
  // Mission 4.4 (Product URL Intelligence) — URL de page produit publique, optionnelle. Jamais
  // transmise telle quelle à un prompt créatif (cf. product-page-url-validator.ts/
  // safe-product-page-fetcher.service.ts) : source de FAITS produit, pas de contenu de prompt.
  productUrl?: string;
  objective: string;
  channels?: string[]; // ex: ['facebook','instagram','tiktok'] — détermine si une vidéo est générée
  templateHints?: {
    toneHint?: string;
    analysisAngle?: string;
    personaArchetype?: string;
    ctaStyle?: string;
  }; // cf. CampaignTemplate.structureHint — Module 18, guide l'Orchestrator sans figer le contenu
  // Mission 4.3 (Goal-First Quality Architecture, Phase 7, Étape 19) — présent UNIQUEMENT quand
  // CampaignsService.regenerate() a confirmé une réutilisation ciblée valide (photo/description/
  // objectif/canaux identiques à la dernière tentative ET une CreativeGenerationTrace existante
  // pour cette campagne, cf. regenerate()). CampaignGenerationProcessor route alors vers
  // AiOrchestratorService.regenerateFromApprovedConcept() au lieu de generateCampaign() —
  // même job/payload de queue pour les deux chemins, un seul champ discriminant.
  reuseApprovedConcept?: {
    creativeIntelligence: CreativeIntelligence;
    creativeConcept: CreativeConcept;
    qualityTarget: QualityTarget;
  };
}

// Mission 4.4 (Product URL Intelligence) — productConflicts est un champ Json? Prisma, jamais
// typé statiquement côté client généré — un seul point de cast, réutilisé à chaque site qui doit
// lire ce champ (PreFlightQualityGate, StoryboardGateService), plutôt que répété 6 fois.
function productConflictsOf(profile: ProductIntelligenceProfile | null): ProductFactConflict[] | undefined {
  return (profile?.productConflicts as unknown as ProductFactConflict[] | undefined) ?? undefined;
}

// AI Orchestrator (cf. chapitre 10.4) : composant le plus stratégique de la plateforme.
// L'utilisateur décrit un besoin, l'Orchestrator décide quelle tâche envoyer à quel
// fournisseur — la traçabilité économique (coût, tokens, durée, crédits) et l'application
// des quotas/budgets sont désormais entièrement gérées par AiGatewayService, pas ici :
// l'Orchestrator n'a plus qu'à décrire QUOI générer, jamais à se soucier du COMMENT tracker.
@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger(AiOrchestratorService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly brandContext: BrandContextBuilderService,
    // Concaténation multi-plans uniquement (cf. generateShotPlanVideoOrDegrade) — tout accès
    // ffmpeg/réseau réel reste encapsulé dans VideoAssemblyModule, mockable en un seul point
    // ici plutôt que de dupliquer cette logique directement dans l'Orchestrator.
    private readonly videoFinalization: VideoFinalizationService,
    // Architecture Shot Plan (2026-08-18) : remplace l'ancien mécanisme (un prompt texte unique
    // demandant à Veo de comprendre le produit, inventer le scénario ET cadrer/filmer en même
    // temps — résultat générique et souvent quasi statique). Vision → Visual DNA → Video
    // Director → Shot Plan → Veo → Video Analyzer, cf. commentaires dans generateCampaign().
    private readonly visualDna: VisualDnaService,
    private readonly videoDirector: VideoDirectorService,
    private readonly videoAnalyzer: VideoAnalyzerService,
    // Product Intelligence (2026-08-18) : construit/réutilise (cache) le profil produit et
    // l'injecte comme contexte de grounding dans le prompt de stratégie — cf. plus bas.
    private readonly productIntelligence: ProductIntelligenceService,
    // Creative Intelligence Engine & Video Quality Loop (2026-08-18) — cf. plan dédié.
    private readonly creativeIntelligenceService: CreativeIntelligenceService,
    private readonly creativeConceptService: CreativeConceptService,
    // Mission 4.3 (Goal-First Quality Architecture, Phase 3) — cf. plan dédié.
    private readonly narrativeBlueprintService: NarrativeBlueprintService,
    // Moteur d'optimisation de la qualité vidéo — V2 (2026-08-19) — cf. plan dédié.
    private readonly creativeGateService: CreativeGateService,
    private readonly storyboardGateService: StoryboardGateService,
    private readonly costControl: CostControlService,
    // Phase M (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — lecture seule du
    // quota vidéo restant, pour plafonner UNE FOIS la taille d'un lot de génération parallèle
    // (cf. generateShotPlanVideoOrDegrade) plutôt que de laisser plusieurs appels concurrents
    // vérifier indépendamment le même compte (TOCTOU).
    private readonly entitlements: EntitlementsService,
  ) {}

  // Exemple d'orchestration simplifiée du flux "Générer une campagne complète"
  // décrit au chapitre 9.1 : analyse produit -> stratégie -> copywriting par canal -> visuel.
  //
  // GÉNÉRATION SPÉCIFIQUE PAR CANAL — auparavant, un seul texte de copywriting générique
  // était dupliqué tel quel sur chaque canal sélectionné (limitation documentée dans ce
  // fichier). Chaque canal a désormais son propre appel de génération, avec un prompt qui
  // reflète son registre et ses contraintes réelles : Instagram (texte court + hashtags),
  // LinkedIn (argumentation B2B professionnelle), Facebook (ton conversationnel), TikTok
  // (hook + script vidéo), Google Ads (titres/descriptions au format JSON, validés et
  // tronqués aux limites réelles de la plateforme — 30/90 caractères).
  //
  // CONSÉQUENCE ÉCONOMIQUE ASSUMÉE : chaque canal supplémentaire ajoute un appel
  // generateText distinct (8 crédits chacun, cf. CREDIT_COSTS dans plan-catalog.ts) —
  // le coût scale désormais avec le nombre de canaux sélectionnés, alors qu'un seul appel
  // couvrait auparavant tous les canaux. C'est le prix réel d'une vraie différenciation par
  // canal plutôt qu'un copier-coller : cohérent avec le principe déjà établi ailleurs dans
  // le système de crédits (plus de travail réel = plus de coût réel), mais à surveiller
  // pour les plans à faible quota (l'essai gratuit, notamment — cf. README).
  async generateCampaign(params: GenerateCampaignParams) {
    const hints = params.templateHints;
    const analysisAngleHint = hints?.analysisAngle ? `\nAngle d'analyse à privilégier : ${hints.analysisAngle}` : '';
    const personaHint = hints?.personaArchetype ? `\nArchétype de persona à cibler : ${hints.personaArchetype}` : '';

    const ctx: AiCallContext = { organizationId: params.organizationId, campaignId: params.campaignId, purpose: 'campaign_generation' };

    // Mission 4.3 (Goal-First Quality Architecture, Phase 1, Étape 1) — QualityTarget créé ICI,
    // AVANT tout appel Creative Intelligence/Creative Concept, exactement comme le brief l'exige :
    // "the target is not an evaluation performed after production". Source UNIQUE du score cible
    // (75) désormais consommée par Creative Gate ET Storyboard Gate (chacun en dérive ses propres
    // QualityRequirements filtrées à son stade, cf. CreativeGateService/StoryboardGateService) —
    // remplace les deux constantes dupliquées CREATIVE_GATE_THRESHOLD/STORYBOARD_GATE_THRESHOLD qui
    // pouvaient diverger sans qu'aucun test ne le détecte. Persisté tel quel (cf. return plus bas)
    // pour que CampaignGenerationProcessor le transmette à CreativeGenerationTrace.
    const qualityTarget: QualityTarget = QUALITY_TARGET_V1;

    // Checkpoint A (P0.9, chantier "Creative Intelligence Engine & Video Quality Loop",
    // 2026-08-18) — AVANT TOUT appel IA : hypothèse prudente (3 scènes, cf.
    // CostControlService.DEFAULT_ASSUMED_SCENES) tant que le Creative Concept réel n'existe pas
    // encore. Lève PlanLimitExceededException(credits) si même ce pire cas grossier ne rentre
    // pas dans le budget restant — évite de dépenser en analyse/stratégie/copy une campagne dont
    // la vidéo n'aurait de toute façon jamais pu aboutir.
    const channelCountHint = params.channels && params.channels.length > 0 ? params.channels.length : 1;
    const checkpointACost = await this.costControl.assertBeforeGeneration(params.organizationId, channelCountHint, VideoQualityLoopService.MAX_REPAIR_ATTEMPTS);

    // Fix du bug racine identifié à l'audit du 2026-08-12 : BrandService.buildPromptContext()
    // n'était jamais appelé nulle part — l'identité de marque et la mémoire de marque
    // n'atteignaient donc jamais aucun prompt de génération malgré ce que prétendait le
    // README. Contexte GLOBAL (pas encore de canal à ce stade) — le persona vient du hint de
    // template quand il est identifiable (jamais deviné, cf. Phase 7), jamais inventé sinon.
    const globalBrandContext = await this.brandContext.build({
      organizationId: params.organizationId,
      persona: hints?.personaArchetype,
    });
    const brandContextBlock = globalBrandContext.text ? `\n\nContexte de marque :\n${globalBrandContext.text}` : '';

    // "Une photo suffit" (page d'accueil) : quand une photo produit est fournie, l'analyse
    // passe par la vision plutôt qu'un texte décrit à la main — c'est la promesse centrale
    // du produit, jusqu'ici jamais câblée malgré analyzeImage() déjà disponible côté AI
    // Gateway (utilisé ailleurs pour la modération/cohérence de marque, jamais en entrée).
    // La description texte reste utilisable seule (repli, comportement historique inchangé)
    // ou en complément d'une photo (recoupée dans le prompt de vision).
    // Calculé ICI (avant la stratégie, pas après comme auparavant) : la stratégie doit être
    // bornée aux canaux RÉELLEMENT sélectionnés et au format RÉELLEMENT livré par campaign-ai
    // (un texte par canal + un visuel + une courte vidéo) — sans cette contrainte, le modèle
    // propose spontanément un plan omnicanal complet (emails, SMS, landing page dédiée,
    // retargeting publicitaire...) qu'aucune étape en aval ne produit jamais. Bug réel constaté
    // en conditions réelles le 2026-08-18 : le nouveau gate OBJECTIVE_ACHIEVEMENT comparait
    // honnêtement ce plan fictif aux quelques posts réellement générés et rejetait la campagne
    // pour "objectif non atteint" — alors que le vrai problème était que la stratégie promettait
    // des livrables que le produit ne fabrique jamais, pas un manque réel de contenu.
    const targetChannels = params.channels && params.channels.length > 0 ? params.channels : ['general'];

    // Parallélisé (2026-08-19, optimisation latence) : productAnalysis et productProfile ne
    // dépendent l'un de l'autre en RIEN (deux appels vision/texte indépendants sur la même
    // photo/description) — seule la stratégie plus bas a besoin des DEUX résultats. Les
    // exécuter en série coûtait un temps réel cumulé pour rien.
    //
    // "Une photo suffit" (page d'accueil) : quand une photo produit est fournie, l'analyse
    // passe par la vision plutôt qu'un texte décrit à la main — c'est la promesse centrale
    // du produit, jusqu'ici jamais câblée malgré analyzeImage() déjà disponible côté AI
    // Gateway (utilisé ailleurs pour la modération/cohérence de marque, jamais en entrée).
    // La description texte reste utilisable seule (repli, comportement historique inchangé)
    // ou en complément d'une photo (recoupée dans le prompt de vision).
    //
    // Product Intelligence (chantier "Product Intelligence & Creative Intelligence Engine V2",
    // 2026-08-18) — additif : uniquement quand une vraie photo est fournie (rien à ancrer sinon).
    // Mis en cache par ProductIntelligenceService (hash de l'image) : une même photo ne relance
    // jamais les appels vision/identification pour une nouvelle campagne. Le bloc de grounding
    // s'ajoute au prompt de stratégie existant — se propage automatiquement au copywriting par
    // canal (qui interpole déjà strategyContent en entier), aucun autre changement de signature.
    // Profil capturé en VARIABLE (P0.1, chantier Creative Intelligence Engine, 2026-08-18) —
    // avant ce chantier, immédiatement rendu en texte sans jamais être conservé comme objet
    // structuré ; CreativeIntelligenceService en a besoin comme entrée typée, pas seulement
    // pré-rendue.
    const [productAnalysis, productProfile] = await Promise.all([
      params.productImageUrl
        ? this.analyzeProductImage(ctx, params.productImageUrl, params.productDescription, analysisAngleHint)
        : this.aiGateway.generateText(
            ctx,
            { prompt: `Analyse ce produit et identifie ses forces, faiblesses et USP: ${params.productDescription}${analysisAngleHint}` },
            'openai', // routage: analyse rapide -> modèle économique
            PROMPT_VERSIONS.productAnalysis,
          ),
      params.productImageUrl
        // Mission 4.4 (Product URL Intelligence) — productUrl n'active la fusion que lorsqu'une
        // photo est ÉGALEMENT fournie : le cache de profil reste basé sur le hash de l'image
        // (limite connue, documentée — une soumission URL seule sans photo n'est pas encore un
        // chemin supporté, cf. rapport final).
        ? this.productIntelligence.buildProfile(ctx, params.organizationId, params.productImageUrl, params.productDescription, params.productUrl)
        : Promise.resolve(null as ProductIntelligenceProfile | null),
    ]);
    const groundedContextBlock = productProfile ? `\n\n${renderGroundedContext(productProfile)}` : '';

    const strategy = await this.aiGateway.generateText(
      ctx,
      {
        prompt: `À partir de cette analyse produit, propose une stratégie marketing SMART pour l'objectif "${params.objective}".
Contrainte impérative : cette stratégie doit être intégralement réalisable avec UNIQUEMENT ce que campaign-ai produit réellement pour cette campagne — un texte publicitaire par canal parmi [${targetChannels.join(', ')}], un visuel, et une courte vidéo. Ne propose JAMAIS de tactiques hors de ce périmètre (emails, SMS, landing page dédiée, retargeting publicitaire, pop-up, etc.) — la stratégie doit se limiter à ce qui sera effectivement livré sur ces canaux.
${productAnalysis.content}${personaHint}${brandContextBlock}${groundedContextBlock}

Termine ta réponse par un bloc structuré, strictement basé sur l'analyse produit ci-dessus (jamais une caractéristique inventée), au format :

AUDIENCE : <cible en une phrase>
TON : <ton éditorial à adopter>
MESSAGE CLÉ : <la promesse centrale, en une phrase>
MANDATORIES : <affirmations vérifiables sur le produit UNIQUEMENT — une par ligne commençant par "-" — ne jamais inclure de caractéristique (écologique, biodégradable, hypoallergénique, etc.) non confirmée explicitement par l'analyse produit ci-dessus>`,
      },
      'anthropic', // routage: raisonnement stratégique -> modèle plus fort
      PROMPT_VERSIONS.strategy,
    );

    // À partir d'ici, plus aucune étape n'a besoin de savoir si la description vient du texte
    // saisi ou a été dérivée de l'analyse photo — un seul champ texte non vide, garanti par
    // ce repli, pour tous les prompts qui suivent (copywriting par canal, visuel, vidéo).
    const effectiveParams: GenerateCampaignParams = {
      ...params,
      productDescription: params.productDescription?.trim() || productAnalysis.content,
    };

    // Creative Intelligence + Creative Concept (P0.1/P0.2, chantier "Creative Intelligence
    // Engine & Video Quality Loop", 2026-08-18) — remplace le bloc informel (AUDIENCE/TON/
    // MESSAGE CLÉ/MANDATORIES) qui restait figé dans le prompt de stratégie ci-dessus par une
    // intelligence publicitaire structurée (16 champs) puis un vrai concept publicitaire
    // (démonstration, pas description — cf. templates). Fonctionne AUSSI sans photo
    // (productProfile=null, repli sur productDescription texte) — décision de périmètre
    // explicite, cf. plan : le Creative Layer ne doit pas être réservé aux campagnes avec photo.
    const creativeIntelligence: CreativeIntelligence = await this.creativeIntelligenceService.generate(ctx, {
      productProfile,
      productDescription: effectiveParams.productDescription,
      objective: params.objective,
      audience: hints?.personaArchetype,
      strategyContent: strategy.content,
    });
    let creativeConcept: CreativeConcept = await this.creativeConceptService.generate(ctx, { creativeIntelligence, qualityTarget, productProfile });

    // Phase G — Creative Gate (chantier "Moteur d'optimisation de la qualité vidéo — V2",
    // 2026-08-19, spec Sections 35-45) : valide le concept AVANT tout Shot Plan/vidéo — "ne
    // jamais utiliser la génération vidéo comme outil de découverte" (spec Section 45). Boucle
    // bornée à UNE régénération, jamais plus (même philosophie que shot-diversity.ts) : au-delà,
    // la campagne échoue proprement plutôt que de tenter une génération vidéo (150 crédits/plan)
    // sur un concept jamais validé.
    let creativeGate = await this.creativeGateService.evaluate(ctx, { creativeIntelligence, creativeConcept, objective: params.objective, productProfile, qualityTarget });
    if (creativeGate.status !== 'APPROVED') {
      this.logger.warn(`Creative Gate ${creativeGate.status} (score ${creativeGate.score}/100) — régénération unique du concept avec le retour du jugement.`);
      const gateFeedback = [...creativeGate.faiblesses, creativeGate.recommandation].filter(Boolean).join(' ');
      creativeConcept = await this.creativeConceptService.generate(ctx, { creativeIntelligence, gateFeedback, qualityTarget, productProfile });
      creativeGate = await this.creativeGateService.evaluate(ctx, { creativeIntelligence, creativeConcept, objective: params.objective, productProfile, qualityTarget });
      if (creativeGate.status !== 'APPROVED') {
        throw new Error(
          `QUALITY_GATE: concept publicitaire insuffisant après révision (statut ${creativeGate.status}, score ${creativeGate.score}/100) — ${[...creativeGate.causesDeRejet, ...creativeGate.faiblesses].join('; ') || 'aucun détail disponible'}.`,
        );
      }
    }

    return this.finishCampaignFromApprovedConcept(ctx, params, {
      productAnalysis, productProfile, effectiveParams, strategy, creativeIntelligence, creativeConcept,
      creativeGateStatus: creativeGate.status, qualityTarget, checkpointACost,
    });
  }

  // Mission 4.3 (Goal-First Quality Architecture, Phase 7, Étape 19) — extraction du bloc partagé
  // "Creative Concept déjà approuvé -> NarrativeBlueprint -> narration -> copie par canal -> visuel
  // -> Visual DNA -> Shot Plan -> Storyboard Gate -> vidéo" hors de generateCampaign() : appelé par
  // generateCampaign() lui-même (comportement byte-identique, seule la forme change) ET par
  // regenerateFromApprovedConcept() (nouveau, Phase 7) qui réutilise un Creative Concept déjà
  // approuvé au lieu d'en régénérer un — contrairement au précédent Phase P (regenerateShotPlanAndVideo,
  // volontairement dupliqué pour ne jamais toucher le corps de generateCampaign()), une VRAIE
  // extraction est ici plus sûre : dupliquer ce bloc de ~240 lignes (quasi la totalité du corps de
  // la méthode) aurait un risque de divergence bien plus élevé qu'un déplacement contigu qui ne
  // change ni l'ordre ni le contenu des appels — les ~75 tests de generateCampaign() restent donc
  // valides sans modification (même séquence d'appels IA, mêmes index de mock.calls).
  private async finishCampaignFromApprovedConcept(
    ctx: AiCallContext,
    params: GenerateCampaignParams,
    input: {
      productAnalysis: AiGenerationResult;
      productProfile: ProductIntelligenceProfile | null;
      effectiveParams: GenerateCampaignParams;
      strategy: AiGenerationResult;
      creativeIntelligence: CreativeIntelligence;
      creativeConcept: CreativeConcept;
      creativeGateStatus: CreativeGateStatus;
      qualityTarget: QualityTarget;
      checkpointACost: number;
    },
  ) {
    const { productAnalysis, productProfile, effectiveParams, strategy, creativeIntelligence, creativeConcept, creativeGateStatus, qualityTarget, checkpointACost } = input;
    const hints = params.templateHints;
    const targetChannels = params.channels && params.channels.length > 0 ? params.channels : ['general'];
    const channelCountHint = params.channels && params.channels.length > 0 ? params.channels.length : 1;

    // Mission 4.3 (Goal-First Quality Architecture, Phase 3, Étape 4) — NarrativeBlueprint généré
    // ICI, juste après l'approbation du Creative Concept par le Creative Gate et AVANT tout script
    // de canal : devient la source UNIQUE dont narration ET script de chaque canal dérivent tous
    // les deux (remplace l'ancien mécanisme où la narration était reconstituée par regex depuis le
    // seul script TikTok — cf. buildNarrationFromBlueprint pour l'historique du bug corrigé).
    const narrativeBlueprint = await this.narrativeBlueprintService.generate(ctx, { creativeConcept, qualityTarget });

    // Voix off générée pour CHAQUE campagne, au même titre que la vidéo — une vidéo publicitaire
    // sans son n'est pas un format utilisable en l'état. Calculée ICI (déterministe, aucun appel
    // IA supplémentaire, cf. buildNarrationFromBlueprint) : ne dépend plus du script d'un canal
    // particulier (TikTok), donc démarrée AVANT la génération des scripts de canaux plutôt
    // qu'après — optimisation de latence supplémentaire, effet de bord de cette correction.
    const narrationText = buildNarrationFromBlueprint(narrativeBlueprint, effectiveParams.productDescription ?? '');
    // Démarré ICI plutôt qu'attendu juste avant utilisation (2026-08-19, optimisation latence) :
    // la voix off ne dépend d'AUCUN résultat de la chaîne vidéo qui suit (shot plan, plans
    // individuels, boucle de réparation) — seulement de narrationText, déjà prêt. La promesse
    // s'exécute donc EN PARALLÈLE de toute la génération vidéo (potentiellement plusieurs
    // minutes) au lieu de s'ajouter après coup ; récupérée plus bas, juste avant la
    // transcription qui en a réellement besoin.
    const narrationPromise = this.aiGateway.generateAudio(ctx, { prompt: narrationText }, 'openai');
    // Bug réel constaté en conditions réelles (2026-08-22, crédits OpenAI épuisés en cours de
    // campagne) : cette promesse n'est awaited que BEAUCOUP plus loin (juste avant la
    // transcription) — si une étape intermédiaire (Creative Gate/Storyboard Gate/PreFlight/génération
    // vidéo) échoue et lève AVANT ce point, le rejet éventuel de narrationPromise (ex. panne
    // fournisseur TTS) n'est jamais intercepté nulle part — Node 15+ termine tout le PROCESSUS
    // (pas seulement ce job) sur une "unhandled promise rejection", pas seulement ce job BullMQ.
    // .catch(() => {}) ICI marque le rejet comme géré pour Node SANS changer le comportement du
    // "await narrationPromise" réel plus bas, qui continue de rejeter normalement à cet endroit
    // (capté par le try/catch du worker BullMQ, comportement inchangé dans le cas nominal).
    narrationPromise.catch(() => undefined);

    // Parallélisé (2026-08-19, optimisation latence — campagnes réelles observées dépassant
    // 1h) : chaque canal est indépendant (aucun état partagé, aucune dépendance entre appels,
    // cf. generateChannelCopy) — les générer en série coûtait un temps réel proportionnel au
    // nombre de canaux (chacun ~15-30s), sans aucune raison de ne pas les exécuter en même
    // temps. Comportement inchangé, uniquement le temps d'exécution.
    const channelContent: Record<string, AiGenerationResult> = {};
    const channelResults = await Promise.all(
      targetChannels.map(async (channel) => [channel, await this.generateChannelCopy(ctx, channel, effectiveParams, strategy.content, hints, creativeConcept, narrativeBlueprint)] as const),
    );
    for (const [channel, result] of channelResults) {
      channelContent[channel] = result;
    }

    // Prompt réécrit (chantier "prompts précis, orientés objectif" du 2026-08-18) : l'ancienne
    // version ("Visuel publicitaire pour: {productDescription}") n'avait aucun lien avec
    // l'objectif de campagne ni la stratégie retenue, et ne donnait aucune consigne de
    // composition — le prompt le moins précis et le moins orienté objectif de tout le pipeline
    // (audit complet des 12 sites de prompt du backend). strategy.content est déjà disponible
    // à ce point (calculé ligne ~103), tronqué pour ne pas noyer le prompt sous un pavé de texte.
    // Ancrage sur la vraie photo produit (chantier "fidélité visuelle du visuel marketing",
    // 2026-08-18) : bug réel constaté en conditions réelles — sans ce routage, le visuel restait
    // une pure invention texte-vers-image (Flux, aucun ancrage), pouvant représenter un
    // produit/une marque différente de celle réellement injectée. Flux/Ideogram ignorent
    // silencieusement imageUrl (non supporté avec certitude) — seul OpenAI (édition ancrée,
    // cf. OpenAiProvider.generateImageFromReference) est routé en priorité quand une vraie photo
    // existe ; sans photo (texte seul), comportement inchangé (Flux, aucun ancrage possible).
    const hasReferencePhoto = Boolean(params.productImageUrl);
    const visual = await this.aiGateway.generateImage(
      ctx,
      {
        prompt: `Visuel publicitaire pour une campagne marketing.
Objectif de la campagne : ${params.objective}
Produit : ${effectiveParams.productDescription}
Angle stratégique retenu : ${this.truncate(strategy.content, 300)}
Consignes : image publicitaire professionnelle et photoréaliste, mise en scène fidèle à la description du produit, composition adaptée à une publicité (cadrage dégagé, espace utilisable pour du texte), qualité premium.`,
        imageUrl: params.productImageUrl,
      },
      // routage: ancrage prioritaire sur la qualité photoréaliste pure quand une vraie photo
      // existe. Repli Flux/Ideogram RETIRÉ le 2026-08-19 (cf. AiGatewayService.fallbackChains,
      // REPLICATE_API_TOKEN/IDEOGRAM_API_KEY vides dans cet environnement) — 'flux' demandait
      // systématiquement un aller-retour voué à échouer avant de retomber sur openai ; openai
      // demandé directement pour le cas sans photo tant que ces comptes ne sont pas configurés.
      'openai',
      PROMPT_VERSIONS.visual,
    );

    // Vidéo générée pour CHAQUE campagne, indépendamment des canaux sélectionnés — c'est la
    // promesse produit centrale, pas une option réservée à TikTok/Instagram. Un échec de
    // génération vidéo n'est pas masqué ici : il remonte comme une vraie erreur, gérée par
    // CampaignGenerationProcessor (statut FAILED + notification), jamais par un repli silencieux
    // vers un contenu factice.
    //
    // Architecture Shot Plan (2026-08-18) — remplace l'ancien mécanisme à prompt texte unique
    // (Veo devait simultanément comprendre le produit, inventer le scénario ET cadrer/filmer —
    // résultat générique, souvent quasi statique, ET jamais ancré sur la vraie photo produit,
    // cf. GoogleVeoProvider qui ignorait totalement params.imageUrl avant ce chantier) :
    // IMAGE → VISION ANALYSIS (déjà fait ci-dessus) → VISUAL DNA → VIDEO DIRECTOR → SHOT PLAN
    // → VEO → VIDEO ANALYZER → régénération (1 max) sur échec qualité. S'applique désormais à
    // TOUTES les campagnes, plus seulement quand le canal TikTok est sélectionné (l'ancien
    // parseVideoPlans() basé sur une regex du script TikTok est supprimé).
    //
    // Image de référence : la VRAIE photo uploadée en priorité (params.productImageUrl), pas le
    // visuel marketing généré par Flux (visual.content) — c'est le cœur du correctif de
    // fidélité. Repli sur visual.content uniquement pour une campagne sans photo (texte seul).
    const referenceImageUrl = params.productImageUrl ?? visual.content;
    const visualDnaResult = await this.visualDna.extract(ctx, referenceImageUrl, effectiveParams.productDescription);

    // Checkpoint B (P0.9) — scenesCount RÉEL désormais connu (creativeConcept.scenesCount).
    // Dégrade le budget de réparation de la Quality Loop plutôt que de bloquer une génération
    // dont le texte/l'image sont déjà payés ; ne bloque que si même le plancher
    // zéro-réparation dépasse le solde restant.
    const { maxRepairAttempts } = await this.costControl.checkBeforeVideoLoop(
      params.organizationId,
      channelCountHint,
      creativeConcept.scenesCount,
      VideoQualityLoopService.MAX_REPAIR_ATTEMPTS,
    );

    let shotPlan = await this.videoDirector.generateShotPlan(ctx, {
      visualDna: visualDnaResult,
      productDescription: effectiveParams.productDescription ?? '',
      objective: params.objective,
      campaignContext: strategy.content,
      narrativeBlueprint,
      creativeConcept,
    });

    // Diversité de plans (P0.4) — déterministe, aucun appel IA. UNE SEULE régénération possible
    // si un groupe de répétition couvre au moins la moitié des plans (cf. shot-diversity.ts).
    const repetitionWarnings: ShotRepetitionWarning[] = detectShotRepetition(shotPlan);
    if (shouldRegeneratePlan(repetitionWarnings, shotPlan.length)) {
      this.logger.warn(`Diversité de plans insuffisante détectée (${repetitionWarnings.length} groupe(s) répété(s)) — régénération unique du Shot Plan.`);
      shotPlan = await this.videoDirector.generateShotPlan(ctx, {
        visualDna: visualDnaResult,
        productDescription: effectiveParams.productDescription ?? '',
        objective: params.objective,
        campaignContext: strategy.content,
        narrativeBlueprint,
        creativeConcept,
        avoidRepetitionHint: buildAvoidRepetitionHint(repetitionWarnings),
      });
    }

    // Phase H — Storyboard Gate (chantier V2, spec Sections 46-53) : valide que le Shot Plan
    // traduit réellement le concept en séquence exploitable, AVANT tout generateVideo. Boucle
    // bornée à UNE régénération (même philosophie que la diversité de plans ci-dessus). L'élagage
    // de scènes (spec Sections 47-48, 56) applique un garde-fou déterministe (applySafePruning) —
    // jamais le LLM seul décide quoi supprimer.
    let expectedShotCount = creativeConcept.scenesCount;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 5b, Étape 8) — instructions RÉELLEMENT
    // compilées pour Veo (ShotExecutionCompiler, Phase 4), recalculées à chaque évaluation puisque
    // shotPlan peut avoir changé entre-temps : le Storyboard Gate juge ce que le fournisseur vidéo
    // recevra, pas seulement le Shot Plan JSON brut.
    let executionInstructions = shotPlan.map((shot) => ({ sceneId: shot.sceneId, prompt: compileShotExecutionInstruction(shot, { creativeConcept, narrativeBlueprint }).prompt }));
    let storyboardGate = await this.storyboardGateService.evaluate(ctx, { creativeConcept, shotPlan, qualityTarget, narrativeBlueprint, executionInstructions, productProfile });
    if (storyboardGate.status !== 'APPROVED') {
      this.logger.warn(`Storyboard Gate ${storyboardGate.status} (score ${storyboardGate.score}/100) — régénération unique du Shot Plan avec le retour du jugement.`);
      shotPlan = await this.videoDirector.generateShotPlan(ctx, {
        visualDna: visualDnaResult,
        productDescription: effectiveParams.productDescription ?? '',
        objective: params.objective,
        campaignContext: strategy.content,
        narrativeBlueprint,
        creativeConcept,
        storyboardGateFeedback: [...storyboardGate.blockingDefects, ...storyboardGate.requiredChanges].filter(Boolean).join(' '),
      });
      expectedShotCount = shotPlan.length;
      executionInstructions = shotPlan.map((shot) => ({ sceneId: shot.sceneId, prompt: compileShotExecutionInstruction(shot, { creativeConcept, narrativeBlueprint }).prompt }));
      storyboardGate = await this.storyboardGateService.evaluate(ctx, { creativeConcept, shotPlan, qualityTarget, narrativeBlueprint, executionInstructions, productProfile });
      if (storyboardGate.status !== 'APPROVED') {
        throw new Error(
          `QUALITY_GATE: storyboard insuffisant après révision (score ${storyboardGate.score}/100) — ${storyboardGate.blockingDefects.join('; ') || 'aucun détail disponible'}.` +
            (storyboardGate.rootCauseLevel ? ` Cause racine : ${storyboardGate.rootCauseLevel}${!['SHOT', 'NARRATIVE'].includes(storyboardGate.rootCauseLevel) ? ' (hors du périmètre corrigible par une simple régénération du plan de tournage).' : '.'}` : ''),
        );
      }
    }
    if (storyboardGate.scenesToRemove.length > 0) {
      shotPlan = applySafePruning(shotPlan, storyboardGate.scenesToRemove);
      expectedShotCount = shotPlan.length; // élagage sanctionné — le compte attendu suit le plan élagué, pas le concept d'origine
    }

    // Phase E (chantier V2, spec Section 23-24) — validation structurelle DÉTERMINISTE, coût
    // zéro, juste avant la boucle de génération vidéo (150 crédits/plan). Ne jamais découvrir un
    // plan brisé (mauvais nombre de scènes, champ requis manquant, aucun CTA, durée aberrante)
    // après un cycle de génération de plusieurs minutes — le détecter maintenant, gratuitement.
    const shotPlanValidation = validateShotPlan(shotPlan, { shotCount: expectedShotCount });
    if (!shotPlanValidation.passed) {
      throw new Error(`QUALITY_GATE: le plan de tournage généré est structurellement invalide (${shotPlanValidation.reasons.join('; ')}) — aucune vidéo n'a été générée pour éviter de gaspiller des crédits sur un plan brisé.`);
    }
    // Audit forensique Mission 4.2 (P0-2) : non-bloquant mais jamais silencieux — un plan
    // structurellement valide peut malgré tout contenir un gabarit générique de repli.
    if (shotPlanValidation.warnings.length > 0) {
      this.logger.warn(`Plan de tournage : ${shotPlanValidation.warnings.join(' ; ')}`);
    }

    // Mission 4.3 (Goal-First Quality Architecture, Phase 5, Étape 7) — dernier point de contrôle
    // DÉTERMINISTE (aucun appel IA) avant la boucle de génération vidéo (150 crédits/plan) :
    // Visual DNA/qualityAlignment/beats narratifs/liens shot-beat, jusqu'ici calculés mais jamais
    // vérifiés par rien avant Veo.
    const preFlight = evaluatePreFlightQuality({ visualDna: visualDnaResult, creativeConcept, narrativeBlueprint, shotPlan, shotPlanValidation, narrationText, productConflicts: productConflictsOf(productProfile) });
    if (!preFlight.ready) {
      throw new Error(`QUALITY_GATE: pré-vol qualité échoué — ${preFlight.blockingReasons.join('; ')}. Aucune vidéo n'a été générée pour éviter de gaspiller des crédits sur un plan non conforme.`);
    }

    const { video, videoClips, perShotQuality } = await this.generateShotPlanVideoOrDegrade(ctx, shotPlan, referenceImageUrl, visualDnaResult, params.organizationId, { creativeConcept, narrativeBlueprint });

    // Mission 4.3 (Goal-First Quality Architecture, Phase 4, Étape 5) — beats[].shotIds peuplé
    // maintenant que le Shot Plan final (post storyboard-gate/élagage) est connu ; remplace la
    // version brute exposée plus bas sur le résultat.
    const enrichedNarrativeBlueprint = linkBeatsToShots(shotPlan, narrativeBlueprint);

    const narration = await narrationPromise;

    // Sous-titres : transcrit l'audio RÉELLEMENT généré (pas le texte source) pour obtenir le
    // timing effectif de la parole — cf. OpenAiProvider.transcribeAudio(). Dégradation, jamais
    // un échec de campagne : perdre les sous-titres n'est pas perdre la vidéo (VideoAssemblyService
    // incruste seulement si un transcript est disponible). Échoue aussi silencieusement en mode
    // mock, où narration.content n'est qu'une URL factice (MockProvider.generateAudio), pas un
    // vrai data URI audio à décoder.
    const transcript = await this.transcribeNarrationOrDegrade(ctx, narration.content);

    return {
      productAnalysis, strategy, channelContent, visual, video, narration, transcript,
      // Creative Intelligence Engine & Video Quality Loop (2026-08-18) — consommés par
      // CampaignGenerationProcessor (VideoQualityLoopService, sécurité factuelle élargie,
      // CreativeGenerationTraceService, cf. plan). narrationText/visualDnaResult/referenceImageUrl
      // n'étaient auparavant que des variables internes — exposés désormais car
      // VideoQualityLoopService en a besoin pour un AUDIO_REGEN/CLIP_REGEN ciblé.
      videoClips, shotPlan, perShotQuality, creativeIntelligence, creativeConcept, productProfile, maxRepairAttempts,
      narrationText, visualDnaResult, referenceImageUrl,
      // Mission 4.3 (Goal-First Quality Architecture, Phase 3/4) — exposé pour que
      // CampaignGenerationProcessor.tryEscalate le transmette à regenerateShotPlanAndVideo lors
      // d'une escalade STORYBOARD (le concept, donc le blueprint, ne change pas à ce niveau).
      // Enrichi depuis la Phase 4 (beats[].shotIds reflète le Shot Plan final).
      narrativeBlueprint: enrichedNarrativeBlueprint,
      // Phase P (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — exposé pour que
      // CampaignGenerationProcessor.finalizeVideoAsset puisse appeler regenerateShotPlanAndVideo/
      // regenerateConceptStoryboardAndVideo lors d'une escalade, avec le MÊME objective/
      // productDescription effectif que la génération initiale (jamais recalculé/redeviné).
      effectiveParams,
      // Phase A (chantier V2, 2026-08-19) — thread la vraie estimation Checkpoint A jusqu'à
      // CreativeGenerationTraceService, qui la persistait auparavant en dur à 0 (cf. commentaire
      // sur CostControlService.assertBeforeGeneration).
      checkpointACost,
      // Phase J (chantier V2, 2026-08-19) — statuts finaux des portes amont, nécessaires au
      // Final Advertising Gate (câblage final, cf. campaign-generation.processor.ts) pour
      // vérifier qu'aucune porte n'a été contournée avant la livraison.
      creativeGateStatus,
      storyboardGateStatus: storyboardGate.status,
      // Mission 4.3 (Goal-First Quality Architecture, Phase 5b/6b) — résultat COMPLET (pas
      // seulement le statut) du dernier Storyboard Gate/PreProductionQualityJudge franchi pour
      // cette campagne : criterionScores/blockingDefects/risks/requiredChanges/rootCauseLevel,
      // exposé pour que CampaignGenerationProcessor le persiste sur GoalFirstTrace, même quand la
      // campagne aboutit sans jamais avoir besoin d'escalade.
      storyboardGateResult: storyboardGate,
      // Mission 4.3 (Goal-First Quality Architecture, Phase 1) — exposé pour que
      // CampaignGenerationProcessor thread la même instance jusqu'à
      // CreativeGenerationTraceService.upsertTrace (persistance dans la trace de génération).
      qualityTarget,
    };
  }

  // Mission 4.3 (Goal-First Quality Architecture, Phase 7, Étape 19) — réutilisation CIBLÉE pour
  // CampaignsService.regenerate() (l'endpoint utilisateur manuel, distinct des escalades internes
  // Phase P) : appelée UNIQUEMENT quand CampaignsService a déjà confirmé (a) que la photo/
  // description/objectif/canaux sont IDENTIQUES à la dernière tentative, ET (b) qu'une
  // CreativeGenerationTrace existe déjà pour cette campagne — ce qui garantit structurellement que
  // son creativeConcept a déjà franchi le Creative Gate avec succès (seul chemin qui écrit une
  // trace, cf. CampaignGenerationProcessor.finalizeVideoAsset). Saute donc Creative
  // Intelligence + Creative Concept + Creative Gate (le trio le plus coûteux/itératif de tout le
  // pipeline — jusqu'à 2 évaluations de gate en plus de la génération elle-même) — tout le reste
  // (stratégie, NarrativeBlueprint, narration, copie par canal, visuel, Visual DNA, Shot Plan,
  // Storyboard Gate, vidéo) est régénéré à neuf via finishCampaignFromApprovedConcept, exactement
  // comme une génération normale : reprendre le concept ne veut pas dire reprendre l'exécution.
  async regenerateFromApprovedConcept(
    params: GenerateCampaignParams & {
      creativeIntelligence: CreativeIntelligence;
      creativeConcept: CreativeConcept;
      qualityTarget: QualityTarget;
    },
  ) {
    const ctx: AiCallContext = { organizationId: params.organizationId, campaignId: params.campaignId, purpose: 'campaign_generation' };
    const hints = params.templateHints;
    const analysisAngleHint = hints?.analysisAngle ? `\nAngle d'analyse à privilégier : ${hints.analysisAngle}` : '';
    const personaHint = hints?.personaArchetype ? `\nArchétype de persona à cibler : ${hints.personaArchetype}` : '';
    const targetChannels = params.channels && params.channels.length > 0 ? params.channels : ['general'];
    const channelCountHint = params.channels && params.channels.length > 0 ? params.channels.length : 1;

    // Même garde-fou budgétaire qu'une génération normale (generateCampaign()) — une réutilisation
    // du concept n'exempte jamais des vérifications de crédits/quota, seulement du TRAVAIL de
    // reconstruction du concept lui-même.
    const checkpointACost = await this.costControl.assertBeforeGeneration(params.organizationId, channelCountHint, VideoQualityLoopService.MAX_REPAIR_ATTEMPTS);

    const globalBrandContext = await this.brandContext.build({ organizationId: params.organizationId, persona: hints?.personaArchetype });
    const brandContextBlock = globalBrandContext.text ? `\n\nContexte de marque :\n${globalBrandContext.text}` : '';

    // productAnalysis/productProfile régénérés (pas persistés sur CreativeGenerationTrace) — coût
    // marginal (2 appels, dont 1 en cache si la même photo est réutilisée, cf.
    // ProductIntelligenceService) largement inférieur à celui du trio Creative
    // Intelligence/Concept/Gate qu'on évite précisément grâce à cette méthode.
    const [productAnalysis, productProfile] = await Promise.all([
      params.productImageUrl
        ? this.analyzeProductImage(ctx, params.productImageUrl, params.productDescription, analysisAngleHint)
        : this.aiGateway.generateText(
            ctx,
            { prompt: `Analyse ce produit et identifie ses forces, faiblesses et USP: ${params.productDescription}${analysisAngleHint}` },
            'openai',
            PROMPT_VERSIONS.productAnalysis,
          ),
      params.productImageUrl
        // Mission 4.4 (Product URL Intelligence) — productUrl n'active la fusion que lorsqu'une
        // photo est ÉGALEMENT fournie : le cache de profil reste basé sur le hash de l'image
        // (limite connue, documentée — une soumission URL seule sans photo n'est pas encore un
        // chemin supporté, cf. rapport final).
        ? this.productIntelligence.buildProfile(ctx, params.organizationId, params.productImageUrl, params.productDescription, params.productUrl)
        : Promise.resolve(null as ProductIntelligenceProfile | null),
    ]);
    const groundedContextBlock = productProfile ? `\n\n${renderGroundedContext(productProfile)}` : '';

    // Stratégie régénérée à neuf (jamais persistée sur la trace) — nécessaire à la copie par canal
    // (generateChannelCopy en a besoin), même si Creative Intelligence/Concept ne le sont pas.
    const strategy = await this.aiGateway.generateText(
      ctx,
      {
        prompt: `À partir de cette analyse produit, propose une stratégie marketing SMART pour l'objectif "${params.objective}".
Contrainte impérative : cette stratégie doit être intégralement réalisable avec UNIQUEMENT ce que campaign-ai produit réellement pour cette campagne — un texte publicitaire par canal parmi [${targetChannels.join(', ')}], un visuel, et une courte vidéo. Ne propose JAMAIS de tactiques hors de ce périmètre (emails, SMS, landing page dédiée, retargeting publicitaire, pop-up, etc.) — la stratégie doit se limiter à ce qui sera effectivement livré sur ces canaux.
${productAnalysis.content}${personaHint}${brandContextBlock}${groundedContextBlock}

Termine ta réponse par un bloc structuré, strictement basé sur l'analyse produit ci-dessus (jamais une caractéristique inventée), au format :

AUDIENCE : <cible en une phrase>
TON : <ton éditorial à adopter>
MESSAGE CLÉ : <la promesse centrale, en une phrase>
MANDATORIES : <affirmations vérifiables sur le produit UNIQUEMENT — une par ligne commençant par "-" — ne jamais inclure de caractéristique (écologique, biodégradable, hypoallergénique, etc.) non confirmée explicitement par l'analyse produit ci-dessus>`,
      },
      'anthropic',
      PROMPT_VERSIONS.strategy,
    );

    const effectiveParams: GenerateCampaignParams = {
      ...params,
      productDescription: params.productDescription?.trim() || productAnalysis.content,
    };

    return this.finishCampaignFromApprovedConcept(ctx, params, {
      productAnalysis, productProfile, effectiveParams, strategy,
      creativeIntelligence: params.creativeIntelligence,
      creativeConcept: params.creativeConcept,
      creativeGateStatus: 'APPROVED',
      qualityTarget: params.qualityTarget,
      checkpointACost,
    });
  }

  // Phase P — Escalade automatique EXÉCUTÉE (chantier "Optimisation du pipeline vidéo — V2.1",
  // 2026-08-19, spec Section 16-19). Extraction QUASI-LITTÉRALE du bloc "Shot Plan -> Storyboard
  // Gate -> validation -> vidéo" déjà présent dans generateCampaign() (cf. lignes ~353-416
  // ci-dessus) — délibérément DUPLIQUÉE plutôt que factorisée par un appel partagé : réécrire
  // generateCampaign() pour appeler cette méthode aurait touché son corps et risqué de régresser
  // les ~30 tests qui assertent déjà sa forme de retour exacte (cf. plan, décision de conception
  // justifiée par l'audit). Appelée par CampaignGenerationProcessor.finalizeVideoAsset quand le
  // Video Quality Loop s'épuise et que classifyRootCause (root-cause.ts) désigne le STORYBOARD.
  async regenerateShotPlanAndVideo(
    ctx: AiCallContext,
    params: {
      creativeConcept: CreativeConcept;
      visualDnaResult: VisualDna;
      referenceImageUrl: string;
      effectiveParams: GenerateCampaignParams;
      strategy: string; // campaignContext — strategy.content dans generateCampaign()
      // Mission 4.3 (Goal-First Quality Architecture, Phase 3) — remplace l'ancien narrationText
      // (texte plat) : seul consommateur était le narrationHint transmis à generateShotPlan,
      // désormais narrativeBlueprint directement.
      narrativeBlueprint: NarrativeBlueprint;
      organizationId: string;
      // Défauts du dernier jugement Video Judge qui a motivé CETTE escalade — seedé directement
      // dans storyboardGateFeedback du 1er appel à generateShotPlan (jamais un aller à l'aveugle
      // vers le même plan déjà jugé insuffisant).
      escalationFeedback?: string;
      // Mission 4.3 (Goal-First Quality Architecture, Phase 1) — MÊME instance que celle créée en
      // tête de generateCampaign(), jamais recréée ici (une escalade ne doit jamais juger contre
      // une cible différente de la génération initiale).
      qualityTarget: QualityTarget;
      // Mission 4.3 (Goal-First Quality Architecture, Phase 5b) — nécessaire à l'appel du
      // Storyboard Gate étendu (groundedContextBlock) ; les deux appelants (tryEscalate côté
      // STORYBOARD, regenerateConceptStoryboardAndVideo côté CONCEPT) l'ont déjà en portée.
      productProfile: ProductIntelligenceProfile | null;
    },
  ): Promise<{
    shotPlan: ShotPlan;
    video: AiGenerationResult | null;
    videoClips: VideoClip[];
    perShotQuality: Map<string, ShotQualityResult>;
    storyboardGateStatus: StoryboardGateStatus;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 6b) — même raisonnement que sur
    // generateCampaign() : résultat complet du dernier Storyboard Gate franchi lors de CETTE
    // escalade, pour que GoalFirstTrace reste renseigné même après une escalade STORYBOARD.
    storyboardGateResult: StoryboardGateResult;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 4) — enrichi (beats[].shotIds
    // reflétant CE Shot Plan régénéré), cf. linkBeatsToShots plus bas.
    narrativeBlueprint: NarrativeBlueprint;
  }> {
    const { creativeConcept, visualDnaResult, referenceImageUrl, effectiveParams, strategy, narrativeBlueprint, organizationId, escalationFeedback, qualityTarget, productProfile } = params;

    let shotPlan = await this.videoDirector.generateShotPlan(ctx, {
      visualDna: visualDnaResult,
      productDescription: effectiveParams.productDescription ?? '',
      objective: effectiveParams.objective,
      campaignContext: strategy,
      narrativeBlueprint,
      creativeConcept,
      storyboardGateFeedback: escalationFeedback,
    });

    const repetitionWarnings: ShotRepetitionWarning[] = detectShotRepetition(shotPlan);
    if (shouldRegeneratePlan(repetitionWarnings, shotPlan.length)) {
      this.logger.warn(`Escalade storyboard : diversité de plans insuffisante détectée (${repetitionWarnings.length} groupe(s) répété(s)) — régénération unique du Shot Plan.`);
      shotPlan = await this.videoDirector.generateShotPlan(ctx, {
        visualDna: visualDnaResult,
        productDescription: effectiveParams.productDescription ?? '',
        objective: effectiveParams.objective,
        campaignContext: strategy,
        narrativeBlueprint,
        creativeConcept,
        avoidRepetitionHint: buildAvoidRepetitionHint(repetitionWarnings),
      });
    }

    let expectedShotCount = creativeConcept.scenesCount;
    let executionInstructions = shotPlan.map((shot) => ({ sceneId: shot.sceneId, prompt: compileShotExecutionInstruction(shot, { creativeConcept, narrativeBlueprint }).prompt }));
    let storyboardGate = await this.storyboardGateService.evaluate(ctx, { creativeConcept, shotPlan, qualityTarget, narrativeBlueprint, executionInstructions, productProfile });
    if (storyboardGate.status !== 'APPROVED') {
      this.logger.warn(`Escalade storyboard : Storyboard Gate ${storyboardGate.status} (score ${storyboardGate.score}/100) — régénération unique du Shot Plan avec le retour du jugement.`);
      shotPlan = await this.videoDirector.generateShotPlan(ctx, {
        visualDna: visualDnaResult,
        productDescription: effectiveParams.productDescription ?? '',
        objective: effectiveParams.objective,
        campaignContext: strategy,
        narrativeBlueprint,
        creativeConcept,
        storyboardGateFeedback: [...storyboardGate.blockingDefects, ...storyboardGate.requiredChanges].filter(Boolean).join(' '),
      });
      expectedShotCount = shotPlan.length;
      executionInstructions = shotPlan.map((shot) => ({ sceneId: shot.sceneId, prompt: compileShotExecutionInstruction(shot, { creativeConcept, narrativeBlueprint }).prompt }));
      storyboardGate = await this.storyboardGateService.evaluate(ctx, { creativeConcept, shotPlan, qualityTarget, narrativeBlueprint, executionInstructions, productProfile });
      if (storyboardGate.status !== 'APPROVED') {
        throw new Error(
          `QUALITY_GATE: storyboard insuffisant après révision (escalade) (score ${storyboardGate.score}/100) — ${storyboardGate.blockingDefects.join('; ') || 'aucun détail disponible'}.` +
            (storyboardGate.rootCauseLevel ? ` Cause racine : ${storyboardGate.rootCauseLevel}${!['SHOT', 'NARRATIVE'].includes(storyboardGate.rootCauseLevel) ? ' (hors du périmètre corrigible par une simple régénération du plan de tournage).' : '.'}` : ''),
        );
      }
    }
    if (storyboardGate.scenesToRemove.length > 0) {
      shotPlan = applySafePruning(shotPlan, storyboardGate.scenesToRemove);
      expectedShotCount = shotPlan.length;
    }

    const shotPlanValidation = validateShotPlan(shotPlan, { shotCount: expectedShotCount });
    if (!shotPlanValidation.passed) {
      throw new Error(`QUALITY_GATE: le plan de tournage régénéré (escalade) est structurellement invalide (${shotPlanValidation.reasons.join('; ')}) — aucune vidéo n'a été générée pour éviter de gaspiller des crédits sur un plan brisé.`);
    }
    if (shotPlanValidation.warnings.length > 0) {
      this.logger.warn(`Plan de tournage (escalade) : ${shotPlanValidation.warnings.join(' ; ')}`);
    }

    // Mission 4.3 (Goal-First Quality Architecture, Phase 5, Étape 7) — même contrôle qu'en 1ère
    // génération. narrationText n'est pas un paramètre de cette méthode (Phase 3 l'a remplacé par
    // narrativeBlueprint) — recalculé ici, déterministe, aucun nouvel appel IA.
    const preFlight = evaluatePreFlightQuality({
      visualDna: visualDnaResult,
      creativeConcept,
      narrativeBlueprint,
      shotPlan,
      shotPlanValidation,
      narrationText: buildNarrationFromBlueprint(narrativeBlueprint, effectiveParams.productDescription ?? ''),
      productConflicts: productConflictsOf(productProfile),
    });
    if (!preFlight.ready) {
      throw new Error(`QUALITY_GATE: pré-vol qualité échoué (escalade) — ${preFlight.blockingReasons.join('; ')}. Aucune vidéo n'a été générée pour éviter de gaspiller des crédits sur un plan non conforme.`);
    }

    const { video, videoClips, perShotQuality } = await this.generateShotPlanVideoOrDegrade(ctx, shotPlan, referenceImageUrl, visualDnaResult, organizationId, { creativeConcept, narrativeBlueprint });

    return { shotPlan, video, videoClips, perShotQuality, storyboardGateStatus: storyboardGate.status, storyboardGateResult: storyboardGate, narrativeBlueprint: linkBeatsToShots(shotPlan, narrativeBlueprint) };
  }

  // Phase P — Escalade au niveau CONCEPT : réutilise creativeConceptService.generate(gateFeedback)
  // + creativeGateService.evaluate (déjà existants depuis la Phase G, déjà testés) puis compose
  // regenerateShotPlanAndVideo ci-dessus — nouveau uniquement dans l'ASSEMBLAGE, pas dans la
  // logique. La narration est RECALCULÉE à partir du nouveau concept (hook/message/CTA
  // potentiellement différents) — jamais celle de l'ancien concept abandonné, sinon le Video
  // Quality Loop rejugerait une vidéo dont la voix off ne correspond plus au script.
  async regenerateConceptStoryboardAndVideo(
    ctx: AiCallContext,
    params: {
      creativeIntelligence: CreativeIntelligence;
      visualDnaResult: VisualDna;
      referenceImageUrl: string;
      effectiveParams: GenerateCampaignParams;
      strategy: string;
      organizationId: string;
      productProfile: ProductIntelligenceProfile | null;
      // Défauts du dernier jugement Video Judge (et/ou de l'échec de l'escalade storyboard
      // précédente) qui motivent CETTE escalade — seedé dans creativeConceptService.generate.
      escalationFeedback: string;
      // Mission 4.3 (Goal-First Quality Architecture, Phase 1) — MÊME instance que celle créée en
      // tête de generateCampaign(), jamais recréée ici.
      qualityTarget: QualityTarget;
    },
  ): Promise<{
    creativeConcept: CreativeConcept;
    shotPlan: ShotPlan;
    video: AiGenerationResult | null;
    videoClips: VideoClip[];
    perShotQuality: Map<string, ShotQualityResult>;
    creativeGateStatus: CreativeGateStatus;
    storyboardGateStatus: StoryboardGateStatus;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 6b) — cf. regenerateShotPlanAndVideo.
    storyboardGateResult: StoryboardGateResult;
    narrationText: string;
    narrationDataUri: string;
    transcript: TranscriptSegment[] | null;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 4) — enrichi (beats[].shotIds
    // reflétant le Shot Plan régénéré sur ce nouveau concept).
    narrativeBlueprint: NarrativeBlueprint;
  }> {
    const { creativeIntelligence, visualDnaResult, referenceImageUrl, effectiveParams, strategy, organizationId, productProfile, escalationFeedback, qualityTarget } = params;

    let creativeConcept = await this.creativeConceptService.generate(ctx, { creativeIntelligence, gateFeedback: escalationFeedback, qualityTarget, productProfile });
    let creativeGate = await this.creativeGateService.evaluate(ctx, { creativeIntelligence, creativeConcept, objective: effectiveParams.objective, productProfile, qualityTarget });
    if (creativeGate.status !== 'APPROVED') {
      this.logger.warn(`Escalade concept : Creative Gate ${creativeGate.status} (score ${creativeGate.score}/100) — régénération unique du concept avec le retour du jugement.`);
      const gateFeedback = [...creativeGate.faiblesses, creativeGate.recommandation].filter(Boolean).join(' ');
      creativeConcept = await this.creativeConceptService.generate(ctx, { creativeIntelligence, gateFeedback, qualityTarget, productProfile });
      creativeGate = await this.creativeGateService.evaluate(ctx, { creativeIntelligence, creativeConcept, objective: effectiveParams.objective, productProfile, qualityTarget });
      if (creativeGate.status !== 'APPROVED') {
        throw new Error(
          `QUALITY_GATE: concept publicitaire insuffisant après révision (escalade) (statut ${creativeGate.status}, score ${creativeGate.score}/100) — ${[...creativeGate.causesDeRejet, ...creativeGate.faiblesses].join('; ') || 'aucun détail disponible'}.`,
        );
      }
    }

    // Mission 4.3 (Goal-First Quality Architecture, Phase 3) — un nouveau concept invalide
    // l'ancien NarrativeBlueprint (il racontait l'ancienne idée) : régénéré ici avant toute
    // narration/Shot Plan, même discipline qu'en 1ère génération (generateCampaign()).
    const narrativeBlueprint = await this.narrativeBlueprintService.generate(ctx, { creativeConcept, qualityTarget });
    const narrationText = buildNarrationFromBlueprint(narrativeBlueprint, effectiveParams.productDescription ?? '');
    const narration = await this.aiGateway.generateAudio(ctx, { prompt: narrationText }, 'openai');
    const transcript = await this.transcribeNarrationOrDegrade(ctx, narration.content);

    const {
      shotPlan, video, videoClips, perShotQuality, storyboardGateStatus, storyboardGateResult,
      narrativeBlueprint: enrichedNarrativeBlueprint,
    } = await this.regenerateShotPlanAndVideo(ctx, {
      creativeConcept,
      visualDnaResult,
      referenceImageUrl,
      effectiveParams,
      strategy,
      narrativeBlueprint,
      qualityTarget,
      organizationId,
      productProfile,
    });

    return {
      creativeConcept, shotPlan, video, videoClips, perShotQuality,
      creativeGateStatus: creativeGate.status, storyboardGateStatus, storyboardGateResult,
      narrationText, narrationDataUri: narration.content, transcript,
      narrativeBlueprint: enrichedNarrativeBlueprint,
    };
  }

  private async transcribeNarrationOrDegrade(ctx: AiCallContext, narrationContent: string): Promise<TranscriptSegment[] | null> {
    const match = /^data:(.+?);base64,(.+)$/.exec(narrationContent);
    if (!match) return null;

    try {
      const [, mimeType, base64] = match;
      const audioBuffer = Buffer.from(base64, 'base64');
      const result = await this.aiGateway.transcribeAudio(ctx, { audioBuffer, mimeType }, 'openai');
      return parseAiJson<TranscriptSegment[]>(result.content);
    } catch (error) {
      this.logger.warn(`Transcription de la narration échouée — vidéo générée sans sous-titres : ${error}`);
      return null;
    }
  }

  // Correction de l'audit du 2026-08-13 : rendre la vidéo obligatoire pour CHAQUE campagne
  // entre directement en conflit avec les plafonds dédiés de l'essai gratuit (cf.
  // plan-catalog.ts) — sans garde-fou, l'exception remonterait jusqu'au processor qui
  // marquerait la campagne entière FAILED. Une campagne sans vidéo À CAUSE D'UN QUOTA MÉTIER
  // ATTEINT (pas d'une panne technique) doit dégrader proprement — se terminer normalement
  // avec le reste du contenu, la vidéo simplement omise ou tronquée — plutôt que transformer un
  // plafond commercial attendu en incident technique visible. Distinction stricte avec toute
  // autre erreur (panne fournisseur, budget dépassé, credits épuisés) : celles-ci continuent de
  // faire échouer la campagne (cf. CampaignGenerationProcessor).
  //
  // Génère UN clip par plan du Shot Plan (architecture 2026-08-18 — cf. VideoDirectorService),
  // vérifie chaque clip via VideoAnalyzerService (mouvement réel détecté + fidélité visuelle au
  // produit), régénère AU PLUS UNE FOIS un plan dont la qualité est insuffisante puis retient le
  // meilleur des deux essais (jamais 0 clip pour un plan si au moins 1 essai a réussi), et
  // enchaîne tous les clips retenus en une seule vidéo dynamique via
  // VideoFinalizationService.concatenateClips(). S'applique à TOUS les plans de TOUTES les
  // campagnes désormais, plus seulement quand un script TikTok était disponible.
  //
  // Chaque essai (génération initiale ET régénération) passe par le MÊME garde-fou quota que
  // l'ancien mécanisme (assertVideoQuotaAvailable, cf. AiGatewayService). Depuis la correction
  // du 2026-08-18 (cf. commentaire sur PlanDefinition.maxVideoShotsPerCampaign), ce garde-fou
  // borne le nombre de CLIPS DANS cette campagne (maxVideoShotsPerCampaign, dimensionné au pire
  // cas — shotCount × 2 essais — pour ne jamais interrompre un storyboard légitime) et,
  // séparément, le nombre de CAMPAGNES DISTINCTES ayant déjà droit à une vidéo (maxVideos) —
  // plus le bug où le 1er clip de CETTE campagne consommait déjà tout le quota disponible pour
  // ses propres plans suivants. Le pool de crédits (aiCreditsIncluded) reste, en pratique, la
  // limite la plus fréquemment atteinte sur l'essai gratuit.
  // Retourne désormais aussi (P0.5/P0.7, chantier "Creative Intelligence Engine & Video
  // Quality Loop", 2026-08-18) : videoClips (chaque clip INDIVIDUEL avant concaténation, requis
  // par VideoQualityLoopService pour une réparation CLIP_REGEN ciblée sur UN SEUL plan) et
  // perShotQuality (ShotQualityResult par sceneId, requis par VideoJudgeService pour agréger
  // productConsistency/motionDynamism sans nouvel appel IA). Comportement de `video` inchangé.
  // Phase M (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19, spec Section 9-11) —
  // génération PARALLÈLE des scènes indépendantes (aucune infrastructure BullMQ multi-job dans
  // ce repo, cf. plan : `Promise.allSettled` À L'INTÉRIEUR du job déjà en cours, jamais une
  // nouvelle architecture de queue). Le comportement observable reste IDENTIQUE à l'ancienne
  // boucle séquentielle (mêmes 2 essais par plan, même sélection du meilleur, même dégradation
  // propre sur quota épuisé, même propagation d'erreur fatale) — seul le MOMENT où les appels
  // `generateVideo` partent change.
  private async generateShotPlanVideoOrDegrade(
    ctx: AiCallContext,
    shotPlan: ShotPlan,
    referenceImageUrl: string,
    visualDnaResult: VisualDna,
    organizationId: string,
    // Mission 4.3 (Goal-First Quality Architecture, Phase 4) — thread jusqu'à
    // ShotExecutionCompiler via generateSingleShot/serializeShotToPrompt/repairShotPrompt.
    context: ShotExecutionContext,
  ): Promise<{ video: AiGenerationResult | null; videoClips: VideoClip[]; perShotQuality: Map<string, ShotQualityResult> }> {
    // Phase I (chantier V2, spec Section 57) — génère les scènes les plus importantes pour le
    // message publicitaire EN PREMIER (hook, démonstration produit, CTA/payoff), pas dans l'ordre
    // arbitraire du tableau — préservé à l'identique, la priorité détermine maintenant aussi
    // quelles scènes sont lancées en premier DANS une vague parallèle, et lesquelles sont
    // sacrifiées en premier si le quota ne couvre pas la vague entière (cf. plus bas).
    const prioritizedShotPlan = sortByGenerationPriority(shotPlan);
    const waves = this.groupShotsIntoDependencyWaves(prioritizedShotPlan);

    // Une SEULE lecture fixe la taille du lot pour tout ce batch — élimine le TOCTOU (cf.
    // EntitlementsService.getRemainingVideoShotSlots) sans transaction distribuée : on ne compte
    // plus sur N vérifications concurrentes indépendantes lisant le même compte avant qu'aucune
    // n'ait persisté sa réussite. `null` = illimité (plan sans plafond par campagne).
    const remainingSlots = ctx.campaignId ? await this.entitlements.getRemainingVideoShotSlots(organizationId, ctx.campaignId) : null;
    let slotsRemaining = remainingSlots ?? Infinity;

    // Clé = l'objet Shot lui-même (identité de référence), jamais sceneId : sceneId est
    // TOUJOURS unique en production (assigné déterministiquement, cf. commentaire sur
    // Shot.sceneId), mais une Map par référence reste correcte même dans les cas limites où ce
    // ne serait pas le cas, sans dépendre de cette garantie externe.
    const clipByShot = new Map<Shot, AiGenerationResult>();
    const qualityByShot = new Map<Shot, ShotQualityResult>();
    let quotaExhausted = false;
    // Dernière erreur technique réelle rencontrée (jamais une dégradation quota, qui ne pousse
    // jamais ici) — préservée telle quelle (même instance) pour ne pas masquer son type exact
    // (ex. PlanLimitExceededException) dont dépend la classification en aval
    // (campaign-generation.processor.ts::isDefinitiveFailure).
    let lastFatalError: unknown = null;

    for (const wave of waves) {
      if (slotsRemaining <= 0) {
        this.logger.warn(`Quota vidéo épuisé avant la vague suivante (${wave.length} plan(s) jamais lancés) — campagne poursuivie avec ce qui a été généré.`);
        quotaExhausted = true;
        break;
      }

      const toLaunch = wave.slice(0, Math.min(wave.length, slotsRemaining));
      if (toLaunch.length < wave.length) {
        this.logger.warn(`Quota vidéo insuffisant pour lancer toute la vague (${toLaunch.length}/${wave.length} plan(s) lancés, dans l'ordre de priorité) — les autres ne sont jamais appelés.`);
      }

      const settled = await Promise.allSettled(
        toLaunch.map((shot) => this.generateSingleShot(ctx, shot, referenceImageUrl, visualDnaResult, organizationId, shotPlan.length, context)),
      );

      // Audit forensic (campagne réelle 1c41d0d0-7b13-4530-9238-244188fad73a, 2026-08-20) — un
      // échec technique isolé sur UN plan (pas le quota) ne doit JAMAIS jeter les plans SIBLINGS
      // déjà réussis dans la même vague parallèle (preuve réelle : 3 plans réussis à la même
      // milliseconde qu'un 4e en échec, $0,90 de clips valides jetés par l'ancien comportement).
      // Les plans en échec sont collectés, JAMAIS abandonnés immédiatement — cf. récupération
      // ci-dessous. Correction obligatoire (utilisateur, 2026-08-20) : un plan manquant n'est
      // JAMAIS silencieusement accepté comme définitif sans une tentative de récupération
      // explicite d'abord.
      const failedShots: Shot[] = [];
      let succeededCount = 0;
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === 'rejected') {
          failedShots.push(toLaunch[i]);
          lastFatalError = result.reason;
          continue;
        }
        const value = result.value;
        if ('quotaExhausted' in value) {
          quotaExhausted = true;
          continue;
        }
        clipByShot.set(toLaunch[i], value.clip);
        if (value.quality) qualityByShot.set(toLaunch[i], value.quality);
        succeededCount += 1;
      }

      if (failedShots.length > 0) {
        this.logger.warn(
          `${failedShots.length} plan(s) en échec technique dans cette vague — tentative de récupération avant tout abandon définitif : ${failedShots.map((s) => s.sceneId).join(', ')}.`,
        );
        // generateSingleShot gère déjà proprement le quota (renvoie quotaExhausted plutôt que de
        // lever) — aucune vérification de slotsRemaining nécessaire avant cette tentative.
        const recovered = await Promise.allSettled(
          failedShots.map((shot) => this.generateSingleShot(ctx, shot, referenceImageUrl, visualDnaResult, organizationId, shotPlan.length, context)),
        );
        for (let i = 0; i < recovered.length; i++) {
          const result = recovered[i];
          if (result.status === 'rejected') {
            // Abandon DÉFINITIF de ce plan précis uniquement — jamais les autres plans de cette
            // vague, jamais toute la campagne. La vidéo finale (assemblée plus bas) reste
            // soumise aux MÊMES gates normaux (Video Judge / Quality Loop) qu'une vidéo complète
            // — aucun contournement pour un plan manquant, jamais une acceptation automatique.
            this.logger.warn(`Plan "${failedShots[i].sceneId}" définitivement abandonné après échec de la récupération : ${result.reason}`);
            lastFatalError = result.reason;
            continue;
          }
          const value = result.value;
          if ('quotaExhausted' in value) {
            quotaExhausted = true;
            continue;
          }
          clipByShot.set(failedShots[i], value.clip);
          if (value.quality) qualityByShot.set(failedShots[i], value.quality);
          succeededCount += 1;
        }
      }

      slotsRemaining -= succeededCount;

      if (quotaExhausted) break;
    }

    // Seul cas de véritable échec : AUCUN plan exploitable dans TOUT le plan (toutes vagues et
    // récupérations confondues) — un plan partiel (au moins 1 clip réel, même après abandon
    // définitif d'un ou plusieurs plans ci-dessus) est TOUJOURS assemblé et soumis aux mêmes
    // gates normaux plus bas, jamais une exception spéciale ou un raccourci pour un plan incomplet.
    // Si le vide vient UNIQUEMENT d'une dégradation quota (quotaExhausted, jamais poussé dans
    // lastFatalError), on laisse le flux normal continuer vers finalizeMultiShot([]) → dégradation
    // gracieuse (video: null), comportement inchangé. On ne relève l'erreur d'origine (même
    // instance, jamais un message générique qui masquerait son type — ex. PlanLimitExceededException
    // dont dépend campaign-generation.processor.ts::isDefinitiveFailure) que s'il y a eu un véritable
    // échec technique non récupéré.
    if (clipByShot.size === 0 && lastFatalError) {
      throw lastFatalError;
    }

    // Réassemblage dans l'ORDRE DE PRIORITÉ (pas l'ordre de complétion, non déterministe en
    // parallèle) — la concaténation reste déterministe et reproductible.
    const clips: AiGenerationResult[] = [];
    const videoClips: VideoClip[] = [];
    const perShotQuality = new Map<string, ShotQualityResult>();
    for (const shot of prioritizedShotPlan) {
      const clip = clipByShot.get(shot);
      if (!clip) continue;
      clips.push(clip);
      videoClips.push({ sceneId: shot.sceneId, content: clip.content });
      const quality = qualityByShot.get(shot);
      if (quality) perShotQuality.set(shot.sceneId, quality);
    }

    const video = await this.finalizeMultiShot(clips);
    return { video, videoClips, perShotQuality };
  }

  // Regroupe un Shot Plan (déjà trié par priorité) en vagues séquentielles selon Shot.dependencies
  // (Phase N) : une scène dépendant d'une autre n'est jamais lancée avant que sa dépendance ait
  // sa vague déterminée. AUJOURD'HUI, dependencies est toujours absent/vide sur 100% des plans
  // réels (aucun code ne le renseigne encore) — cette fonction produit donc systématiquement UNE
  // SEULE vague contenant tout le plan, dans son ordre de priorité déjà établi. L'algorithme reste
  // correct si ce champ est un jour renseigné : une dépendance vers un sceneId absent du plan, ou
  // un cycle, est traitée comme une absence de dépendance (jamais un blocage silencieux).
  private groupShotsIntoDependencyWaves(prioritizedShotPlan: ShotPlan): ShotPlan[] {
    const sceneIds = new Set(prioritizedShotPlan.map((s) => s.sceneId));
    const waveIndexBySceneId = new Map<string, number>();

    const resolveWaveIndex = (shot: Shot, visiting: Set<string>): number => {
      const cached = waveIndexBySceneId.get(shot.sceneId);
      if (cached !== undefined) return cached;
      const deps = (shot.dependencies ?? []).filter((id) => sceneIds.has(id) && id !== shot.sceneId);
      if (deps.length === 0 || visiting.has(shot.sceneId)) {
        waveIndexBySceneId.set(shot.sceneId, 0);
        return 0;
      }
      visiting.add(shot.sceneId);
      let maxDepWave = -1;
      for (const depId of deps) {
        const depShot = prioritizedShotPlan.find((s) => s.sceneId === depId)!;
        maxDepWave = Math.max(maxDepWave, resolveWaveIndex(depShot, visiting));
      }
      visiting.delete(shot.sceneId);
      const index = maxDepWave + 1;
      waveIndexBySceneId.set(shot.sceneId, index);
      return index;
    };

    for (const shot of prioritizedShotPlan) resolveWaveIndex(shot, new Set());

    const maxWave = Math.max(0, ...prioritizedShotPlan.map((s) => waveIndexBySceneId.get(s.sceneId)!));
    const waves: ShotPlan[] = Array.from({ length: maxWave + 1 }, () => []);
    for (const shot of prioritizedShotPlan) waves[waveIndexBySceneId.get(shot.sceneId)!].push(shot);
    return waves.filter((w) => w.length > 0);
  }

  // Extraction quasi-littérale de l'ancienne boucle séquentielle (2 essais max par plan, sélection
  // du meilleur, dégradation propre sur quota épuisé) — comportement interne INCHANGÉ, appelée
  // maintenant depuis Promise.allSettled (Phase M) au lieu d'un `for` séquentiel.
  private async generateSingleShot(
    ctx: AiCallContext,
    shot: Shot,
    referenceImageUrl: string,
    visualDnaResult: VisualDna,
    organizationId: string,
    totalShots: number,
    context: ShotExecutionContext,
  ): Promise<{ sceneId: string; clip: AiGenerationResult; quality: ShotQualityResult | null } | { sceneId: string; quotaExhausted: true }> {
    let currentPrompt = this.videoDirector.serializeShotToPrompt(shot, context);
    let best: AiGenerationResult | null = null;
    let bestQuality: ShotQualityResult | null = null;

    // Au plus 2 essais par plan : la génération initiale, puis UNE SEULE régénération si la
    // qualité (mouvement + fidélité) est jugée insuffisante — jamais plus, pour borner le
    // coût réel (chaque essai = un appel generateVideo facturé, cf. CREDIT_COSTS).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // referenceImageUrl transmis à chaque essai — ancre CHAQUE plan sur la vraie photo
        // produit (cf. GoogleVeoProvider.resolveImageForVeo), pas seulement le premier.
        // 6s : valide nativement pour Veo (4/6/8s acceptés) et arrondi à 5s côté Runway
        // (n'accepte que 5 ou 10s, cf. RunwayProvider).
        const clip = await this.aiGateway.generateVideo(ctx, { prompt: currentPrompt, imageUrl: referenceImageUrl, durationSeconds: 6 }, 'google-veo');
        const quality = await this.videoAnalyzer.analyze(ctx, clip.content, { visualDna: visualDnaResult });

        if (!best || quality.qualityScore > (bestQuality?.qualityScore ?? -1)) {
          best = clip;
          bestQuality = quality;
        }
        if (quality.passed) break;
        this.logger.warn(`Plan "${shot.sceneId}"/${totalShots} : qualité insuffisante (${quality.reasons.join('; ')}) — nouvelle tentative corrigée.`);
        // Repair Loop intelligent (2026-08-18) : la régénération n'est plus un tirage
        // aléatoire du MÊME prompt — le prompt du 2e essai cible précisément la cause de
        // l'échec (mouvement et/ou fidélité), cf. VideoDirectorService.repairShotPrompt.
        currentPrompt = this.videoDirector.repairShotPrompt(shot, quality, context);
      } catch (error) {
        if (error instanceof PlanLimitExceededException) {
          const payload = error.getResponse() as PlanLimitExceededPayload;
          // 'videos' = plafond de CAMPAGNES distinctes avec vidéo (essai) ; 'videoShots' =
          // plafond de CLIPS dans CETTE campagne (cf. EntitlementsService.
          // assertVideoQuotaAvailable, corrigé le 2026-08-18) — les deux doivent dégrader
          // proprement de la même façon.
          if (payload.limitType === 'videos' || payload.limitType === 'videoShots') {
            this.logger.warn(`Quota vidéo (${payload.limitType}) atteint pour l'organisation ${organizationId} sur le plan "${shot.sceneId}" — campagne poursuivie avec ce qui a été généré.`);
            return { sceneId: shot.sceneId, quotaExhausted: true };
          }
        }
        // Échec technique réel (pas quota) : si le 1er essai a déjà produit un clip
        // utilisable, l'échec du RETRY ne bloque jamais la campagne — le meilleur essai
        // disponible est conservé.
        if (best) break;
        // Audit forensic (campagne réelle 1c41d0d0-7b13-4530-9238-244188fad73a, 2026-08-20) : 3
        // plans lancés EN PARALLÈLE à l'identique ont réussi pendant qu'UN seul échouait
        // techniquement (Google Veo: réponse sans vidéo) — exclut une panne généralisée, cohérent
        // avec un aléa isolé sur CET appel précis. Un échec technique brut au 1er essai n'avait
        // auparavant AUCUN rattrapage (contrairement à un échec de QUALITÉ ci-dessus, qui
        // consomme le 2e essai déjà budgété) : retenté ici avec le MÊME prompt tant qu'il reste
        // un essai (rien à corriger, aucun diagnostic de qualité disponible pour un échec
        // technique) — jamais relancé immédiatement dès le 1er échec.
        if (attempt < 1) {
          this.logger.warn(`Plan "${shot.sceneId}"/${totalShots} : échec technique (${error instanceof Error ? error.message : error}) — nouvel essai avant abandon.`);
          continue;
        }
        throw error;
      }
    }

    return { sceneId: shot.sceneId, clip: best!, quality: bestQuality };
  }

  private async finalizeMultiShot(clips: AiGenerationResult[]): Promise<AiGenerationResult | null> {
    if (clips.length === 0) return null;
    if (clips.length === 1) return clips[0];

    const combinedContent = await this.videoFinalization.concatenateClips(clips.map((c) => c.content));

    return {
      content: combinedContent,
      provider: clips[0].provider,
      model: clips[0].model,
      costEstimate: clips.reduce((sum, clip) => sum + (clip.costEstimate ?? 0), 0),
      durationMs: clips.reduce((sum, clip) => sum + clip.durationMs, 0),
      // Pas de generationId : composite de plusieurs générations, aucune ne le représente 1:1 —
      // même principe que CampaignGenerationProcessor.finalizeVideoAsset() pour la vidéo finale
      // assemblée (narration+musique+sous-titres), appliqué ici un niveau plus tôt.
    };
  }

  // Analyse par vision — catégorie, fourchette de prix, forces et USP détectées directement
  // depuis la photo, recoupées avec la description texte si elle est aussi fournie. Le
  // résultat reste un simple bloc de texte lisible (productAnalysis.content), au même titre
  // que le chemin texte-seul historique : aucune étape en aval n'a besoin de savoir laquelle
  // des deux voies a produit ce texte.
  private async analyzeProductImage(
    ctx: AiCallContext,
    imageUrl: string,
    productDescription: string | undefined,
    analysisAngleHint: string,
  ): Promise<AiGenerationResult> {
    const descriptionHint = productDescription?.trim()
      ? `\nDescription fournie par l'utilisateur, à recouper avec ce que montre la photo : ${productDescription}`
      : '';
    const prompt = `Observe cette photo de produit et identifie : sa catégorie, une fourchette de prix de vente plausible, 2 à 4 forces marketing, et une proposition de valeur unique (USP).${descriptionHint}${analysisAngleHint}
Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact {"category":"...","priceRange":"...","strengths":["...","..."],"usp":"..."}.`;

    const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai', PROMPT_VERSIONS.productAnalysis);
    return { ...result, content: this.formatProductAnalysis(result.content) };
  }

  // Même logique de repli que parseGoogleAdsContent : un modèle qui ne respecte pas le
  // format JSON demandé ne doit jamais faire échouer toute la génération de campagne — le
  // texte brut est conservé, un validateur humain le verra tel quel en revue.
  private formatProductAnalysis(raw: string): string {
    try {
      const parsed = parseAiJson<any>(raw);
      const strengths = Array.isArray(parsed.strengths) ? parsed.strengths.join(', ') : undefined;
      return [
        `Catégorie détectée : ${parsed.category ?? 'non déterminée'}`,
        `Fourchette de prix estimée : ${parsed.priceRange ?? 'non déterminée'}`,
        `Forces : ${strengths ?? 'non déterminées'}`,
        `USP : ${parsed.usp ?? 'non déterminée'}`,
      ].join('\n');
    } catch (error) {
      this.logger.warn(`Réponse d'analyse produit (vision) non conforme au format JSON attendu, texte brut conservé: ${error}`);
      return raw;
    }
  }

  private async generateChannelCopy(
    ctx: AiCallContext,
    channel: string,
    params: GenerateCampaignParams,
    strategyContent: string,
    hints: GenerateCampaignParams['templateHints'],
    creativeConcept: CreativeConcept,
    narrativeBlueprint: NarrativeBlueprint,
  ): Promise<AiGenerationResult> {
    // Contexte de marque propre à CE canal (Phase 6) — les règles/apprentissages spécifiques
    // à Instagram n'ont aucune raison de s'appliquer tels quels sur LinkedIn, et inversement ;
    // le contexte GLOBAL (mission, ton, règles sans canal précis) reste inclus dans les deux cas.
    const channelBrandContext = await this.brandContext.build({
      organizationId: params.organizationId,
      channel,
      persona: hints?.personaArchetype,
    });

    const prompt = this.buildChannelPrompt(channel, params, strategyContent, hints, channelBrandContext.text, creativeConcept, narrativeBlueprint);
    // LinkedIn (argumentation B2B) bénéficie du même modèle que la stratégie — raisonnement
    // structuré plutôt que le modèle économique utilisé pour les formats courts/visuels.
    const provider = channel === 'linkedin' ? 'anthropic' : 'openai';

    const result = await this.aiGateway.generateText(ctx, { prompt }, provider, PROMPT_VERSIONS.channelCopy);

    // Google Ads est le seul canal dont la structure (titres + descriptions distincts, avec
    // des limites de caractères strictes) ne se prête pas à un simple bloc de texte libre —
    // demandé en JSON, validé/tronqué ici plutôt que de faire confiance au modèle pour
    // respecter des limites de caractères exactes (les LLM les dépassent régulièrement).
    if (channel === 'googleads') {
      return { ...result, content: this.parseGoogleAdsContent(result.content) };
    }
    return result;
  }

  private buildChannelPrompt(
    channel: string,
    params: GenerateCampaignParams,
    strategyContent: string,
    hints: GenerateCampaignParams['templateHints'],
    brandContextText: string,
    creativeConcept: CreativeConcept,
    narrativeBlueprint: NarrativeBlueprint,
  ): string {
    const toneHint = hints?.toneHint ? `\nTon à adopter : ${hints.toneHint}` : '';
    const ctaHint = hints?.ctaStyle ? `\nStyle d'appel à l'action : ${hints.ctaStyle}` : '';
    const brandContextBlock = brandContextText ? `\n\nContexte de marque :\n${brandContextText}` : '';
    // Audit forensic (2026-08-20, campagne réelle 5345726a-5ace-49ec-821e-b0355aaac4df) — avant
    // ce bloc, ce prompt ne recevait QUE la stratégie marketing générique, jamais le Creative
    // Concept spécifique déjà utilisé pour générer le Shot Plan/la vidéo (cf.
    // VideoDirectorService.generateShotPlan, qui LUI reçoit bien creativeConcept). Deux pipelines
    // créatifs indépendants : le script TikTok (source de la narration finale AVANT Mission 4.3
    // Phase 3, cf. buildNarrationFromBlueprint aujourd'hui) était rédigé sans connaître le hook,
    // la structure narrative ou la direction émotionnelle réellement filmés — d'où des voix off
    // génériques ("inventaire de caractéristiques produit") qui contredisaient systématiquement
    // le concept que le Video Judge évalue. Résultat réel confirmé sur 2 campagnes (storytelling/
    // hookStrength/pacing/brandCoherence/advertisingEffectiveness tous en défaut CRITIQUE pour la
    // même raison).
    const conceptBlock = `\n\nConcept créatif retenu (l'exécution DOIT suivre cette idée précise, jamais un inventaire générique de caractéristiques produit) :\nTitre : ${creativeConcept.title}\nAccroche (hook) : ${creativeConcept.hook}\nMessage central : ${creativeConcept.coreMessage}\nApproche narrative : ${creativeConcept.storytellingApproach}\nDirection émotionnelle : ${creativeConcept.emotionalDirection}`;
    // Mission 4.3 (Goal-First Quality Architecture, Phase 3, Étape 4) — chaque canal, pas
    // seulement TikTok, écrit désormais sa copie en cohérence avec la MÊME structure narrative
    // que la narration/le Shot Plan, plutôt que de réinventer indépendamment sa propre histoire.
    const narrativeBlueprintBlock = `\n\nStructure narrative de référence (le texte doit s'inscrire dans cette progression, jamais la réinventer) :\nHook : ${narrativeBlueprint.hook}\nProblème : ${narrativeBlueprint.problem}\nBénéfice : ${narrativeBlueprint.benefit}\nPreuve : ${narrativeBlueprint.proof}\nCTA : ${narrativeBlueprint.cta}`;
    // Objectif explicite en tête (chantier "prompts précis, orientés objectif" du 2026-08-18) :
    // auparavant présent seulement INDIRECTEMENT, noyé dans strategyContent — un modèle ne
    // devrait pas avoir à l'en déduire alors qu'il est disponible tel quel.
    const base = `Objectif de la campagne : ${params.objective}\nStratégie marketing de référence :\n${strategyContent}${toneHint}${ctaHint}\n\nProduit : ${params.productDescription}${conceptBlock}${narrativeBlueprintBlock}${brandContextBlock}`;

    switch (channel) {
      case 'instagram':
        return `${base}\n\nRédige une publication Instagram : légende courte et percutante (2 à 3 phrases maximum, ton visuel et inspirant), suivie de 4 à 6 hashtags pertinents sur une ligne séparée. Le visuel qui accompagnera ce texte est généré séparément — décris uniquement le texte.`;

      case 'facebook':
        return `${base}\n\nRédige une publication Facebook : ton conversationnel, comme si tu t'adressais directement à un ami — pose une question ou invite à réagir en commentaire, longueur modérée (4 à 6 phrases), pas de jargon marketing.`;

      case 'linkedin':
        return `${base}\n\nRédige une publication LinkedIn B2B : ton professionnel et argumenté, structuré autour d'un problème métier concret puis de la solution apportée, chiffres ou preuves si pertinent, pas d'emoji excessif, conclusion avec une invitation à l'échange plutôt qu'un simple lien.`;

      case 'tiktok':
        // Format "Visuel: ... | Voix off: ..." par plan — corrige un défaut historique où "Plan 1
        // — description de l'action à l'écran" ne produisait que des indications de mise en scène
        // (rien à lire à voix haute). Depuis Mission 4.3 Phase 3, ce script TikTok n'est PLUS la
        // source de la narration finale de la vidéo (celle-ci dérive directement du
        // NarrativeBlueprint, cf. buildNarrationFromBlueprint) — le format Visuel/Voix off reste
        // néanmoins exigé pour la cohérence interne du post TikTok lui-même (texte réellement dit
        // à voix haute vs. simple mise en scène), et pour rester alignée avec la structure
        // narrative de référence déjà injectée dans `base` (narrativeBlueprintBlock).
        return `${base}\n\nRédige un script vidéo TikTok au format suivant, à respecter STRICTEMENT :\n\nHook: <accroche des 2 premières secondes, une seule phrase très courte et percutante, jamais plus de 10 mots>\n\nPlan 1 — Visuel: <description de l'action à l'écran> | Voix off: <phrase à dire à voix haute pendant ce plan, ton publicitaire naturel, jamais une description de l'image>\nPlan 2 — Visuel: ... | Voix off: ...\nPlan 3 — Visuel: ... | Voix off: ...\n(3 à 4 plans au total)\n\nLe Hook et l'ensemble des répliques "Voix off" mis bout à bout doivent durer entre 15 et 30 secondes à l'oral (environ 40 à 80 mots au total) et raconter FIDÈLEMENT la structure narrative de référence ci-dessus — jamais une histoire différente de celle de la vidéo finale. IMPORTANT : le Hook et les répliques "Voix off" DOIVENT suivre l'approche narrative du concept créatif ci-dessus (${creativeConcept.storytellingApproach}) — jamais un simple inventaire de caractéristiques produit énumérées les unes après les autres, même si chaque caractéristique individuelle est correcte.`;

      case 'googleads':
        return `${base}\n\nRédige une annonce Google Ads Search au format responsive. Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact {"headlines":["...","...","..."],"descriptions":["...","..."]}. Contraintes strictes et non négociables : chaque titre ("headline") fait 30 caractères MAXIMUM espaces compris, chaque description fait 90 caractères MAXIMUM espaces compris. Génère exactement 3 titres et 2 descriptions, tous différents les uns des autres, sans jamais dépasser ces limites.`;

      default:
        return `${base}\n\nRédige une publication générique adaptée à ce produit et cette stratégie, sans contrainte de format particulière.`;
    }
  }

  // Format lisible en base (ContentVersion.body reste un simple champ texte, pas de
  // structure JSON dédiée pour ce seul canal) tout en garantissant que les limites réelles
  // de la plateforme sont respectées, indépendamment de la discipline du modèle — un LLM
  // dépasse régulièrement une limite de caractères demandée dans le prompt seul.
  private parseGoogleAdsContent(raw: string): string {
    try {
      const parsed = parseAiJson<any>(raw);
      const headlines: string[] = (parsed.headlines ?? []).map((h: string) => this.truncate(h, 30));
      const descriptions: string[] = (parsed.descriptions ?? []).map((d: string) => this.truncate(d, 90));

      if (headlines.length === 0 && descriptions.length === 0) return raw;

      const headlinesText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
      const descriptionsText = descriptions.map((d, i) => `${i + 1}. ${d}`).join('\n');
      return `Titres (30 caractères max) :\n${headlinesText}\n\nDescriptions (90 caractères max) :\n${descriptionsText}`;
    } catch (error) {
      // Le modèle n'a pas respecté le format JSON demandé — le texte brut est conservé
      // plutôt que de faire échouer toute la génération de campagne pour ce seul canal ;
      // un validateur humain le verra tel quel en revue et pourra le corriger manuellement
      // via le Content Studio.
      this.logger.warn(`Réponse Google Ads non conforme au format JSON attendu, texte brut conservé: ${error}`);
      return raw;
    }
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }
}
