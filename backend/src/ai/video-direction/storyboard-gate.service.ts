import { Injectable, Logger } from '@nestjs/common';
import { ProductIntelligenceProfile } from '@prisma/client';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { renderGroundedContext } from '../product-intelligence/product-grounding';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';
import { Shot, ShotPlan } from './video-director.service';
import { StoryboardGateResult, StoryboardGateStatus, GoalFirstRootCause } from './storyboard-gate.types';
import { QualityTarget } from '../quality/quality-target';
import { STORYBOARD_STAGE_CRITERIA, buildStageQualityRequirementsBlock } from '../quality/quality-requirements';

export interface EvaluateStoryboardGateParams {
  creativeConcept: CreativeConcept;
  shotPlan: ShotPlan;
  // Mission 4.3 (Goal-First Quality Architecture, Phase 1) — remplace STORYBOARD_GATE_THRESHOLD :
  // source unique du score cible, créée par AiOrchestratorService AVANT le Creative Concept.
  qualityTarget: QualityTarget;
  // Mission 4.3 Phase 5b — PreProductionQualityJudge (Étape 8) fusionné dans ce gate : ces 3
  // entrées lui étaient jusqu'ici invisibles (seuls creativeConcept/shotPlan bruts étaient jugés).
  narrativeBlueprint: NarrativeBlueprint;
  // Instructions RÉELLEMENT compilées pour Veo (ShotExecutionCompiler, Phase 4) — permet à ce
  // gate de juger ce que le fournisseur vidéo va recevoir, pas seulement le Shot Plan JSON brut.
  executionInstructions: { sceneId: string; prompt: string }[];
  productProfile: ProductIntelligenceProfile | null;
}

const NEUTRAL_SCORE = 50;
const MIN_SCENES_AFTER_PRUNING = 2;

// Mission 4.3 (Goal-First Quality Architecture, Phase 5b) — mapping DÉTERMINISTE d'un critère
// critique violé vers sa cause racine — jamais laissé au LLM pour cette décision précise (même
// discipline que deriveStatus dans CreativeGateService : un seuil/mapping figé en code plutôt que
// des jugements d'un modèle, incohérents d'un appel à l'autre pour un même score).
const CRITICAL_CRITERION_ROOT_CAUSE: Record<string, GoalFirstRootCause> = {
  productConsistency: 'PRODUCT',
  storytelling: 'NARRATIVE',
  ctaClarity: 'CONCEPT',
  // Mission 4.4 (Product URL Intelligence, Phase L/R) — une incohérence factuelle (ex. concept
  // annonce "1 litre" alors que la page produit confirme "750 ml") relève de la même famille que
  // productConsistency : un défaut PRODUIT, jamais narratif/conceptuel.
  factualConsistency: 'PRODUCT',
};

const VALID_ROOT_CAUSES: GoalFirstRootCause[] = ['SHOT', 'NARRATIVE', 'CONCEPT', 'PRODUCT', 'EXECUTION', 'BRAND', 'TECHNICAL'];

