import { Injectable, Logger } from '@nestjs/common';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { AiGenerationResult, TranscriptSegment } from '../ai-gateway/providers/ai-provider.interface';
import { BrandContextBuilderService } from '../../brand/brand-context-builder.service';
import { VideoFinalizationService } from '../../video-assembly/video-finalization.service';
import { PlanLimitExceededException, PlanLimitExceededPayload } from '../../plans/plan-limit.exception';
import { VisualDnaService, VisualDna } from '../video-direction/visual-dna.service';
import { VideoDirectorService, ShotPlan } from '../video-direction/video-director.service';
import { VideoAnalyzerService, ShotQualityResult } from '../video-direction/video-analyzer.service';
import { PROMPT_VERSIONS } from '../prompt-versions';

export interface GenerateCampaignParams {
  organizationId: string;
  campaignId: string;
  // Les deux sont optionnels côté type, mais CampaignsService.create() garantit qu'au moins
  // l'un des deux est fourni avant d'empiler le job — jamais les deux absents en pratique.
  productDescription?: string;
  productImageUrl?: string;
  objective: string;
  channels?: string[]; // ex: ['facebook','instagram','tiktok'] — détermine si une vidéo est générée
  templateHints?: {
    toneHint?: string;
    analysisAngle?: string;
    personaArchetype?: string;
    ctaStyle?: string;
  }; // cf. CampaignTemplate.structureHint — Module 18, guide l'Orchestrator sans figer le contenu
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
    const productAnalysis = params.productImageUrl
      ? await this.analyzeProductImage(ctx, params.productImageUrl, params.productDescription, analysisAngleHint)
      : await this.aiGateway.generateText(
          ctx,
          { prompt: `Analyse ce produit et identifie ses forces, faiblesses et USP: ${params.productDescription}${analysisAngleHint}` },
          'openai', // routage: analyse rapide -> modèle économique
          PROMPT_VERSIONS.productAnalysis,
        );

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

