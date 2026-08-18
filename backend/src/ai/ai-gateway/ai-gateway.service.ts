import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from '../../plans/entitlements.service';
import { creditCostFor } from '../../plans/plan-catalog';
import { MockProvider } from './providers/mock.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GoogleVeoProvider } from './providers/google-veo.provider';
import { RunwayProvider } from './providers/runway.provider';
import { FluxProvider } from './providers/flux.provider';
import { IdeogramProvider } from './providers/ideogram.provider';
import {
  AiProvider,
  GenerateTextParams,
  GenerateImageParams,
  GenerateVideoParams,
  GenerateAudioParams,
  TranscribeAudioParams,
  AnalyzeImageParams,
  ModerateTextResult,
  AiGenerationResult,
} from './providers/ai-provider.interface';

// Contexte obligatoire sur CHAQUE appel — c'est ce qui rend le tracking exhaustif possible :
// impossible d'appeler un fournisseur d'IA depuis ce Gateway sans dire pour quelle
// organisation et dans quel but (purpose), qui déterminent quotas et coût en crédits.
export interface AiCallContext {
  organizationId: string;
  campaignId?: string;
  purpose: 'campaign_generation' | 'moderation' | 'brand_consistency' | 'optimizer';
}

type TaskType = 'generateText' | 'generateImage' | 'generateVideo' | 'generateAudio' | 'transcribeAudio' | 'analyzeImage';