// Phase H — Storyboard Gate (chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 46-53). Valide le Shot Plan AVANT toute génération vidéo. Même
// convention que Phase G (CreativeGateService) : ce service ÉVALUE, AiOrchestratorService décide
// de la boucle de régénération bornée.
//
// Mission 4.3 (Goal-First Quality Architecture, Phase 5b, Étape 8-9) — ce service EST désormais
// le PreProductionQualityJudge du brief : plutôt qu'un 3e appel LLM distinct (coût additionnel
// par campagne), la porte existante est étendue en place — nouvelles entrées (NarrativeBlueprint,
// instructions d'exécution compilées, Product Intelligence), nouvelle sortie (criterionScores,
// blockingDefects, risks, requiredChanges, rootCauseLevel, readyForGeneration). La boucle de
// "redesign" (Étape 9) réutilise le mécanisme de régénération unique déjà en place dans
// AiOrchestratorService — jamais une nouvelle boucle multi-niveaux avant vidéo.
@Injectable()
export class StoryboardGateService {
  private readonly logger = new Logger(StoryboardGateService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async evaluate(ctx: AiCallContext, params: EvaluateStoryboardGateParams): Promise<StoryboardGateResult> {
    const qualityRequirementsBlock = buildStageQualityRequirementsBlock(params.qualityTarget, STORYBOARD_STAGE_CRITERIA);
    const groundedContextBlock = params.productProfile ? `\n\n${renderGroundedContext(params.productProfile)}` : '';
    const narrativeBlueprintBlock = `\n\nStructure narrative attendue (chaque plan doit servir un des beats ci-dessous, cf. narrativeBeatId) :\n${JSON.stringify(params.narrativeBlueprint.beats)}`;
    const executionInstructionsBlock = `\n\nInstructions d'exécution RÉELLEMENT compilées pour le fournisseur vidéo (juge CECI, pas seulement le Shot Plan JSON brut ci-dessus) :\n${JSON.stringify(params.executionInstructions)}`;
    const prompt = this.promptEngine.render(PromptTask.STORYBOARD_GATE, {
      creativeConcept: params.creativeConcept,
      shotPlan: params.shotPlan,
      qualityRequirementsBlock,
      narrativeBlueprintBlock,
      executionInstructionsBlock,
      groundedContextBlock,
    });
    // Mission 4.3 (Goal-First Quality Architecture, Phase 5b) — 16000, pas le défaut 4000 (cf.
    // AnthropicProvider) : bug réel constaté en conditions réelles (2026-08-21/22) — le schéma de
    // sortie v3 (criterionScores/risks/requiredChanges/rootCauseLevel, en plus du v2 existant) et
    // le prompt bien plus riche (NarrativeBlueprint + instructions d'exécution compilées par plan)
    // faisaient tronquer la réponse d'Anthropic avant la fin du JSON ("Unexpected end of JSON
    // input"), rejetée à tort comme REJECT/score neutre — un incident technique confondu avec un
    // vrai défaut de contenu. 8000 (même valeur que VideoDirectorService.SHOT_PLAN_MAX_TOKENS)
    // s'est révélé encore insuffisant en conditions réelles (2026-08-22) : contrairement au Shot
    // Plan (génération mécanique), ce gate doit RAISONNER (évaluer 10 critères pondérés + motiver
    // chaque défaut) — le thinking adaptatif de claude-sonnet-5 partage le même budget que
    // max_tokens (cf. AnthropicProvider) et consomme une part significative de ce budget rien que
    // pour l'évaluation, avant même d'écrire la réponse JSON.
    const first = await this.aiGateway.generateText(ctx, { prompt, maxTokens: 16000 }, 'anthropic', PROMPT_VERSIONS.storyboardGate);
    const parsed = this.tryParse(first.content, params.qualityTarget);
    if (parsed) return parsed;

    // Audit forensic (2026-08-22, campagne réelle da896157...) : ce gate était le seul, avec
    // NarrativeBlueprintService avant correction, sans la discipline retry-avant-repli déjà
    // établie pour VideoDirectorService.generateShotPlanWithRetry — un seul JSON mal formé
    // suffisait à un REJECT/TECHNICAL immédiat, gaspillant potentiellement l'unique régénération
    // de AiOrchestratorService pour un incident technique, pas un vrai défaut de contenu.
    this.logger.warn('Storyboard Gate non exploitable au 1er essai — nouvelle tentative avant repli REJECT/TECHNICAL.');
    const retry = await this.aiGateway.generateText(ctx, { prompt, maxTokens: 16000 }, 'anthropic', PROMPT_VERSIONS.storyboardGate);
    const retryParsed = this.tryParse(retry.content, params.qualityTarget);
    if (retryParsed) return retryParsed;

    this.logger.warn(`Réponse Storyboard Gate non conforme au format JSON attendu après 2 tentatives, repli REJECT (score neutre).`);
    return this.neutralFallback();
  }

  private tryParse(raw: string, qualityTarget: QualityTarget): StoryboardGateResult | null {
    try {
      const parsed = parseAiJson<any>(raw);
      const score = this.asScore(parsed.score);
      const criterionScores = this.asCriterionScores(parsed.criterionScores);
      const faiblesses = this.asStringArray(parsed.faiblesses);
      const recommandation = this.asString(parsed.recommandation);
      const belowTarget = parsed.verdict === 'REJECT' || score < qualityTarget.targetScore;

      const blockingDefects = belowTarget
        ? [`Score storyboard insuffisant : ${score}/100 (cible ${qualityTarget.targetScore})`, ...faiblesses]
        : [];

      // Seuil/mapping déterministes en code, jamais laissés au LLM (cf. commentaire de classe) :
      // un score global élevé ne doit JAMAIS masquer un critère critique sous son plancher (brief,
      // exemple : global=81 mais productFidelity=55 => toujours bloqué).
      const floored = this.applyCriticalFloor(
        {
          status: belowTarget ? 'REJECT' : 'APPROVED',
          blockingDefects,
          rootCauseLevel: belowTarget ? this.asRootCause(parsed.rootCauseLevel) : null,
          readyForGeneration: !belowTarget,
        },
        criterionScores,
        qualityTarget,
      );

      return {
        status: floored.status,
        score,
        scenesToRemove: this.asStringArray(parsed.scenesToRemove),
        faiblesses,
        recommandation,
        criterionScores,
        blockingDefects: floored.blockingDefects,
        risks: this.asStringArray(parsed.risks),
        requiredChanges: this.asStringArray(parsed.requiredChanges),
        rootCauseLevel: floored.rootCauseLevel,
        readyForGeneration: floored.readyForGeneration,
      };
    } catch {
      return null;
    }
  }

  // TECHNICAL, pas une autre catégorie : c'est un incident de parsing/fournisseur, jamais un vrai
  // défaut de contenu — même distinction mesure-vs-défaut déjà appliquée en Phase 6
  // (UNAVAILABLE_DEFECT dans video-judge.service.ts).
  private neutralFallback(): StoryboardGateResult {
    return {
      status: 'REJECT',
      score: NEUTRAL_SCORE,
      scenesToRemove: [],
      faiblesses: [],
      recommandation: 'Vérification indisponible — nouvelle tentative recommandée.',
      criterionScores: {},
      blockingDefects: ['Vérification indisponible — réponse du jugement non conforme au format attendu.'],
      risks: [],
      requiredChanges: [],
      rootCauseLevel: 'TECHNICAL',
      readyForGeneration: false,
    };
  }

  // Override DÉTERMINISTE : jamais l'inverse (le LLM ne peut jamais faire passer outre un plancher
  // critique violé). Ne fait que RESSERRER un résultat déjà APPROVED côté LLM — ne relâche jamais
  // un rejet LLM existant.
  private applyCriticalFloor(
    result: { status: StoryboardGateStatus; blockingDefects: string[]; rootCauseLevel: GoalFirstRootCause | null; readyForGeneration: boolean },
    criterionScores: Record<string, number>,
    qualityTarget: QualityTarget,
  ): { status: StoryboardGateStatus; blockingDefects: string[]; rootCauseLevel: GoalFirstRootCause | null; readyForGeneration: boolean } {
    const violated = qualityTarget.criticalCriteria
      .filter((criterion) => STORYBOARD_STAGE_CRITERIA.includes(criterion))
      .filter((criterion) => typeof criterionScores[criterion] === 'number' && criterionScores[criterion] < qualityTarget.minimumCriticalScore);

    if (violated.length === 0) return result;

    const blockingDefects = [
      ...result.blockingDefects,
      ...violated.map((criterion) => `Plancher critique non atteint : ${criterion} = ${criterionScores[criterion]} (minimum ${qualityTarget.minimumCriticalScore})`),
    ];
    const rootCauseLevel = CRITICAL_CRITERION_ROOT_CAUSE[violated[0]] ?? result.rootCauseLevel;

    return { status: 'REJECT', blockingDefects, rootCauseLevel, readyForGeneration: false };
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

  private asCriterionScores(value: unknown): Record<string, number> {
    const scores: Record<string, number> = {};
    if (!value || typeof value !== 'object') return scores;
    for (const criterion of STORYBOARD_STAGE_CRITERIA) {
      const raw = (value as Record<string, unknown>)[criterion];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        scores[criterion] = Math.max(0, Math.min(100, Math.round(raw)));
      }
    }
    return scores;
  }

  private asRootCause(value: unknown): GoalFirstRootCause | null {
    return typeof value === 'string' && (VALID_ROOT_CAUSES as string[]).includes(value) ? (value as GoalFirstRootCause) : null;
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
