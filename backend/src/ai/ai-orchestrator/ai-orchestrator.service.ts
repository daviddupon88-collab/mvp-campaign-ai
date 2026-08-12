import { Injectable, Logger } from '@nestjs/common';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { AiGenerationResult } from '../ai-gateway/providers/ai-provider.interface';
import { BrandContextBuilderService } from '../../brand/brand-context-builder.service';

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
        );

    const strategy = await this.aiGateway.generateText(
      ctx,
      { prompt: `À partir de cette analyse produit, propose une stratégie marketing SMART pour l'objectif "${params.objective}":\n${productAnalysis.content}${personaHint}${brandContextBlock}` },
      'anthropic', // routage: raisonnement stratégique -> modèle plus fort
    );

    // À partir d'ici, plus aucune étape n'a besoin de savoir si la description vient du texte
    // saisi ou a été dérivée de l'analyse photo — un seul champ texte non vide, garanti par
    // ce repli, pour tous les prompts qui suivent (copywriting par canal, visuel, vidéo).
    const effectiveParams: GenerateCampaignParams = {
      ...params,
      productDescription: params.productDescription?.trim() || productAnalysis.content,
    };

    // Un canal par appel, jamais un texte partagé — targetChannels fait foi pour le reste
    // du pipeline (visuel, vidéo, persistance côté worker), qui ne recalcule jamais cette
    // liste indépendamment pour éviter tout risque de divergence entre les deux.
    const targetChannels = effectiveParams.channels && effectiveParams.channels.length > 0 ? effectiveParams.channels : ['general'];
    const channelContent: Record<string, AiGenerationResult> = {};

    for (const channel of targetChannels) {
      channelContent[channel] = await this.generateChannelCopy(ctx, channel, effectiveParams, strategy.content, hints);
    }

    const visual = await this.aiGateway.generateImage(
      ctx,
      { prompt: `Visuel publicitaire pour: ${effectiveParams.productDescription}` },
      'flux', // routage: Flux d'abord pour la qualité photoréaliste, repli automatique sur Ideogram/OpenAI si échec
    );

    // Vidéo générée uniquement si un canal vidéo-natif a été sélectionné (TikTok, Instagram) —
    // évite de consommer des crédits IA coûteux pour rien (la vidéo est le poste le plus cher,
    // cf. chapitre 3.5 du Volume 2).
    let video: AiGenerationResult | null = null;
    const videoChannels = ['tiktok', 'instagram'];
    if (effectiveParams.channels?.some((c) => videoChannels.includes(c))) {
      // Réutilise le script TikTok déjà généré comme base du prompt vidéo plutôt qu'un
      // prompt générique déconnecté — cohérence entre le script écrit et la vidéo produite.
      const scriptBasis = channelContent['tiktok']?.content;
      const videoPrompt = scriptBasis
        ? `Vidéo publicitaire courte (15s) pour: ${effectiveParams.productDescription}\n\nScript de référence à respecter :\n${scriptBasis}`
        : `Vidéo publicitaire courte (15s) pour: ${effectiveParams.productDescription}`;
      video = await this.aiGateway.generateVideo(ctx, { prompt: videoPrompt }, 'google-veo');
    }

    return { productAnalysis, strategy, channelContent, visual, video };
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

    const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai');
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

    const result = await this.aiGateway.generateText(ctx, { prompt }, provider);

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
    const base = `Stratégie marketing de référence :\n${strategyContent}${toneHint}${ctaHint}\n\nProduit : ${params.productDescription}${brandContextBlock}`;

    switch (channel) {
      case 'instagram':
        return `${base}\n\nRédige une publication Instagram : légende courte et percutante (2 à 3 phrases maximum, ton visuel et inspirant), suivie de 4 à 6 hashtags pertinents sur une ligne séparée. Le visuel qui accompagnera ce texte est généré séparément — décris uniquement le texte.`;

      case 'facebook':
        return `${base}\n\nRédige une publication Facebook : ton conversationnel, comme si tu t'adressais directement à un ami — pose une question ou invite à réagir en commentaire, longueur modérée (4 à 6 phrases), pas de jargon marketing.`;

      case 'linkedin':
        return `${base}\n\nRédige une publication LinkedIn B2B : ton professionnel et argumenté, structuré autour d'un problème métier concret puis de la solution apportée, chiffres ou preuves si pertinent, pas d'emoji excessif, conclusion avec une invitation à l'échange plutôt qu'un simple lien.`;

      case 'tiktok':
        return `${base}\n\nRédige un script vidéo TikTok : d'abord un "hook" (accroche des 2 premières secondes, une seule phrase très courte et percutante, jamais plus de 10 mots), puis un script en 3 à 4 plans numérotés au format "Plan 1 — description de l'action à l'écran". L'ensemble doit tenir en 15 à 30 secondes à l'oral.`;

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
