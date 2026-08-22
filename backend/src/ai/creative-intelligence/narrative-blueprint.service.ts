import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { CreativeConcept } from './creative-concept.types';
import { QualityTarget } from '../quality/quality-target';
import { CONCEPT_STAGE_CRITERIA, buildStageQualityRequirementsBlock } from '../quality/quality-requirements';
import { NarrativeBeat, NarrativeBlueprint } from './narrative-blueprint.types';

export interface GenerateNarrativeBlueprintParams {
  creativeConcept: CreativeConcept;
  // Mission 4.3 (Goal-First Quality Architecture, Phase 3) — même instance que celle créée en tête
  // de AiOrchestratorService.generateCampaign(), jamais recréée ici. Même stade que le Creative
  // Concept (CONCEPT_STAGE_CRITERIA) : les beats narratifs réalisent les mêmes exigences hook/
  // CTA/storytelling que le concept a déjà été construit pour satisfaire.
  qualityTarget: QualityTarget;
}

const MIN_BEAT_DURATION = 1;

// Mission 4.3 (Goal-First Quality Architecture, Phase 3, Étape 4). Même architecture que
// CreativeConceptService/CreativeIntelligenceService — service injectable dédié, jamais un appel
// gateway.generateText inline dans l'Orchestrateur (préserve les indices fixes de
// gateway.generateText.mock.calls[N] dans ai-orchestrator.service.spec.ts).
@Injectable()
export class NarrativeBlueprintService {
  private readonly logger = new Logger(NarrativeBlueprintService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async generate(ctx: AiCallContext, params: GenerateNarrativeBlueprintParams): Promise<NarrativeBlueprint> {
    const qualityRequirementsBlock = buildStageQualityRequirementsBlock(params.qualityTarget, CONCEPT_STAGE_CRITERIA);
    const prompt = this.promptEngine.render(PromptTask.NARRATIVE_BLUEPRINT, {
      creativeConcept: params.creativeConcept,
      qualityRequirementsBlock,
    });
    // Bug réel constaté en conditions réelles (2026-08-21, même classe que StoryboardGateService/
    // CreativeGateService) : sans maxTokens explicite, ce call retombait sur le défaut 4000 de
    // AnthropicProvider — insuffisant pour ce schéma (9 champs texte + pausePoints + 2-6 beats,
    // chacun avec 6 sous-champs), la réponse était tronquée avant la fin du JSON ("Unterminated
    // string in JSON"), repliée à tort sur le neutre (beats: []) — ce qui faisait ensuite échouer
    // PreFlightQualityGate (Phase 5) en aval pour un plan de tournage devenu orphelin de tout beat.
    //
    // Audit forensic (2026-08-22, campagne réelle fa26aacb...) : maxTokens réglé, mais une SEULE
    // réponse JSON syntaxiquement invalide (pas une troncature — une virgule/guillemet mal placé
    // en plein milieu du document) suffisait encore à produire un blueprint vide définitif, après
    // avoir déjà dépensé Creative Gate + Storyboard Gate + Shot Plan en amont pour rien. Ce
    // service était le SEUL de la chaîne de construction sans la discipline retry-avant-repli déjà
    // appliquée à VideoDirectorService.generateShotPlanWithRetry (audit campagne a294054e,
    // 2026-08-20) — corrigé ici à l'identique : une tentative de plus avant tout repli, jamais un
    // repli silencieux sur un JSON structurellement inexploitable.
    const first = await this.aiGateway.generateText(ctx, { prompt, maxTokens: 8000 }, 'anthropic', PROMPT_VERSIONS.narrativeBlueprint);
    const parsed = this.tryParse(first.content);
    if (parsed) return parsed;

    this.logger.warn('Narrative Blueprint non exploitable au 1er essai — nouvelle tentative avant repli neutre.');
    const retry = await this.aiGateway.generateText(ctx, { prompt, maxTokens: 8000 }, 'anthropic', PROMPT_VERSIONS.narrativeBlueprint);
    const retryParsed = this.tryParse(retry.content);
    if (retryParsed) return retryParsed;

    this.logger.warn(`Réponse Narrative Blueprint non conforme au format JSON attendu après 2 tentatives, repli neutre conservé.`);
    return this.neutralFallback(retry.content);
  }

  private tryParse(raw: string): NarrativeBlueprint | null {
    try {
      const parsed = parseAiJson<any>(raw);
      return {
        hook: this.asString(parsed.hook),
        problem: this.asString(parsed.problem),
        tension: this.asString(parsed.tension),
        reveal: this.asString(parsed.reveal),
        productIntroduction: this.asString(parsed.productIntroduction),
        benefit: this.asString(parsed.benefit),
        proof: this.asString(parsed.proof),
        emotionalPayoff: this.asString(parsed.emotionalPayoff),
        cta: this.asString(parsed.cta),
        pacing: this.asString(parsed.pacing),
        pausePoints: this.asStringArray(parsed.pausePoints),
        beats: this.asBeats(parsed.beats),
        raw,
      };
    } catch {
      return null;
    }
  }

  private neutralFallback(raw: string): NarrativeBlueprint {
    return {
      hook: '', problem: '', tension: '', reveal: '', productIntroduction: '',
      benefit: '', proof: '', emotionalPayoff: '', cta: '', pacing: '', pausePoints: [], beats: [],
      raw,
    };
  }

  private asBeats(value: unknown): NarrativeBeat[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b, i) => ({
        id: this.asString(b.id) || `beat-${i + 1}`,
        role: this.asString(b.role),
        objective: this.asString(b.objective),
        duration: this.asPositiveNumber(b.duration, MIN_BEAT_DURATION),
        requiredVisualEvidence: this.asString(b.requiredVisualEvidence),
        requiredVoiceover: this.asString(b.requiredVoiceover),
        // Toujours [] à la génération — les shots n'existent pas encore à ce stade du pipeline
        // (cf. narrative-blueprint.types.ts). Peuplé en Phase 4 (ShotExecutionCompiler).
        shotIds: [],
      }));
  }

  private asPositiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}
