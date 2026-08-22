import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { CreativeConcept } from './creative-concept.types';

const MIN_VARIATIONS = 2;
const MAX_VARIATIONS = 3;
const DEFAULT_VARIATIONS = 3;

// P0.12 — Creative Variation (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Itère SUR UN CONCEPT DÉJÀ APPROUVÉ — jamais une nouvelle passe Creative
// Intelligence/Concept depuis zéro, jamais de rendu vidéo automatique pour chaque variante
// (règle explicite du brief : "NE PAS multiplier immédiatement les générations coûteuses").
// Un seul appel texte, quel que soit le nombre de variantes demandées.
@Injectable()
export class CreativeVariationService {
  private readonly logger = new Logger(CreativeVariationService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async generateVariations(ctx: AiCallContext, acceptedConcept: CreativeConcept, count = DEFAULT_VARIATIONS): Promise<CreativeConcept[]> {
    const clampedCount = Math.min(MAX_VARIATIONS, Math.max(MIN_VARIATIONS, count));
    const prompt = this.promptEngine.render(PromptTask.CREATIVE_VARIATION, { acceptedConcept, count: clampedCount });
    // Bug réel constaté en conditions réelles (2026-08-21, même classe que StoryboardGateService/
    // CreativeGateService/NarrativeBlueprintService/VideoJudgeService/CreativeConceptService/
    // CreativeIntelligenceService) : sans maxTokens explicite, ce call retombe sur le défaut 4000
    // de AnthropicProvider — jusqu'à 3 concepts complets (14 champs chacun), risque réel élevé de
    // troncature JSON en sortie.
    const result = await this.aiGateway.generateText(ctx, { prompt, maxTokens: 8000 }, 'anthropic', PROMPT_VERSIONS.creativeVariation);
    return this.parse(result.content, acceptedConcept);
  }

  // Parsing défensif : une variante malformée est ignorée individuellement (pas un repli
  // intégral sur le concept d'origine) — visualDirection/format/scenesCount TOUJOURS hérités du
  // concept accepté, jamais renvoyés par le modèle (cf. contrainte du template).
  private parse(raw: string, acceptedConcept: CreativeConcept): CreativeConcept[] {
    try {
      const parsed = parseAiJson<any>(raw);
      if (!Array.isArray(parsed)) {
        this.logger.warn('Réponse de variation créative : JSON valide mais pas un tableau, aucune variante produite.');
        return [];
      }
      return parsed.filter(this.isValidVariation).map((v) => this.mergeWithAccepted(v, acceptedConcept));
    } catch (error) {
      this.logger.warn(`Réponse de variation créative non conforme au format JSON attendu, aucune variante produite: ${error}`);
      return [];
    }
  }

  private isValidVariation(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.title === 'string' && typeof v.hook === 'string' && typeof v.cta === 'string';
  }

  private mergeWithAccepted(variation: Record<string, unknown>, accepted: CreativeConcept): CreativeConcept {
    return {
      ...accepted,
      title: String(variation.title),
      concept: typeof variation.concept === 'string' ? variation.concept : accepted.concept,
      coreMessage: typeof variation.coreMessage === 'string' ? variation.coreMessage : accepted.coreMessage,
      hook: String(variation.hook),
      emotionalDirection: typeof variation.emotionalDirection === 'string' ? variation.emotionalDirection : accepted.emotionalDirection,
      storytellingApproach: typeof variation.storytellingApproach === 'string' ? variation.storytellingApproach : accepted.storytellingApproach,
      proofStrategy: typeof variation.proofStrategy === 'string' ? variation.proofStrategy : accepted.proofStrategy,
      cta: String(variation.cta),
      raw: JSON.stringify(variation),
    };
  }
}
