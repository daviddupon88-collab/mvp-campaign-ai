import { Injectable, Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ProductIntelligenceProfile } from '@prisma/client';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { TranscriptSegment } from '../ai-gateway/providers/ai-provider.interface';
import { VisualDna } from '../video-direction/visual-dna.service';
import { ShotQualityResult } from '../video-direction/video-analyzer.service';
import { ShotPlan } from '../video-direction/video-director.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { renderGroundedContext } from '../product-intelligence/product-grounding';
import {
  JudgeCriterionName,
  JudgeCriterionResult,
  VideoJudgeResult,
  JudgeSubScore,
  VISUAL_QUALITY_CRITERIA,
  ADVERTISING_EFFECTIVENESS_CRITERIA,
  CRITICAL_CRITERIA,
  CRITICAL_FLOOR,
  WEIGHTS,
  UNAVAILABLE_DEFECT,
  SceneConsistencyDefect,
} from './video-judge.types';
import { measureRmsWindows, computeStdDev, classifyAcousticDynamics, scoreAcousticDynamics } from './acoustic-measurement';
import { computeVoicePacing, VOICE_PACING_MIN_WORDS_PER_SECOND, VOICE_PACING_MAX_WORDS_PER_SECOND } from './voice-pacing';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

// Mission 4 Phase A — un échantillon cropdetect : ratio d'occupation du cadre + horodatage
// (pour l'attribution à un plan précis, cf. attributeCompositionDefect/shotAtTime).
interface CropSample {
  ratio: number;
  ptsTime: number;
}

export interface JudgeParams {
  finalVideoBuffer: Buffer;
  narrationBuffer: Buffer | null; // null si narration indisponible (dégradation existante, cf. VideoFinalizationService)
  shotPlan: ShotPlan;
  perShotQuality: Map<string, ShotQualityResult>;
  visualDna: VisualDna;
  concept: CreativeConcept;
  transcript: TranscriptSegment[] | null;
  productProfile: ProductIntelligenceProfile | null;
}

// Abaissé temporairement de 75 à 62 (demande explicite utilisateur, 2026-08-19) — les scores
// réels observés en production tournent autour de 66-69 avec un contenu honnête et cohérent
// (aucun défaut critique détecté), le seuil à 75 rejetait donc des vidéos correctes. Le plancher
// critique (CRITICAL_FLOOR, cf. ci-dessus) reste inchangé — seul le score global moyen est assoupli.
// Exportée (Phase C, chantier V2, 2026-08-19) : repair-priority.ts en a besoin comme borne
// CRITIQUE/IMPORTANT vs MINEUR (spec Section 5), sans dupliquer cette valeur.
export const PASS_THRESHOLD = 62;

// Phase D (Règle 2 du spec V2 : "l'efficacité publicitaire prime sur l'esthétique") — plancher
// INDÉPENDANT sur le sous-score publicitaire, en plus de PASS_THRESHOLD sur le score global.
// Empêche exactement le cas d'école du spec : qualité visuelle 88, efficacité publicitaire 57 →
// échec, même si le score global pondéré resterait au-dessus de PASS_THRESHOLD. Valeur de départ
// documentée (au-dessus de l'exemple 57 du spec), à recalibrer avec des données réelles — même
// discipline que WEIGHTS ci-dessus, jamais une spec figée.
const ADVERTISING_FLOOR = 60;

// Cible du mixage final (cf. VideoAssemblyService : loudnorm I=-16) — sert de référence pour
// juger si le mixage a réellement convergé, pas une mesure indépendante inventée ici.
const TARGET_LUFS = -16;
const LUFS_TOLERANCE = 4;
const NEUTRAL_SCORE = 50;