    const strategy = await this.aiGateway.generateText(
      ctx,
      {
        prompt: `À partir de cette analyse produit, propose une stratégie marketing SMART pour l'objectif "${params.objective}".
Contrainte impérative : cette stratégie doit être intégralement réalisable avec UNIQUEMENT ce que campaign-ai produit réellement pour cette campagne — un texte publicitaire par canal parmi [${targetChannels.join(', ')}], un visuel, et une courte vidéo. Ne propose JAMAIS de tactiques hors de ce périmètre (emails, SMS, landing page dédiée, retargeting publicitaire, pop-up, etc.) — la stratégie doit se limiter à ce qui sera effectivement livré sur ces canaux.
${productAnalysis.content}${personaHint}${brandContextBlock}

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

    const channelContent: Record<string, AiGenerationResult> = {};

    for (const channel of targetChannels) {
      channelContent[channel] = await this.generateChannelCopy(ctx, channel, effectiveParams, strategy.content, hints);
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
      hasReferencePhoto ? 'openai' : 'flux', // routage: ancrage prioritaire sur la qualité photoréaliste pure quand une vraie photo existe, repli automatique (Ideogram/Flux) si l'édition échoue
      PROMPT_VERSIONS.visual,
    );

    // Voix off générée pour CHAQUE campagne, au même titre que la vidéo — une vidéo
    // publicitaire sans son n'est pas un format utilisable en l'état. Dérivée du script TikTok
    // (hook + plans) quand il existe plutôt que régénérée par un appel IA séparé : un seul
    // script fait autorité pour ce que "dit" la campagne. Fallback minimal quand aucun canal
    // TikTok n'a été sélectionné (scriptBasis absent) — jamais aucune voix plutôt qu'une phrase
    // creuse, productDescription tronqué (pas utilisé tel quel, cf. truncateForNarration) car
    // c'est souvent l'analyse vision complète (plusieurs phrases), pas un nom de produit court.
    // Calculée ICI (avant la vidéo, pas après comme avant le 2026-08-18) : pur calcul de chaîne,
    // aucun appel IA — sert désormais aussi de contexte de rythme au Video Director ci-dessous,
    // pour que le Shot Plan et la narration racontent la même histoire.
    const scriptBasis = channelContent['tiktok']?.content;
    const narrationText = scriptBasis ? this.scriptToNarration(scriptBasis) : this.buildFallbackNarration(effectiveParams.productDescription ?? '');

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
    const shotPlan = await this.videoDirector.generateShotPlan(
      ctx,
      {
        visualDna: visualDnaResult,
        productDescription: effectiveParams.productDescription ?? '',
        objective: params.objective,
        campaignContext: strategy.content,
        narrationHint: narrationText,
      },
      3,
    );
    const video = await this.generateShotPlanVideoOrDegrade(ctx, shotPlan, referenceImageUrl, visualDnaResult, params.organizationId);

    const narration = await this.aiGateway.generateAudio(ctx, { prompt: narrationText }, 'openai');

    // Sous-titres : transcrit l'audio RÉELLEMENT généré (pas le texte source) pour obtenir le
    // timing effectif de la parole — cf. OpenAiProvider.transcribeAudio(). Dégradation, jamais
    // un échec de campagne : perdre les sous-titres n'est pas perdre la vidéo (VideoAssemblyService
    // incruste seulement si un transcript est disponible). Échoue aussi silencieusement en mode
    // mock, où narration.content n'est qu'une URL factice (MockProvider.generateAudio), pas un
    // vrai data URI audio à décoder.
    const transcript = await this.transcribeNarrationOrDegrade(ctx, narration.content);

    return { productAnalysis, strategy, channelContent, visual, video, narration, transcript };
  }

  private async transcribeNarrationOrDegrade(ctx: AiCallContext, narrationContent: string): Promise<TranscriptSegment[] | null> {
    const match = /^data:(.+?);base64,(.+)$/.exec(narrationContent);
    if (!match) return null;

    try {
      const [, mimeType, base64] = match;
      const audioBuffer = Buffer.from(base64, 'base64');
      const result = await this.aiGateway.transcribeAudio(ctx, { audioBuffer, mimeType }, 'openai');
      return JSON.parse(result.content) as TranscriptSegment[];
    } catch (error) {
      this.logger.warn(`Transcription de la narration échouée — vidéo générée sans sous-titres : ${error}`);
      return null;
    }
  }

  // Reconstitue le texte à dire à partir du Hook + de chaque réplique "Voix off: ..." (format
  // demandé par buildChannelPrompt, cas 'tiktok') — jamais les segments "Visuel: ..." (indications
  // de mise en scène, pas du texte parlé). Corrige un défaut constaté en conditions réelles le
  // 2026-08-16 : l'ancienne version se contentait de retirer les lignes "Plan N — ...", ne
  // laissant que le hook (une phrase, ~3s) comme narration — bien en deçà des 15-30s demandés au
  // modèle, et donc une vidéo finale bien plus courte que prévu (finalDuration = narrationDuration,
  // cf. VideoAssemblyService).
  private scriptToNarration(script: string): string {
    const hook = /^Hook:\s*(.+)$/m.exec(script)?.[1]?.trim();
    const voiceOverLines = [...script.matchAll(/Voix off\s*:\s*([^\n|]+)/gi)].map((m) => m[1].trim());

    const structured = [hook, ...voiceOverLines].filter((s): s is string => !!s).join(' ');
    if (structured) return structured.replace(/\s+/g, ' ').trim();

    // Repli si le modèle n'a pas respecté le format "Voix off: ..." demandé (même comportement
    // que l'ancienne implémentation) : ne retire que les lignes de mise en scène "Plan N — ...",
    // garde tout le reste plutôt que de renvoyer une narration vide.
    return script
      .split('\n')
      .filter((line) => !/^Plan\s+\d+\s*—/.test(line.trim()))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Réduit un texte long (typiquement productDescription, souvent l'analyse vision complète —
  // plusieurs phrases, parfois un paragraphe) à une longueur adaptée à une narration de repli
  // courte (~140 caractères, cohérent avec les 6-8s d'un clip vidéo unique sans canal TikTok).
  // Préfère couper sur la première phrase plutôt qu'en plein milieu d'un mot quand elle tient
  // dans le budget ; sinon tronque dur avec une ellipse.
  private truncateForNarration(text: string, maxChars = 140): string {
    const trimmed = text.trim();
    const firstSentence = /^[^.!?\n]+[.!?]?/.exec(trimmed)?.[0]?.replace(/[.!?]+$/, '').trim();
    if (firstSentence && firstSentence.length <= maxChars) return firstSentence;
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trim()}…` : trimmed;
  }

  // Bug réel constaté en conditions réelles le 2026-08-18 : sans canal TikTok, la narration de
  // repli utilisait directement `effectiveParams.productDescription` — qui, quand dérivé d'une
  // photo (pas de texte saisi par l'utilisateur), N'EST PAS une phrase naturelle mais le bloc
  // ÉTIQUETÉ produit par formatProductAnalysis() ("Catégorie détectée : ...\nFourchette de prix
  // estimée : ...\n..."). truncateForNarration() s'arrêtant au premier \n, la narration finale
  // disait littéralement "Découvrez Catégorie détectée : Produits ménagers...", lu à voix haute
  // tel quel. Corrigé en détectant ce format structuré et en reconstruisant une phrase naturelle
  // à partir de la catégorie + l'USP — repli sur l'ancien comportement (troncature brute) quand
  // le texte est une VRAIE description libre (saisie par l'utilisateur, ou analyse non conforme
  // au format JSON attendu), cas où il n'y a pas de labels à extraire.
  private buildFallbackNarration(description: string): string {
    const category = /^Catégorie détectée\s*:\s*(.+)$/m.exec(description)?.[1]?.trim();
    const usp = /^USP\s*:\s*(.+)$/m.exec(description)?.[1]?.trim();
    if (category && usp && category !== 'non déterminée' && usp !== 'non déterminée') {
      return `Découvrez notre ${category} : ${this.truncateForNarration(usp, 100)}.`;
    }
    return `Découvrez ${this.truncateForNarration(description)}.`;
  }

  // Correction de l'audit du 2026-08-13 : rendre la vidéo obligatoire pour CHAQUE campagne
  // entre directement en conflit avec le plafond dédié `maxVideos` de l'essai gratuit (1 vidéo
  // au total, cf. plan-catalog.ts) — dès la 2e campagne générée en essai, ce plafond serait
  // systématiquement atteint, et sans ce garde-fou l'exception remonterait jusqu'au processor
  // qui marquerait la campagne entière FAILED. Une campagne sans vidéo À CAUSE D'UN QUOTA
  // MÉTIER ATTEINT (pas d'une panne technique) doit dégrader proprement — se terminer
  // normalement avec le reste du contenu, la vidéo simplement omise — plutôt que transformer un
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
  // l'ancien mécanisme (assertVideoQuotaAvailable, cf. AiGatewayService) : sur l'essai gratuit
  // (maxVideos: 1), le premier clip consomme déjà tout le quota — tout essai suivant (plan
  // suivant OU régénération du même plan) échoue avec PlanLimitExceededException, interceptée
  // ici pour dégrader proprement. Conséquence gratuite de ce mécanisme existant, AUCUN code
  // supplémentaire nécessaire : sur l'essai gratuit, la régénération elle-même est
  // automatiquement bloquée par le quota dès qu'un premier clip a réussi — le comportement
  // "1 seul essai en pratique" sur ce plan n'est pas codé, il découle directement du garde-fou.
  private async generateShotPlanVideoOrDegrade(
    ctx: AiCallContext,
    shotPlan: ShotPlan,
    referenceImageUrl: string,
    visualDnaResult: VisualDna,
    organizationId: string,
  ): Promise<AiGenerationResult | null> {
    const clips: AiGenerationResult[] = [];

    for (const [index, shot] of shotPlan.entries()) {
      let currentPrompt = this.videoDirector.serializeShotToPrompt(shot);
      let best: AiGenerationResult | null = null;
      let bestQuality: ShotQualityResult | null = null;
      let quotaExhausted = false;

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
          this.logger.warn(`Plan ${index + 1}/${shotPlan.length} : qualité insuffisante (${quality.reasons.join('; ')}) — nouvelle tentative corrigée.`);
          // Repair Loop intelligent (2026-08-18) : la régénération n'est plus un tirage
          // aléatoire du MÊME prompt — le prompt du 2e essai cible précisément la cause de
          // l'échec (mouvement et/ou fidélité), cf. VideoDirectorService.repairShotPrompt.
          currentPrompt = this.videoDirector.repairShotPrompt(shot, quality);
        } catch (error) {
          if (error instanceof PlanLimitExceededException) {
            const payload = error.getResponse() as PlanLimitExceededPayload;
            if (payload.limitType === 'videos') {
              quotaExhausted = true;
              this.logger.warn(
                `Quota vidéo de l'essai atteint pour l'organisation ${organizationId} après ${clips.length} plan(s) sur ${shotPlan.length} — campagne poursuivie avec ce qui a été généré.`,
              );
              break;
            }
          }
          // Échec technique réel (pas quota) : si le 1er essai a déjà produit un clip
          // utilisable, l'échec du RETRY ne bloque jamais la campagne — sinon (échec dès le
          // 1er essai) il remonte, comportement inchangé.
          if (best) break;
          throw error;
        }
      }

      if (best) clips.push(best);
      if (quotaExhausted) break;
    }

