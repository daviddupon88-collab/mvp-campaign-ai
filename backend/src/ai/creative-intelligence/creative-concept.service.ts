import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { CreativeIntelligence } from './creative-intelligence.types';
import { CreativeConcept } from './creative-concept.types';

export interface GenerateCreativeConceptParams {
  creativeIntelligence: CreativeIntelligence;
  // Phase G — présent uniquement lors de l'unique régénération déclenchée par un verdict REVISE
  // du Creative Gate (cf. creative-gate.service.ts).
  gateFeedback?: string;
}

// Cadrage du nombre de scènes — [2,5] : en dessous de 2, pas de vraie narration (accroche +
// résolution minimales) ; au-dessus de 5, chaque plan coûte un appel generateVideo (150 crédits,
// cf. CostControlService) et devient difficile à justifier individuellement (cf. Phase 6, "chaque
// shot doit avoir une raison d'exister"). Repli 3 = comportement historique inchangé en cas
// d'échec de parsing (l'ancien défaut de generateShotPlan avant ce chantier).
const MIN_SCENES = 2;
const MAX_SCENES = 5;
const DEFAULT_SCENES_COUNT = 3;
const DEFAULT_DURATION_SECONDS = 15;

// P0.2 — Creative Concept (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Transforme la Creative Intelligence (P0.1) en une vraie idée publicitaire
// structurée, qui pilote ensuite le Shot Plan (P0.3) — le concept doit démontrer, pas décrire
// (cf. exemple mauvais/bon embarqué dans le template).
@Injectable()
export class CreativeConceptService {
  private readonly logger = new Logger(CreativeConceptService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async generate(ctx: AiCallContext, params: GenerateCreativeConceptParams): Promise<CreativeConcept> {
    const prompt = this.promptEngine.render(PromptTask.VIDEO_CONCEPT, { creativeIntelligence: params.creativeIntelligence, gateFeedback: params.gateFeedback });
    const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic', PROMPT_VERSIONS.videoConcept);
    return this.parse(result.content);
  }

  private parse(raw: string): CreativeConcept {
    try {
      const parsed = parseAiJson<any>(raw);
      return {
        title: this.asString(parsed.title),
        concept: this.asString(parsed.concept),
        coreMessage: this.asString(parsed.coreMessage),
        hook: this.asString(parsed.hook),
        emotionalDirection: this.asString(parsed.emotionalDirection),
        visualDirection: this.asString(parsed.visualDirection),
        storytellingApproach: this.asString(parsed.storytellingApproach),
        proofStrategy: this.asString(parsed.proofStrategy),
        cta: this.asString(parsed.cta),
        targetAudience: this.asString(parsed.targetAudience),
        duration: this.asPositiveNumber(parsed.duration, DEFAULT_DURATION_SECONDS),
        format: '9:16',
        scenesCount: this.clampScenesCount(parsed.scenesCount),
        raw,
      };
    } catch (error) {
      this.logger.warn(`Réponse Creative Concept non conforme au format JSON attendu, repli neutre conservé: ${error}`);
      return {
        title: '',
        concept: '',
        coreMessage: '',
        hook: '',
        emotionalDirection: '',
        visualDirection: '',
        storytellingApproach: '',
        proofStrategy: '',
        cta: '',
        targetAudience: '',
        duration: DEFAULT_DURATION_SECONDS,
        format: '9:16',
        scenesCount: DEFAULT_SCENES_COUNT,
        raw,
      };
    }
  }

  private clampScenesCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SCENES_COUNT;
    return Math.min(MAX_SCENES, Math.max(MIN_SCENES, Math.round(value)));
  }

  private asPositiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
