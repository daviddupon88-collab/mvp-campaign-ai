import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { Shot, ShotPlan } from './video-director.service';
import { StoryboardGateResult, StoryboardGateStatus } from './storyboard-gate.types';

export interface EvaluateStoryboardGateParams {
  creativeConcept: CreativeConcept;
  shotPlan: ShotPlan;
}

const STORYBOARD_GATE_THRESHOLD = 75;
const NEUTRAL_SCORE = 50;
const MIN_SCENES_AFTER_PRUNING = 2;

// Phase H — Storyboard Gate (chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 46-53). Valide le Shot Plan AVANT toute génération vidéo. Même
// convention que Phase G (CreativeGateService) : ce service ÉVALUE, AiOrchestratorService décide
// de la boucle de régénération bornée.
@Injectable()
export class StoryboardGateService {
  private readonly logger = new Logger(StoryboardGateService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async evaluate(ctx: AiCallContext, params: EvaluateStoryboardGateParams): Promise<StoryboardGateResult> {
    const prompt = this.promptEngine.render(PromptTask.STORYBOARD_GATE, { creativeConcept: params.creativeConcept, shotPlan: params.shotPlan });
    const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic', PROMPT_VERSIONS.storyboardGate);
    return this.parse(result.content);
  }

  private parse(raw: string): StoryboardGateResult {
    try {
      const parsed = parseAiJson<any>(raw);
      const score = this.asScore(parsed.score);
      const status: StoryboardGateStatus = parsed.verdict === 'REJECT' || score < STORYBOARD_GATE_THRESHOLD ? 'REJECT' : 'APPROVED';

      return {
        status,
        score,
        scenesToRemove: this.asStringArray(parsed.scenesToRemove),
        faiblesses: this.asStringArray(parsed.faiblesses),
        recommandation: this.asString(parsed.recommandation),
      };
    } catch (error) {
      this.logger.warn(`Réponse Storyboard Gate non conforme au format JSON attendu, repli REJECT (score neutre) : ${error}`);
      return { status: 'REJECT', score: NEUTRAL_SCORE, scenesToRemove: [], faiblesses: [], recommandation: 'Vérification indisponible — nouvelle tentative recommandée.' };
    }
  }

  private asScore(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : NEUTRAL_SCORE;
  }

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}

function isHookShot(shot: Shot): boolean {
  return (shot.narrativeRole ?? '').toLowerCase().includes('hook');
}

function carriesText(shot: Shot): boolean {
  return Boolean(shot.onScreenText?.trim()) || Boolean(shot.voiceover?.trim());
}

// Élagage (spec Sections 47-48, 56) — fonction PURE, jamais laissée au LLM : le hook et le CTA
// sont les deux éléments dont la spec interdit explicitement la suppression, même si le Storyboard
// Gate les recommande. Repli déterministe si aucun plan n'est explicitement marqué : le premier
// plan protège le hook implicite, le dernier plan porteur de texte protège le CTA implicite.
export function applySafePruning(shotPlan: ShotPlan, scenesToRemove: string[]): ShotPlan {
  if (scenesToRemove.length === 0) return shotPlan;

  const hookSceneIds = new Set(shotPlan.filter(isHookShot).map((s) => s.sceneId));
  const textCarryingSceneIds = shotPlan.filter(carriesText).map((s) => s.sceneId);
  const ctaSceneId = textCarryingSceneIds.length > 0 ? textCarryingSceneIds[textCarryingSceneIds.length - 1] : shotPlan[shotPlan.length - 1]?.sceneId;

  const protectedIds = new Set<string>(ctaSceneId ? [ctaSceneId] : []);
  for (const id of hookSceneIds) protectedIds.add(id);
  if (hookSceneIds.size === 0 && shotPlan[0]) protectedIds.add(shotPlan[0].sceneId);

  const safeToRemove = scenesToRemove.filter((id) => !protectedIds.has(id));
  const remainingCount = shotPlan.length - safeToRemove.length;
  const finalToRemove = remainingCount >= MIN_SCENES_AFTER_PRUNING ? safeToRemove : safeToRemove.slice(0, Math.max(0, shotPlan.length - MIN_SCENES_AFTER_PRUNING));

  return shotPlan.filter((s) => !finalToRemove.includes(s.sceneId));
}