// AI Gateway : interface unique vers tous les fournisseurs d'IA (cf. chapitre 10.5) —
// ET point de passage OBLIGÉ pour la traçabilité économique de chaque appel (coût, tokens,
// durée, fournisseur) ainsi que pour l'application des quotas/budgets. Avant ce chantier,
// ModerationService et BrandConsistencyService appelaient les fournisseurs directement en
// `fetch()`, rendant leur coût réel invisible — ce Gateway est maintenant le SEUL chemin
// autorisé vers un fournisseur d'IA dans toute l'application (cf. README, section "Économie
// de l'IA").
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly providers: Map<string, AiProvider>;

  // Chaînes de repli par type de tâche : ordre de préférence par défaut (coût/qualité),
  // affiné dynamiquement par la fiabilité récente observée (cf. reliabilityAdjustedOrder).
  private readonly fallbackChains: Record<TaskType, string[]> = {
    generateText: ['openai', 'anthropic', 'mock'],
    generateImage: ['flux', 'ideogram', 'openai', 'mock'],
    // runway APRÈS google-veo : Veo reste le fournisseur préféré (texte seul, pas besoin
    // d'attendre le visuel), Runway un vrai repli fonctionnel (pas juste mock) quand Veo est
    // indisponible — cf. RunwayProvider.
    generateVideo: ['google-veo', 'runway', 'mock'],
    // Un seul fournisseur voix off pour l'instant (OpenAI TTS) — pas d'alternative câblée,
    // contrairement aux autres tâches (repli sur un deuxième fournisseur réel avant mock).
    generateAudio: ['openai', 'mock'],
    // Sert uniquement à horodater la narration déjà générée (sous-titres) — même fournisseur
    // unique que generateAudio, pas d'alternative câblée.
    transcribeAudio: ['openai', 'mock'],
    analyzeImage: ['openai', 'mock'],
  };

  // Cache en mémoire du taux d'échec récent par fournisseur — évite de recalculer à chaque
  // appel (une requête d'agrégation par appel serait un coût en soi). TTL volontairement
  // court : une dégradation de fiabilité doit se refléter rapidement dans le routage.
  private reliabilityCache: { computedAt: number; failureRates: Map<string, number> } | null = null;
  private static readonly RELIABILITY_CACHE_TTL_MS = 60_000;
  private static readonly RELIABILITY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
  private static readonly RELIABILITY_MIN_SAMPLES = 5;
  private static readonly RELIABILITY_DEMOTE_THRESHOLD = 0.4; // 40% d'échec

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly mockProvider: MockProvider,
    private readonly openAiProvider: OpenAiProvider,
    private readonly anthropicProvider: AnthropicProvider,
    private readonly googleVeoProvider: GoogleVeoProvider,
    private readonly runwayProvider: RunwayProvider,
    private readonly fluxProvider: FluxProvider,
    private readonly ideogramProvider: IdeogramProvider,
  ) {
    this.providers = new Map<string, AiProvider>([
      ['mock', this.mockProvider],
      ['openai', this.openAiProvider],
      ['anthropic', this.anthropicProvider],
      ['google-veo', this.googleVeoProvider],
      ['runway', this.runwayProvider],
      ['flux', this.fluxProvider],
      ['ideogram', this.ideogramProvider],
    ]);
  }

  private useMock(): boolean {
    return this.config.get<string>('AI_MODE', 'mock') === 'mock';
  }

  async generateText(ctx: AiCallContext, params: GenerateTextParams, providerName?: string, promptVersion?: string): Promise<AiGenerationResult> {
    return this.executeTracked(ctx, 'generateText', providerName, params.prompt, promptVersion, (p) => p.generateText!(params));
  }

  async generateImage(ctx: AiCallContext, params: GenerateImageParams, providerName?: string, promptVersion?: string): Promise<AiGenerationResult> {
    return this.executeTracked(ctx, 'generateImage', providerName, params.prompt, promptVersion, (p) => p.generateImage!(params));
  }

  async generateVideo(ctx: AiCallContext, params: GenerateVideoParams, providerName?: string, promptVersion?: string): Promise<AiGenerationResult> {
    return this.executeTracked(ctx, 'generateVideo', providerName, params.prompt, promptVersion, (p) => p.generateVideo!(params));
  }

  async generateAudio(ctx: AiCallContext, params: GenerateAudioParams, providerName?: string, promptVersion?: string): Promise<AiGenerationResult> {
    return this.executeTracked(ctx, 'generateAudio', providerName, params.prompt, promptVersion, (p) => p.generateAudio!(params));
  }

  // Pas de "prompt" texte naturel ici (l'entrée est de l'audio, pas du texte) — libellé de log
  // fixe plutôt que de forcer un texte artificiel. Pas de promptVersion non plus pour la même
  // raison : rien à versionner, aucun template de prompt n'entre en jeu.
  async transcribeAudio(ctx: AiCallContext, params: TranscribeAudioParams, providerName?: string): Promise<AiGenerationResult> {
    return this.executeTracked(ctx, 'transcribeAudio', providerName, '[transcription narration]', undefined, (p) => p.transcribeAudio!(params));
  }

  async analyzeImage(ctx: AiCallContext, params: AnalyzeImageParams, providerName?: string, promptVersion?: string): Promise<AiGenerationResult> {
    return this.executeTracked(ctx, 'analyzeImage', providerName, params.prompt, promptVersion, (p) => p.analyzeImage!(params));
  }

  // Modération : forme de réponse différente (pas de "content" généré), donc tracking dédié
  // plutôt que de forcer ModerateTextResult dans AiGenerationResult. Toujours journalisé,
  // jamais facturé en crédits (cf. CREDIT_COSTS.moderation.moderateText = 0).
  async moderateText(ctx: AiCallContext, text: string, promptVersion?: string): Promise<ModerateTextResult> {
    const provider = this.useMock() ? this.mockProvider : this.openAiProvider;

    const generation = await this.prisma.aiGeneration.create({
      data: {
        organizationId: ctx.organizationId,
        campaignId: ctx.campaignId,
        purpose: ctx.purpose,
        taskType: 'moderateText',
        provider: provider.name,
        model: 'moderation-api',
        prompt: text.slice(0, 500), // tronqué : évite de stocker un texte arbitrairement long
        promptVersion,
        status: 'RUNNING',
      },
    });

    try {
      const result = await provider.moderateText!(text);
      await this.prisma.aiGeneration.update({
        where: { id: generation.id },
        data: { status: 'SUCCEEDED', costEstimate: 0 },
      });
      return result;
    } catch (error) {
      await this.prisma.aiGeneration.update({
        where: { id: generation.id },
        data: { status: 'FAILED', errorMessage: String(error) },
      });
      throw error;
    }
  }

  // Cœur du tracking : construit la chaîne de fournisseurs à tenter (préférence explicite +
  // repli, ajustée par la fiabilité récente), vérifie budgets/quotas AVANT tout appel,
  // journalise systématiquement (PENDING -> SUCCEEDED/FAILED), et crédite la consommation.
  private async executeTracked(
    ctx: AiCallContext,
    taskType: TaskType,
    providerName: string | undefined,
    promptForLog: string,
    promptVersion: string | undefined,
    call: (p: AiProvider) => Promise<AiGenerationResult>,
  ): Promise<AiGenerationResult> {
    // Garde-fous économiques AVANT tout appel payant — cf. EntitlementsService.
    await this.entitlements.assertCreditsAvailable(ctx.organizationId);
    await this.entitlements.assertBudgetAvailable(ctx.organizationId);

    // Plafonds dédiés (essai gratuit) : une vidéo (150 crédits) épuiserait à elle seule le
    // pool de crédits de l'essai (60) — ces vérifications distinctes garantissent "10 images
    // ET 1 vidéo incluses" indépendamment du solde de crédits restant. No-op sur les plans
    // payants (maxImages/maxVideos = null). N'agit que sur la génération de campagne : les
    // appels analyzeImage (modération, cohérence de marque) ne consomment jamais ces quotas.
    if (taskType === 'generateImage' && ctx.purpose === 'campaign_generation') {
      await this.entitlements.assertImageQuotaAvailable(ctx.organizationId);
    }
    if (taskType === 'generateVideo' && ctx.purpose === 'campaign_generation') {
      await this.entitlements.assertVideoQuotaAvailable(ctx.organizationId);
    }

    const attemptOrder = await this.buildAttemptOrder(taskType, providerName);

    const generation = await this.prisma.aiGeneration.create({
      data: {
        organizationId: ctx.organizationId,
        campaignId: ctx.campaignId,
        purpose: ctx.purpose,
        taskType,
        provider: attemptOrder[0] ?? 'unknown',
        model: 'pending',
        prompt: promptForLog.slice(0, 2000),
        promptVersion,
        status: 'RUNNING',
      },
    });

    let lastError: unknown;
    for (const name of attemptOrder) {
      const provider = this.providers.get(name);
      if (!provider) continue;
      try {
        const result = await call(provider);

        await this.prisma.aiGeneration.update({
          where: { id: generation.id },
          data: {
            status: 'SUCCEEDED',
            provider: result.provider,
            model: result.model,
            tokensUsed: result.tokensUsed,
            costEstimate: result.costEstimate,
            durationMs: result.durationMs,
            // generateAudio/transcribeAudio exclus comme generateText/analyzeImage : leur
            // "content" est respectivement un data URI base64 (potentiellement volumineux) et
            // du JSON structuré (segments) — ni l'un ni l'autre n'est une URL hébergée, jamais
            // adaptés à une colonne de traçabilité prévue pour ça.
            resultUrl: ['generateText', 'analyzeImage', 'generateAudio', 'transcribeAudio'].includes(taskType) ? null : result.content,
          },
        });

        const creditCost = creditCostFor(ctx.purpose, taskType);
        if (creditCost > 0) {
          // Priorité au solde de packs achetés (extraCredits) avant d'entamer le quota
          // mensuel du plan — cf. EntitlementsService.consumeCredits pour le détail du
          // correctif (les packs ne doivent ni disparaître au renouvellement, ni se
          // reconduire indéfiniment en gonflant le quota de base).
          await this.entitlements.consumeCredits(ctx.organizationId, creditCost);
        }

        return { ...result, generationId: generation.id };
      } catch (error) {
        lastError = error;
        this.logger.warn(`Échec du fournisseur "${name}" pour "${taskType}" (${ctx.purpose}): ${error}. Tentative suivante.`);
      }
    }

    await this.prisma.aiGeneration.update({
      where: { id: generation.id },
      data: { status: 'FAILED', errorMessage: String(lastError) },
    });
    this.logger.error(`Tous les fournisseurs ont échoué pour "${taskType}" (${ctx.purpose}). Dernière erreur: ${lastError}`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async buildAttemptOrder(taskType: TaskType, providerName?: string): Promise<string[]> {
    if (this.useMock()) return ['mock'];

    // Correction de l'audit : 'mock' figurait dans fallbackChains pour TOUS les types de
    // tâche (texte, image, vidéo, vision), donc restait un repli valide même en production
    // (AI_MODE != 'mock') dès que les vrais fournisseurs échouaient tous. Conséquence
    // concrète pour la vidéo : un échec de Google Veo (token expiré, quota, panne) basculait
    // silencieusement sur une URL factice (https://example.com/mock-video.mp4), facturée
    // 150 crédits et marquée SUCCEEDED, indiscernable d'une vraie vidéo pour le validateur.
    // Le mock ne doit JAMAIS servir de contenu final hors développement/tests explicites
    // (AI_MODE=mock, cas traité juste au-dessus) — un échec réel doit remonter comme tel,
    // géré par CampaignGenerationProcessor (statut FAILED, retry) plutôt que masqué.
    const baseChain = this.fallbackChains[taskType].filter((p) => p !== 'mock');
    const chain = providerName ? [providerName, ...baseChain.filter((p) => p !== providerName)] : [...baseChain];

    return this.reliabilityAdjustedOrder(chain);
  }

  // Optimisation du choix de provider (économie de l'IA, volet 3) : rétrograde en fin de
  // liste tout fournisseur dont le taux d'échec récent dépasse le seuil, sur un échantillon
  // suffisant pour être significatif. Ne l'exclut jamais complètement (il peut s'être
  // rétabli) — seulement après les fournisseurs plus fiables dans l'ordre de tentative.
  // Exception documentée au principe d'isolation multi-tenant : cette lecture est globale
  // (tous tenants confondus) car elle porte sur la fiabilité opérationnelle d'un fournisseur,
  // pas sur des données appartenant à une organisation — aucune donnée tenant n'est exposée.
  private async reliabilityAdjustedOrder(chain: string[]): Promise<string[]> {
    const failureRates = await this.getRecentFailureRates();
    const unreliable = chain.filter((name) => (failureRates.get(name) ?? 0) >= AiGatewayService.RELIABILITY_DEMOTE_THRESHOLD);
    if (unreliable.length === 0) return chain;

    const reliable = chain.filter((name) => !unreliable.includes(name));
    return [...reliable, ...unreliable];
  }

  private async getRecentFailureRates(): Promise<Map<string, number>> {
    const now = Date.now();
    if (this.reliabilityCache && now - this.reliabilityCache.computedAt < AiGatewayService.RELIABILITY_CACHE_TTL_MS) {
      return this.reliabilityCache.failureRates;
    }

    const since = new Date(now - AiGatewayService.RELIABILITY_WINDOW_MS);
    const rows = await this.prisma.aiGeneration.groupBy({
      by: ['provider', 'status'],
      where: { createdAt: { gte: since }, status: { in: ['SUCCEEDED', 'FAILED'] } },
      _count: { _all: true },
    });

    const totals = new Map<string, { success: number; failure: number }>();
    for (const row of rows) {
      const entry = totals.get(row.provider) ?? { success: 0, failure: 0 };
      if (row.status === 'SUCCEEDED') entry.success += row._count._all;
      else entry.failure += row._count._all;
      totals.set(row.provider, entry);
    }

    const failureRates = new Map<string, number>();
    for (const [provider, { success, failure }] of totals) {
      const total = success + failure;
      if (total >= AiGatewayService.RELIABILITY_MIN_SAMPLES) {
        failureRates.set(provider, failure / total);
      }
    }

    this.reliabilityCache = { computedAt: now, failureRates };
    return failureRates;
  }
}