    return this.finalizeMultiShot(clips);
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
      const parsed = JSON.parse(raw);
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
  ): Promise<AiGenerationResult> {
    // Contexte de marque propre à CE canal (Phase 6) — les règles/apprentissages spécifiques
    // à Instagram n'ont aucune raison de s'appliquer tels quels sur LinkedIn, et inversement ;
    // le contexte GLOBAL (mission, ton, règles sans canal précis) reste inclus dans les deux cas.
    const channelBrandContext = await this.brandContext.build({
      organizationId: params.organizationId,
      channel,
      persona: hints?.personaArchetype,
    });

    const prompt = this.buildChannelPrompt(channel, params, strategyContent, hints, channelBrandContext.text);
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
  ): string {
    const toneHint = hints?.toneHint ? `\nTon à adopter : ${hints.toneHint}` : '';
    const ctaHint = hints?.ctaStyle ? `\nStyle d'appel à l'action : ${hints.ctaStyle}` : '';
    const brandContextBlock = brandContextText ? `\n\nContexte de marque :\n${brandContextText}` : '';
    // Objectif explicite en tête (chantier "prompts précis, orientés objectif" du 2026-08-18) :
    // auparavant présent seulement INDIRECTEMENT, noyé dans strategyContent — un modèle ne
    // devrait pas avoir à l'en déduire alors qu'il est disponible tel quel.
    const base = `Objectif de la campagne : ${params.objective}\nStratégie marketing de référence :\n${strategyContent}${toneHint}${ctaHint}\n\nProduit : ${params.productDescription}${brandContextBlock}`;

    switch (channel) {
      case 'instagram':
        return `${base}\n\nRédige une publication Instagram : légende courte et percutante (2 à 3 phrases maximum, ton visuel et inspirant), suivie de 4 à 6 hashtags pertinents sur une ligne séparée. Le visuel qui accompagnera ce texte est généré séparément — décris uniquement le texte.`;

      case 'facebook':
        return `${base}\n\nRédige une publication Facebook : ton conversationnel, comme si tu t'adressais directement à un ami — pose une question ou invite à réagir en commentaire, longueur modérée (4 à 6 phrases), pas de jargon marketing.`;

      case 'linkedin':
        return `${base}\n\nRédige une publication LinkedIn B2B : ton professionnel et argumenté, structuré autour d'un problème métier concret puis de la solution apportée, chiffres ou preuves si pertinent, pas d'emoji excessif, conclusion avec une invitation à l'échange plutôt qu'un simple lien.`;

      case 'tiktok':
        // Format "Visuel: ... | Voix off: ..." par plan — corrige un défaut où "Plan 1 —
        // description de l'action à l'écran" ne produisait que des indications de mise en scène
        // (rien à lire à voix haute), alors que la contrainte "15 à 30 secondes à l'oral"
        // ci-dessous supposait l'inverse. Résultat constaté en conditions réelles le 2026-08-16 :
        // scriptToNarration() ne retirant QUE les lignes "Plan N —", il ne restait plus que le
        // hook (une phrase, ~3s) comme texte parlé — vidéo finale bien plus courte que prévu,
        // alignée sur cette narration tronquée (cf. VideoAssemblyService, finalDuration =
        // narrationDuration). Séparer explicitement mise en scène et texte à dire permet à
        // scriptToNarration() de reconstituer une narration complète couvrant la durée demandée.
        return `${base}\n\nRédige un script vidéo TikTok au format suivant, à respecter STRICTEMENT :\n\nHook: <accroche des 2 premières secondes, une seule phrase très courte et percutante, jamais plus de 10 mots — c'est aussi la première phrase dite par la voix off>\n\nPlan 1 — Visuel: <description de l'action à l'écran> | Voix off: <phrase à dire à voix haute pendant ce plan, ton publicitaire naturel, jamais une description de l'image>\nPlan 2 — Visuel: ... | Voix off: ...\nPlan 3 — Visuel: ... | Voix off: ...\n(3 à 4 plans au total)\n\nLe Hook et l'ensemble des répliques "Voix off" mis bout à bout doivent durer entre 15 et 30 secondes à l'oral (environ 40 à 80 mots au total) — c'est cette partie, et UNIQUEMENT elle, qui sera lue par la voix off finale de la vidéo.`;

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
      const parsed = JSON.parse(raw);
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