// P0.5 — Video Judge (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Regarde la vidéo FINALE ASSEMBLÉE (pas un plan isolé, cf. VideoAnalyzerService
// qui reste inchangé et continue de juger chaque clip brut PENDANT sa génération) — jamais un
// succès automatique parce qu'un provider a renvoyé un fichier. 15 critères, mais SEULEMENT 2
// appels IA (1 vision + 1 texte groupé) : les autres sont déjà calculés (agrégation des scores
// par plan) ou mesurés déterministiquement (ffmpeg).
@Injectable()
export class VideoJudgeService {
  private readonly logger = new Logger(VideoJudgeService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async judge(ctx: AiCallContext, params: JudgeParams): Promise<VideoJudgeResult> {
    const [aggregated, audio, voiceDynamism, visionCriteria, formatCompliance, sceneConsistency, textCriteria] = await Promise.all([
      this.buildAggregatedCriteria(params.perShotQuality),
      this.buildAudioCriteria(params.finalVideoBuffer, params.narrationBuffer),
      this.buildVoiceDynamismCriterion(params.narrationBuffer),
      this.buildVisionCriteria(ctx, params.finalVideoBuffer, params.visualDna),
      this.buildFormatComplianceCriterion(params.finalVideoBuffer, params.shotPlan),
      this.buildSceneConsistencyCriterion(ctx, params.finalVideoBuffer, params.shotPlan),
      this.buildTextCriteria(ctx, params),
    ]);
    const voicePacing = this.buildVoicePacingCriterion(params.transcript);

    const criteria: JudgeCriterionResult[] = [
      ...aggregated,
      ...audio,
      voiceDynamism,
      voicePacing,
      ...visionCriteria,
      formatCompliance,
      sceneConsistency,
      ...textCriteria,
    ];

    const globalScore = this.computeGlobalScore(criteria);
    const visualQuality = this.computeSubScore(criteria, VISUAL_QUALITY_CRITERIA);
    const advertisingEffectiveness = this.computeSubScore(criteria, ADVERTISING_EFFECTIVENESS_CRITERIA);
    // Audit forensique Mission 4.2 (P0-3) : un critère UNAVAILABLE_DEFECT (panne de mesure, pas un
    // vrai défaut) ne doit jamais, à lui seul, déclencher un échec critique — un critère
    // VÉRITABLEMENT absent du tableau reste fail-closed (échec par défaut), comportement inchangé.
    const criticalFailure = CRITICAL_CRITERIA.some((name) => {
      const c = criteria.find((cr) => cr.name === name);
      if (!c) return true;
      if (c.defect === UNAVAILABLE_DEFECT) return false;
      return c.score < CRITICAL_FLOOR;
    });
    // Le plancher publicitaire n'est opposable que s'il existe une vraie donnée mesurée — sinon
    // une panne du seul appel Judge texte groupé (les 6 critères d'advertisingEffectiveness en
    // dépendent tous) ferait échouer une vidéo par ailleurs saine, purement à cause d'une panne de
    // mesure (audit forensique Mission 4.2, P0-3).
    const verdict: VideoJudgeResult['verdict'] =
      globalScore >= PASS_THRESHOLD &&
      !criticalFailure &&
      (!advertisingEffectiveness.dataAvailable || advertisingEffectiveness.score >= ADVERTISING_FLOOR)
        ? 'PASS'
        : 'REPAIR_REQUIRED';

    return { criteria, globalScore, visualQuality, advertisingEffectiveness, verdict };
  }

  // Renormalisé sur le poids RÉELLEMENT disponible (critères UNAVAILABLE_DEFECT exclus) plutôt
  // que sur 100 fixe — quand rien n'est indisponible, WEIGHTS somme à 100 par convention et le
  // résultat est identique à l'ancien calcul ; quand une partie est indisponible, le score reflète
  // uniquement ce qui a pu être réellement mesuré au lieu d'être tiré vers NEUTRAL_SCORE (audit
  // forensique Mission 4.2, P0-3).
  private computeGlobalScore(criteria: JudgeCriterionResult[]): number {
    const available = criteria.filter((c) => c.defect !== UNAVAILABLE_DEFECT);
    const totalWeight = available.reduce((sum, c) => sum + (WEIGHTS[c.name] ?? 0), 0);
    const weightedSum = available.reduce((sum, c) => sum + c.score * (WEIGHTS[c.name] ?? 0), 0);
    return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : NEUTRAL_SCORE;
  }

  // Sous-score = moyenne pondérée UNIQUEMENT sur le sous-ensemble de critères concerné (hors
  // UNAVAILABLE_DEFECT, même exclusion que computeGlobalScore et que
  // quality-report.ts::computeComponentScore — audit forensique Mission 4.2, P0-3), poids
  // renormalisés à l'intérieur du groupe.
  private computeSubScore(criteria: JudgeCriterionResult[], group: JudgeCriterionName[]): JudgeSubScore {
    const groupCriteria = criteria.filter((c) => group.includes(c.name) && c.defect !== UNAVAILABLE_DEFECT);
    const totalWeight = groupCriteria.reduce((sum, c) => sum + (WEIGHTS[c.name] ?? 0), 0);
    const weightedSum = groupCriteria.reduce((sum, c) => sum + c.score * (WEIGHTS[c.name] ?? 0), 0);
    const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : NEUTRAL_SCORE;
    return { score, criteria: group, dataAvailable: totalWeight > 0 };
  }

  // productConsistency / motionDynamism : moyenne des scores déjà calculés PENDANT la
  // génération de chaque plan (VideoAnalyzerService) — coût IA nul, pure agrégation.
  private buildAggregatedCriteria(perShotQuality: Map<string, ShotQualityResult>): JudgeCriterionResult[] {
    if (perShotQuality.size === 0) {
      return [
        { name: 'productConsistency', score: NEUTRAL_SCORE, justification: 'Aucune donnée de fidélité par plan disponible.', defect: UNAVAILABLE_DEFECT },
        { name: 'motionDynamism', score: NEUTRAL_SCORE, justification: 'Aucune donnée de mouvement par plan disponible.', defect: UNAVAILABLE_DEFECT },
      ];
    }

    const scores = Array.from(perShotQuality.values());
    const motionDynamismCriterion = this.buildMotionDynamismCriterion(scores);

    // Audit forensique Mission 4.2 (P0-1) : un plan dont l'ADN visuel de référence était lui-même
    // un repli (VideoAnalyzerService retourne alors dataAvailable:false) ne doit jamais peser dans
    // la moyenne de fidélité — sinon ce plan "vote" un score fabriqué (NEUTRAL_FIDELITY_SCORE)
    // qui masque l'indisponibilité réelle de la mesure, exactement le défaut que P0-3 corrige déjà
    // pour les critères Judge eux-mêmes.
    const fidelityScores = scores.filter((q) => q.visualFidelity.dataAvailable !== false);
    if (fidelityScores.length === 0) {
      return [
        {
          name: 'productConsistency',
          score: NEUTRAL_SCORE,
          justification: "ADN visuel de référence indisponible sur l'ensemble des plans — fidélité non mesurable.",
          defect: UNAVAILABLE_DEFECT,
        },
        motionDynamismCriterion,
      ];
    }

    const avgFidelity = Math.round(fidelityScores.reduce((s, q) => s + q.visualFidelity.score, 0) / fidelityScores.length);
    const worstFidelity = fidelityScores.reduce((worst, q) => (q.visualFidelity.score < worst.visualFidelity.score ? q : worst));
    const partialNote = fidelityScores.length < scores.length ? ` (${scores.length - fidelityScores.length} plan(s) exclu(s), ADN visuel indisponible)` : '';

    return [
      {
        name: 'productConsistency',
        score: avgFidelity,
        justification: `Moyenne de la fidélité visuelle mesurée sur ${fidelityScores.length} plan(s) pendant leur génération.${partialNote}`,
        ...(avgFidelity < CRITICAL_FLOOR ? { defect: worstFidelity.visualFidelity.reasons.join('; ') || 'Fidélité visuelle insuffisante' } : {}),
      },
      motionDynamismCriterion,
    ];
  }

  private buildMotionDynamismCriterion(scores: ShotQualityResult[]): JudgeCriterionResult {
    const avgMotion = Math.round(scores.reduce((s, q) => s + q.motionQuality.score, 0) / scores.length);
    const worstMotion = scores.reduce((worst, q) => (q.motionQuality.score < worst.motionQuality.score ? q : worst));
    return {
      name: 'motionDynamism',
      score: avgMotion,
      justification: `Moyenne du mouvement mesuré (ffmpeg freezedetect) sur ${scores.length} plan(s).`,
      ...(avgMotion < CRITICAL_FLOOR ? { defect: worstMotion.motionQuality.reasons.join('; ') || 'Mouvement insuffisant' } : {}),
    };
  }

  // audioQuality / voiceAudibility : mesure ffmpeg loudnorm (déterministe, coût IA nul) — sur le
  // mixage final pour audioQuality (a-t-il convergé vers la cible -16 LUFS déjà visée par
  // VideoAssemblyService ?), sur la narration SEULE avant mixage pour voiceAudibility (la voix
  // porte-t-elle un signal réel, pas un silence/échec de génération ?).
  private async buildAudioCriteria(finalVideoBuffer: Buffer, narrationBuffer: Buffer | null): Promise<JudgeCriterionResult[]> {
    const finalLufs = await this.measureIntegratedLoudness(finalVideoBuffer, 'mp4').catch(() => null);
    const audioQuality = this.scoreLoudnessConvergence(finalLufs);

    if (!narrationBuffer) {
      return [
        audioQuality,
        { name: 'voiceAudibility', score: NEUTRAL_SCORE, justification: 'Narration non disponible pour cette génération.', defect: UNAVAILABLE_DEFECT },
      ];
    }
    const narrationLufs = await this.measureIntegratedLoudness(narrationBuffer, 'mp3').catch(() => null);
    const voiceAudibility: JudgeCriterionResult =
      narrationLufs === null || narrationLufs <= -60
        ? { name: 'voiceAudibility', score: 20, justification: 'Narration silencieuse ou non mesurable avant mixage.', defect: 'Narration inaudible' }
        : { name: 'voiceAudibility', score: 90, justification: `Narration mesurée à ${narrationLufs.toFixed(1)} LUFS avant mixage — signal présent.` };

    return [audioQuality, voiceAudibility];
  }

  private scoreLoudnessConvergence(measuredLufs: number | null): JudgeCriterionResult {
    if (measuredLufs === null) {
      return { name: 'audioQuality', score: NEUTRAL_SCORE, justification: 'Mesure de niveau sonore indisponible.', defect: UNAVAILABLE_DEFECT };
    }
    const delta = Math.abs(measuredLufs - TARGET_LUFS);
    const score = Math.max(0, Math.round(100 - (delta / LUFS_TOLERANCE) * 100));
    return {
      name: 'audioQuality',
      score,
      justification: `Niveau sonore final mesuré à ${measuredLufs.toFixed(1)} LUFS (cible ${TARGET_LUFS} LUFS, cf. VideoAssemblyService).`,
      ...(score < CRITICAL_FLOOR ? { defect: 'Le mixage final ne converge pas vers le niveau sonore cible' } : {}),
    };
  }

  // Mission 4 Phase D — voiceDynamism : variance de niveau RMS sur des fenêtres glissantes
  // (~1s) de la narration ISOLÉE (narrationBuffer), AVANT tout mixage musique/ducking — même
  // buffer que voiceAudibility ci-dessus, jamais le mix final contaminé. Approxime la
  // "dynamique acoustique" (le volume varie-t-il dans le temps, signe d'une lecture vivante
  // plutôt que monocorde) — ce n'est PAS une détection d'émotion réelle, qu'aucun provider
  // actuel (OpenAI TTS/Whisper, Anthropic) ne mesure : isApproximation=true, jamais présenté
  // comme une compréhension sémantique. États exposés STRICTEMENT nommés ACOUSTIC_DYNAMICS_*
  // (jamais EMOTION_*, règle absolue Mission 4).
  private async buildVoiceDynamismCriterion(narrationBuffer: Buffer | null): Promise<JudgeCriterionResult> {
    if (!narrationBuffer) {
      return {
        name: 'voiceDynamism',
        score: NEUTRAL_SCORE,
        justification: 'Narration non disponible pour cette génération.',
        defect: UNAVAILABLE_DEFECT,
        measurementMethod: 'FFMPEG_RMS_VARIANCE',
        isApproximation: true,
      };
    }
    try {
      const rmsWindows = await measureRmsWindows(narrationBuffer);
      if (rmsWindows.length < 2) {
        return {
          name: 'voiceDynamism',
          score: NEUTRAL_SCORE,
          justification: 'Narration trop courte pour mesurer une dynamique acoustique fiable (moins de 2 fenêtres ~1s).',
          defect: UNAVAILABLE_DEFECT,
          measurementMethod: 'FFMPEG_RMS_VARIANCE',
          isApproximation: true,
        };
      }
      const stdDev = computeStdDev(rmsWindows);
      const state = classifyAcousticDynamics(stdDev);
      const score = scoreAcousticDynamics(stdDev);
      return {
        name: 'voiceDynamism',
        score,
        justification: `Écart-type du niveau RMS sur ${rmsWindows.length} fenêtre(s) ~1s de la narration isolée : ${stdDev.toFixed(1)} dB (${state}).`,
        measurementMethod: 'FFMPEG_RMS_VARIANCE',
        isApproximation: true,
        ...(state === 'ACOUSTIC_DYNAMICS_LOW' ? { defect: 'Narration acoustiquement plate (peu de variation de volume dans le temps)' } : {}),
      };
    } catch (error) {
      this.logger.warn(`Mesure de dynamique vocale (RMS variance) échouée: ${error}`);
      return {
        name: 'voiceDynamism',
        score: NEUTRAL_SCORE,
        justification: 'Mesure de dynamique vocale indisponible.',
        defect: UNAVAILABLE_DEFECT,
        measurementMethod: 'FFMPEG_RMS_VARIANCE',
        isApproximation: true,
      };
    }
  }

  // Mission 4 Phase D — voicePacing : PAS motsTotal/durée (mélangerait diction et pauses),
  // dérive des TranscriptSegment DÉJÀ disponibles (aucun appel supplémentaire, aucune mesure
  // ffmpeg). Mesure extraite dans voice-pacing.ts (Phase E) : partagée avec le benchmark TTS isolé.
  private buildVoicePacingCriterion(transcript: TranscriptSegment[] | null): JudgeCriterionResult {
    const measurement = transcript ? computeVoicePacing(transcript) : null;
    if (!measurement) {
      return { name: 'voicePacing', score: NEUTRAL_SCORE, justification: 'Débit de parole non mesurable (transcript absent ou durée nulle).', defect: UNAVAILABLE_DEFECT, measurementMethod: 'FFMPEG_TIMING', isApproximation: true };
    }

    const { speakingRate, pauseRatio, diagnostic } = measurement;
    const score = diagnostic === 'VOICE_PACING_OK' ? 90 : 45;
    const justification = `Débit de parole mesuré à ${speakingRate.toFixed(2)} mots/s (cible ${VOICE_PACING_MIN_WORDS_PER_SECOND}-${VOICE_PACING_MAX_WORDS_PER_SECOND}), ratio de pause ${(pauseRatio * 100).toFixed(0)}% — ${diagnostic}.`;

    return {
      name: 'voicePacing',
      score,
      justification,
      measurementMethod: 'FFMPEG_TIMING',
      isApproximation: true,
      ...(diagnostic !== 'VOICE_PACING_OK' ? { defect: diagnostic } : {}),
    };
  }

  // productVisibility + visualComposition : UN SEUL appel vision de ce Judge, sur une frame de
  // la vidéo FINALE assemblée (donc APRÈS Ken Burns/sous-titres, cf. VideoAssemblyService) —
  // distinct de VideoAnalyzerService.checkVisualFidelity qui juge chaque clip BRUT pendant sa
  // génération. Mission 4 Phase A : le schema est étendu (pas un nouvel appel) pour ajouter le
  // jugement de QUALITÉ de composition (cadrage/équilibre/placement), toujours distinct de
  // formatCompliance (géométrie, ffmpeg cropdetect, jamais mélangé — spec Mission 4 section 5).
  private async buildVisionCriteria(ctx: AiCallContext, finalVideoBuffer: Buffer, visualDna: VisualDna): Promise<[JudgeCriterionResult, JudgeCriterionResult]> {
    try {
      const frameDataUri = await this.extractFrame(finalVideoBuffer, 0.4);
      const prompt = `Cette image est extraite de la vidéo publicitaire FINALE (montée, avec incrustations). Analyse DEUX aspects distincts :
1. Le produit y est-il clairement visible et reconnaissable, conforme à cette identité visuelle de référence ?
${JSON.stringify(visualDna)}
2. La QUALITÉ DE COMPOSITION du cadrage (cadrage, équilibre visuel, placement du produit dans l'image, occupation visuelle) — juge uniquement la qualité CRÉATIVE du cadrage, pas sa géométrie (déjà mesurée séparément).
Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
{"visible":true|false,"score":0-100,"reason":"...","composition":{"score":0-100,"reason":"..."}}`;
      const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl: frameDataUri }, 'openai', PROMPT_VERSIONS.productVisibilityFinal);
      const parsed = parseAiJson<any>(result.content);

      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : NEUTRAL_SCORE;
      const visible = parsed.visible !== false;
      const productVisibility: JudgeCriterionResult = {
        name: 'productVisibility',
        score,
        justification: typeof parsed.reason === 'string' ? parsed.reason : 'Vérification de visibilité produit sur la vidéo finale.',
        ...(!visible || score < CRITICAL_FLOOR ? { defect: typeof parsed.reason === 'string' ? parsed.reason : 'Produit peu visible dans la vidéo finale' } : {}),
      };

      const compositionRaw = parsed.composition && typeof parsed.composition === 'object' ? parsed.composition : null;
      const visualComposition: JudgeCriterionResult = compositionRaw
        ? {
            name: 'visualComposition',
            score: typeof compositionRaw.score === 'number' ? Math.max(0, Math.min(100, compositionRaw.score)) : NEUTRAL_SCORE,
            justification: typeof compositionRaw.reason === 'string' ? compositionRaw.reason : 'Composition évaluée.',
            ...((typeof compositionRaw.score !== 'number' || compositionRaw.score < CRITICAL_FLOOR)
              ? { defect: typeof compositionRaw.reason === 'string' ? compositionRaw.reason : 'Composition insuffisante' }
              : {}),
          }
        : { name: 'visualComposition', score: NEUTRAL_SCORE, justification: 'Composition non renvoyée par le modèle.', defect: UNAVAILABLE_DEFECT };

      return [productVisibility, visualComposition];
    } catch (error) {
      this.logger.warn(`Vérification de visibilité/composition (vidéo finale) échouée: ${error}`);
      const unavailable = (name: 'productVisibility' | 'visualComposition'): JudgeCriterionResult => ({
        name, score: NEUTRAL_SCORE, justification: 'Vérification indisponible.', defect: UNAVAILABLE_DEFECT,
      });
      return [unavailable('productVisibility'), unavailable('visualComposition')];
    }
  }

  // Mission 4 Phase B — sceneConsistency : cohérence visuelle ENTRE plans (éclairage,
  // environnement, style) — comparaison impossible à mesurer déterministiquement (aucune donnée
  // ffmpeg n'y répond), donc UN SEUL appel vision GROUPÉ (jamais N appels, un par paire de plans)
  // sur 1 frame par plan. Défauts structurés (SceneConsistencyDefect), jamais un texte libre non
  // attribuable — un défaut sans sceneRef identifiable n'est jamais réparable (Correction 3).
  private static readonly SCENE_CONSISTENCY_LOW_THRESHOLD = 60;

  private async buildSceneConsistencyCriterion(ctx: AiCallContext, finalVideoBuffer: Buffer, shotPlan: ShotPlan): Promise<JudgeCriterionResult> {
    if (shotPlan.length < 2) {
      return {
        name: 'sceneConsistency',
        score: 100,
        confidence: 1,
        justification: 'Un seul plan dans cette vidéo — aucune cohérence inter-plans à évaluer.',
        measurementMethod: 'VISION_MULTI_FRAME',
      };
    }

    try {
      const ratios = this.computeShotFrameRatios(shotPlan);
      const frames = await Promise.all(ratios.map((r) => this.extractFrame(finalVideoBuffer, r)));
      const sceneIds = shotPlan.map((s) => s.sceneId);

      const prompt = `Ces ${frames.length} images sont extraites de plans successifs (dans l'ordre) d'UNE MÊME vidéo publicitaire finale : ${sceneIds.join(', ')}.
Compare-les entre elles pour détecter des ruptures de COHÉRENCE VISUELLE (pas de qualité individuelle) : éclairage incohérent, environnement/décor qui change sans raison, style visuel qui rompt d'un plan à l'autre.
Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
{"score":0-100,"confidence":0-1,"defects":[{"sceneRef":"shot-id-ou-[shot-id,shot-id]","issue":"...","severity":"LOW|MEDIUM|HIGH","confidence":0-1}]}
"score"=100 et "defects"=[] si tous les plans sont visuellement cohérents entre eux. "sceneRef" DOIT être un des identifiants fournis (${sceneIds.join(', ')}) ou une paire de ces identifiants — jamais une référence inventée.`;

      const result = await this.aiGateway.analyzeImage(
        ctx,
        { prompt, imageUrl: frames[0], additionalImageUrls: frames.slice(1) },
        'openai',
        PROMPT_VERSIONS.sceneConsistency,
      );
      return this.parseSceneConsistencyResult(result.content, sceneIds);
    } catch (error) {
      this.logger.warn(`Mesure de cohérence inter-plans (vision groupée) échouée: ${error}`);
      return { name: 'sceneConsistency', score: NEUTRAL_SCORE, justification: 'Vérification indisponible.', defect: UNAVAILABLE_DEFECT, measurementMethod: 'VISION_MULTI_FRAME' };
    }
  }

  private parseSceneConsistencyResult(raw: string, validSceneIds: string[]): JudgeCriterionResult {
    try {
      const parsed = parseAiJson<any>(raw);
      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : NEUTRAL_SCORE;
      const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : undefined;
      const rawDefects = Array.isArray(parsed.defects) ? parsed.defects : [];

      const defects: SceneConsistencyDefect[] = rawDefects
        .map((d: any): SceneConsistencyDefect | null => {
          const sceneRef = this.normalizeSceneConsistencyRef(d?.sceneRef, validSceneIds);
          if (!sceneRef || typeof d?.issue !== 'string') return null;
          const severity: SceneConsistencyDefect['severity'] = d.severity === 'HIGH' || d.severity === 'MEDIUM' || d.severity === 'LOW' ? d.severity : 'MEDIUM';
          const defectConfidence = typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : 0;
          return { sceneRef, issue: d.issue, severity, confidence: defectConfidence };
        })
        .filter((d: SceneConsistencyDefect | null): d is SceneConsistencyDefect => d !== null);

      if (defects.length === 0) {
        return {
          name: 'sceneConsistency',
          score,
          ...(confidence !== undefined ? { confidence } : {}),
          justification: 'Aucune rupture de cohérence inter-plans détectée.',
          measurementMethod: 'VISION_MULTI_FRAME',
          defects: [],
        };
      }

      // Réduction à UN SEUL défaut/sceneRef top-level pour la machinerie générique existante
      // (applyRepairs filtre sur `defect`) — jamais une attribution arbitraire. `confidence`
      // top-level = la plus BASSE parmi les défauts (conservateur : le critère n'est jamais plus
      // fiable que sa mesure la moins fiable).
      const worst = [...defects].sort((a, b) => this.severityRank(b.severity) - this.severityRank(a.severity))[0];
      const resolvedSceneRef = this.resolveSceneConsistencyCulprit(defects);
      const minConfidence = Math.min(...defects.map((d) => d.confidence));

      return {
        name: 'sceneConsistency',
        score,
        confidence: confidence ?? minConfidence,
        justification: defects.map((d) => `${Array.isArray(d.sceneRef) ? d.sceneRef.join('/') : d.sceneRef}: ${d.issue}`).join(' ; '),
        defect: worst.issue,
        measurementMethod: 'VISION_MULTI_FRAME',
        defects,
        ...(resolvedSceneRef ? { sceneRef: resolvedSceneRef } : {}),
      };
    } catch (error) {
      this.logger.warn(`Réponse de cohérence inter-plans non conforme au format JSON attendu: ${error}`);
      return { name: 'sceneConsistency', score: NEUTRAL_SCORE, justification: 'Réponse de vérification non exploitable.', defect: UNAVAILABLE_DEFECT, measurementMethod: 'VISION_MULTI_FRAME' };
    }
  }

  private normalizeSceneConsistencyRef(raw: unknown, validSceneIds: string[]): string | [string, string] | null {
    if (typeof raw === 'string') return validSceneIds.includes(raw) ? raw : null;
    if (Array.isArray(raw) && raw.length === 2 && raw.every((r) => typeof r === 'string' && validSceneIds.includes(r))) {
      return [raw[0], raw[1]];
    }
    return null;
  }

  private severityRank(severity: SceneConsistencyDefect['severity']): number {
    return severity === 'HIGH' ? 3 : severity === 'MEDIUM' ? 2 : 1;
  }

  // Audit forensique Mission 4.2 (P1-2) : en conditions réelles, une incohérence entre plans
  // s'exprime presque toujours comme une PAIRE de scènes (ex: "shot-1/shot-2"), et plusieurs
  // défauts peuvent être détectés simultanément (ex: shot-1 incohérent à la fois avec shot-2 ET
  // shot-3) — l'ancienne résolution (`defects.length === 1 && sceneRef est une chaîne unique`)
  // n'était donc presque jamais satisfaite sur des campagnes réelles, laissant `sceneConsistency`
  // détecté de façon fiable mais structurellement jamais réparé (confirmé par l'audit forensique
  // sur des campagnes réelles : aucun repairLog n'a jamais ciblé sceneConsistency). Résolution
  // conservatrice : si UNE scène précise apparaît dans TOUS les défauts détectés (le dénominateur
  // commun — la scène qui ne s'accorde avec AUCUNE des autres impliquées), c'est une preuve par
  // corroboration, pas une supposition, et elle devient la cible résolue. Un défaut UNIQUE portant
  // sur une PAIRE reste volontairement non résolu (choisir arbitrairement l'une des 2 scènes de la
  // paire serait une pure supposition, jamais acceptable ici) — seul le cas trivial pré-existant
  // (1 seul défaut, 1 seule scène nommée) reste résolu sans corroboration, comme avant.
  private resolveSceneConsistencyCulprit(defects: SceneConsistencyDefect[]): string | undefined {
    if (defects.length === 1) {
      return typeof defects[0].sceneRef === 'string' ? defects[0].sceneRef : undefined;
    }
    const scenesPerDefect = defects.map((d) => (Array.isArray(d.sceneRef) ? d.sceneRef : [d.sceneRef]));
    const candidates = new Set(scenesPerDefect[0]);
    for (const candidate of candidates) {
      if (scenesPerDefect.every((scenes) => scenes.includes(candidate))) return candidate;
    }
    return undefined;
  }

  // Ratio (0-1) de la position temporelle du MILIEU de chaque plan dans la vidéo finale —
  // préfère les startTime/endTime réels du Shot (quand disponibles sur TOUS les plans), sinon
  // répartition supposée égale des durées de plan (même approximation documentée que
  // shotAtTime, Phase A ci-dessous — jamais présentée comme une attribution certaine).
  private computeShotFrameRatios(shotPlan: ShotPlan): number[] {
    if (shotPlan.length === 0) return [];
    const allShotsHaveRealTimes = shotPlan.every((s) => typeof s.startTime === 'number' && typeof s.endTime === 'number');
    if (allShotsHaveRealTimes) {
      const totalDuration = shotPlan[shotPlan.length - 1].endTime as number;
      if (totalDuration > 0) {
        return shotPlan.map((s) => Math.min(0.99, Math.max(0.01, ((s.startTime as number) + (s.endTime as number)) / 2 / totalDuration)));
      }
    }
    return shotPlan.map((_, i) => (i + 0.5) / shotPlan.length);
  }

  // Mission 4 Phase A — formatCompliance : mesure RÉELLE (ffmpeg cropdetect, coût IA nul),
  // remplace le score 100 codé en dur. Jamais un verdict binaire direct (Correction obligatoire
  // 1) : classe en compositionState avec confidence, et un état INCONCLUSIVE ne déclenche jamais
  // de réparation automatique (gate appliqué en Phase H, repair-dispatch.ts).
  private static readonly FORMAT_FULL_FRAME_MIN_RATIO = 0.95;
  private static readonly FORMAT_UNDERFILLED_MAX_RATIO = 0.7;
  private static readonly FORMAT_CONFIDENCE_LOW_THRESHOLD = 0.5;
  private static readonly FORMAT_CONFIDENCE_STDDEV_REFERENCE = 0.08;
  private static readonly FORMAT_MIN_SAMPLES = 3;
  private static readonly FORMAT_SAMPLE_FPS = 1;

  private async buildFormatComplianceCriterion(finalVideoBuffer: Buffer, shotPlan: ShotPlan): Promise<JudgeCriterionResult> {
    try {
      const { samples, durationSeconds } = await this.runCropDetect(finalVideoBuffer);
      if (samples.length < VideoJudgeService.FORMAT_MIN_SAMPLES) {
        return {
          name: 'formatCompliance',
          score: NEUTRAL_SCORE,
          justification: `Mesure de composition (cropdetect) insuffisante pour conclure (${samples.length} échantillon(s), minimum ${VideoJudgeService.FORMAT_MIN_SAMPLES}).`,
          defect: UNAVAILABLE_DEFECT,
          measurementMethod: 'FFMPEG_CROPDETECT',
        };
      }

      const ratios = samples.map((s) => s.ratio);
      const activeContentRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
      // Confiance calculée sur le sous-ensemble d'échantillons EN DÉFAUT (s'il y en a), jamais sur
      // la variance globale : un plan plein-cadre suivi d'un plan letterboxé produit une variance
      // globale élevée qui n'a rien à voir avec la netteté de la frontière détectée — seule la
      // COHÉRENCE interne du défaut lui-même (constant/stable d'un échantillon en défaut à l'autre
      // = frontière nette, confiance haute ; erratique = frontière floue/ambiguë, confiance basse)
      // doit gouverner INCONCLUSIVE, pas un changement légitime de composition entre deux plans.
      const problemRatios = ratios.filter((r) => r < VideoJudgeService.FORMAT_FULL_FRAME_MIN_RATIO);
      const confidence = this.computeCompositionConfidence(problemRatios.length > 0 ? problemRatios : ratios);
      const compositionState = this.classifyCompositionState(activeContentRatio, confidence);
      const score = this.scoreCompositionState(compositionState, activeContentRatio);
      const sceneRef = compositionState === 'FULL_FRAME' ? undefined : this.attributeCompositionDefect(samples, shotPlan, durationSeconds);

      return {
        name: 'formatCompliance',
        score,
        confidence,
        measurementMethod: 'FFMPEG_CROPDETECT',
        justification: `Zone de contenu actif mesurée à ${Math.round(activeContentRatio * 100)}% du cadre (cropdetect, ${samples.length} échantillon(s), confiance ${confidence.toFixed(2)}) — ${compositionState}.`,
        ...(compositionState !== 'FULL_FRAME' ? { defect: compositionState } : {}),
        ...(sceneRef ? { sceneRef } : {}),
      };
    } catch (error) {
      this.logger.warn(`Mesure de composition (ffmpeg cropdetect) échouée: ${error}`);
      return { name: 'formatCompliance', score: NEUTRAL_SCORE, justification: 'Mesure de composition indisponible.', defect: UNAVAILABLE_DEFECT, measurementMethod: 'FFMPEG_CROPDETECT' };
    }
  }

  private classifyCompositionState(activeContentRatio: number, confidence: number): 'FULL_FRAME' | 'BORDER_DETECTED' | 'UNDERFILLED' | 'INCONCLUSIVE' {
    if (activeContentRatio >= VideoJudgeService.FORMAT_FULL_FRAME_MIN_RATIO) return 'FULL_FRAME';
    if (confidence < VideoJudgeService.FORMAT_CONFIDENCE_LOW_THRESHOLD) return 'INCONCLUSIVE';
    if (activeContentRatio >= VideoJudgeService.FORMAT_UNDERFILLED_MAX_RATIO) return 'BORDER_DETECTED';
    return 'UNDERFILLED';
  }

  private scoreCompositionState(state: ReturnType<VideoJudgeService['classifyCompositionState']>, activeContentRatio: number): number {
    if (state === 'FULL_FRAME') return 100;
    if (state === 'INCONCLUSIVE') return NEUTRAL_SCORE;
    return Math.round(Math.max(0, Math.min(100, activeContentRatio * 100)));
  }

  // Confiance dérivée de la STABILITÉ de la détection à travers les échantillons — une frontière
  // nette produit des ratios cohérents d'un échantillon à l'autre (écart-type bas, confiance
  // haute) ; une frontière dégradée/floue ou un contenu changeant produit des ratios erratiques
  // (écart-type haut, confiance basse -> INCONCLUSIVE plutôt qu'un verdict présenté à tort comme
  // certain). Seuil de référence documenté, à recalibrer (même discipline que WEIGHTS).
  private computeCompositionConfidence(ratios: number[]): number {
    if (ratios.length <= 1) return 1;
    const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    const variance = ratios.reduce((sum, r) => sum + (r - mean) ** 2, 0) / ratios.length;
    const stdDev = Math.sqrt(variance);
    return Math.max(0, Math.min(1, 1 - stdDev / VideoJudgeService.FORMAT_CONFIDENCE_STDDEV_REFERENCE));
  }

  // Attribue le défaut à UN SEUL plan si tous les échantillons "en défaut" (ratio < seuil
  // plein-cadre) tombent dans la fenêtre temporelle d'un même Shot — jamais une attribution
  // arbitraire : si le défaut est absent, ou présent sur TOUT l'échantillonnage (défaut global
  // affectant la vidéo entière, pas un plan précis), retourne undefined (non localisable, cf.
  // Round 4 Correction : "défaut non localisable -> jamais de CLIP_REGEN").
  private attributeCompositionDefect(samples: CropSample[], shotPlan: ShotPlan, durationSeconds: number): string | undefined {
    const problemSamples = samples.filter((s) => s.ratio < VideoJudgeService.FORMAT_FULL_FRAME_MIN_RATIO);
    if (problemSamples.length === 0 || problemSamples.length === samples.length) return undefined;

    const sceneIds = new Set(
      problemSamples.map((s) => this.shotAtTime(s.ptsTime, shotPlan, durationSeconds)).filter((id): id is string => Boolean(id)),
    );
    return sceneIds.size === 1 ? [...sceneIds][0] : undefined;
  }

  // Préfère les startTime/endTime réels du Shot (quand disponibles) ; à défaut, répartition
  // supposée égale des durées de plan — approximation DOCUMENTÉE (même discipline que
  // shot-risk.ts), jamais présentée comme une attribution certaine (cf. confidence du critère,
  // pas de ce repli lui-même).
  private shotAtTime(ptsTime: number, shotPlan: ShotPlan, durationSeconds: number): string | undefined {
    const allShotsHaveRealTimes = shotPlan.length > 0 && shotPlan.every((s) => typeof s.startTime === 'number' && typeof s.endTime === 'number');
    if (allShotsHaveRealTimes) {
      const shot = shotPlan.find((s) => ptsTime >= (s.startTime as number) && ptsTime < (s.endTime as number));
      return shot?.sceneId ?? shotPlan[shotPlan.length - 1]?.sceneId;
    }
    if (shotPlan.length === 0 || durationSeconds <= 0) return undefined;
    const perShotSeconds = durationSeconds / shotPlan.length;
    const index = Math.min(shotPlan.length - 1, Math.floor(ptsTime / perShotSeconds));
    return shotPlan[index]?.sceneId;
  }

  // ffmpeg cropdetect (déterministe, coût IA nul), échantillonné à FORMAT_SAMPLE_FPS pour borner
  // le volume de sortie sur une vidéo de plusieurs dizaines de secondes — même philosophie que
  // measureIntegratedLoudness/measureRmsWindows : parsing défensif d'un flux stderr texte.
  private runCropDetect(buffer: Buffer): Promise<{ samples: CropSample[]; durationSeconds: number }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-judge-crop-'));
    const inputPath = path.join(tmpDir, `${randomUUID()}.mp4`);

    return new Promise((resolve, reject) => {
      fs.writeFileSync(inputPath, buffer);
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return reject(err);
        }
        const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
        const canvasWidth = videoStream?.width ?? 0;
        const canvasHeight = videoStream?.height ?? 0;
        const durationSeconds = metadata.format.duration ?? 0;
        if (!canvasWidth || !canvasHeight) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return resolve({ samples: [], durationSeconds });
        }

        const samples: CropSample[] = [];
        ffmpeg(inputPath)
          .videoFilters([`fps=${VideoJudgeService.FORMAT_SAMPLE_FPS}`, 'cropdetect=24:2:0:reset=1'])
          .outputOptions(['-f', 'null'])
          .on('stderr', (line: string) => {
            const match = /w:(\d+)\s+h:(\d+)\s+x:\d+\s+y:\d+\s+pts:\d+\s+pts_time:([\d.]+)/.exec(line);
            if (!match) return;
            const w = parseInt(match[1], 10);
            const h = parseInt(match[2], 10);
            const ptsTime = parseFloat(match[3]);
            samples.push({ ratio: (w * h) / (canvasWidth * canvasHeight), ptsTime });
          })
          .on('end', () => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            resolve({ samples, durationSeconds });
          })
          .on('error', (error) => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            reject(new Error(`Mesure de composition (ffmpeg cropdetect) a échoué : ${error.message}`));
          })
          .save(path.join(tmpDir, 'null-output'));
      });
    });
  }

  // storytelling/hookStrength/pacing/textReadability/grammar/ctaClarity/brandCoherence/
  // factualConsistency/advertisingEffectiveness : UN SEUL appel texte groupé (cf.
  // templates/video-judge.template.ts) — parsing défensif, jamais de throw sur une réponse
  // malformée ou un critère manquant (repli score neutre par critère, pas un échec global).
  private async buildTextCriteria(ctx: AiCallContext, params: JudgeParams): Promise<JudgeCriterionResult[]> {
    const expectedNames: JudgeCriterionName[] = [
      'storytelling', 'hookStrength', 'pacing', 'textReadability', 'grammar', 'ctaClarity', 'brandCoherence', 'factualConsistency', 'advertisingEffectiveness',
    ];

    let parsedByName = await this.callTextCriteriaOnce(ctx, params);
    // Mission 3 (validation empirique, 2026-08-20) — bug réel confirmé sur 3 campagnes
    // historiques : un échec/mal-parsing de CET appel fait retomber les 9 critères sur le repli
    // neutre EN MÊME TEMPS, indiscernable de 9 vrais défauts de contenu pour le reste du pipeline
    // (repair-priority.ts/video-quality-loop.service.ts) — jusqu'à 2 cycles de réparation
    // (SUBTITLE_ONLY/AUDIO_REGEN) dépensés en conditions réelles à tenter de corriger un problème
    // qui n'a jamais été mesuré. Coût marginal d'une seconde tentative (1 appel texte) largement
    // inférieur au coût d'une réparation locale entière déclenchée sur un repli fantôme.
    if (parsedByName.size === 0) {
      this.logger.warn('Aucun critère texte du Video Judge exploitable au 1er essai — nouvelle tentative avant repli neutre.');
      parsedByName = await this.callTextCriteriaOnce(ctx, params);
    }

    return expectedNames.map((name) => {
      const entry = parsedByName.get(name);
      if (!entry || typeof entry.score !== 'number') {
        return { name, score: NEUTRAL_SCORE, justification: 'Critère non renvoyé par le modèle.', defect: UNAVAILABLE_DEFECT };
      }
      const score = Math.max(0, Math.min(100, entry.score));
      const justification = typeof entry.justification === 'string' ? entry.justification : '';
      const defect = typeof entry.defect === 'string' ? entry.defect : undefined;
      const sceneRef = typeof entry.sceneRef === 'string' ? entry.sceneRef : undefined;
      return { name, score, justification, ...(defect ? { defect } : {}), ...(sceneRef ? { sceneRef } : {}) };
    });
  }

  // L'appel generateText lui-même (pas seulement le parsing JSON de sa réponse) doit être
  // couvert par ce try/catch — même philosophie que buildProductVisibilityCriterion. Bug réel
  // constaté le 2026-08-19 : un échec total du fournisseur (AbortError après épuisement de la
  // chaîne de repli anthropic->openai, cf. AiGatewayService) faisait planter TOUT le Judge (et
  // donc toute la campagne, message générique "erreur technique") au lieu de dégrader ce seul
  // groupe de critères en score neutre, alors que la même panne sur productVisibility était déjà
  // correctement absorbée. Extrait en méthode dédiée (Mission 3) pour être appelable 2 fois
  // (retry) sans dupliquer la construction du prompt.
  private async callTextCriteriaOnce(ctx: AiCallContext, params: JudgeParams): Promise<Map<string, Record<string, unknown>>> {
    try {
      const transcriptText = (params.transcript ?? []).map((s) => s.text).join(' ');
      const plannedOnScreenText = params.shotPlan.map((s) => s.onScreenText).filter(Boolean).join(' | ');
      const groundedContextBlock = params.productProfile ? `\n\n${renderGroundedContext(params.productProfile)}` : '';

      const prompt = this.promptEngine.render(PromptTask.VIDEO_JUDGE, { concept: params.concept, transcriptText, plannedOnScreenText, groundedContextBlock });
      const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic', PROMPT_VERSIONS.videoJudge);

      const parsed = parseAiJson<any>(result.content);
      if (Array.isArray(parsed)) {
        return new Map(parsed.filter((e) => e && typeof e.name === 'string').map((e) => [e.name, e]));
      }
      return new Map();
    } catch (error) {
      this.logger.warn(`Critères texte du Video Judge indisponibles (appel ou parsing), repli neutre par critère: ${error}`);
      return new Map();
    }
  }

  private measureIntegratedLoudness(buffer: Buffer, extension: string): Promise<number> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-judge-loudness-'));
    const inputPath = path.join(tmpDir, `${randomUUID()}.${extension}`);

    return new Promise((resolve, reject) => {
      fs.writeFileSync(inputPath, buffer);
      let statsJson = '';
      ffmpeg(inputPath)
        .audioFilters('loudnorm=print_format=json')
        .outputOptions(['-f', 'null'])
        .on('stderr', (line: string) => {
          statsJson += `${line}\n`;
        })
        .on('end', () => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          const match = /\{[\s\S]*"input_i"[\s\S]*?\}/.exec(statsJson);
          if (!match) return reject(new Error('Statistiques loudnorm introuvables dans la sortie ffmpeg'));
          try {
            const stats = JSON.parse(match[0]);
            resolve(parseFloat(stats.input_i));
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (err) => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          reject(new Error(`Mesure de niveau sonore (ffmpeg loudnorm) a échoué : ${err.message}`));
        })
        .save(path.join(tmpDir, 'null-output'));
    });
  }

  private extractFrame(videoBuffer: Buffer, atRatio: number): Promise<string> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-judge-frame-'));
    const inputPath = path.join(tmpDir, `${randomUUID()}.mp4`);
    const framePath = path.join(tmpDir, `${randomUUID()}.jpg`);

    return new Promise((resolve, reject) => {
      fs.writeFileSync(inputPath, videoBuffer);
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return reject(err);
        }
        const durationSeconds = metadata.format.duration ?? 0;
        const seekSeconds = durationSeconds > 0 ? durationSeconds * atRatio : 0;

        ffmpeg(inputPath)
          .seekInput(seekSeconds)
          .frames(1)
          .on('end', () => {
            const base64 = fs.readFileSync(framePath).toString('base64');
            fs.rmSync(tmpDir, { recursive: true, force: true });
            resolve(`data:image/jpeg;base64,${base64}`);
          })
          .on('error', (frameErr) => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            reject(new Error(`Extraction de frame (ffmpeg) a échoué : ${frameErr.message}`));
          })
          .save(framePath);
      });
    });
  }
}
