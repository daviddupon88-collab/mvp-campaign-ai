import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { ProductIntelligenceProfile } from '@prisma/client';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { resolveMediaBuffer } from '../../common/http/resolve-media-buffer';
import { TranscriptSegment } from '../ai-gateway/providers/ai-provider.interface';
import { VisualDna } from '../video-direction/visual-dna.service';
import { ShotPlan } from '../video-direction/video-director.service';
import { VideoDirectorService } from '../video-direction/video-director.service';
import { ShotQualityResult } from '../video-direction/video-analyzer.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { VideoFinalizationService, FinalizeResult } from '../../video-assembly/video-finalization.service';
import { VideoJudgeService } from './video-judge.service';
import { VideoJudgeResult, JudgeCriterionResult, JudgeCriterionName, UNAVAILABLE_DEFECT } from './video-judge.types';
import { classifyRepair, RepairStrategy, REPAIR_STRATEGY_COST_ORDER, isClipRegenGateSatisfied } from './repair-dispatch';
import { evaluateRepairOutcome, computeCriterionDeltas } from './repair-regression-guard';
import { RepairHistoryEntry, classifyOutcome, shouldSkipStrategy, needsEscalation } from './repair-history';
import { computeSeverity, computePriority, isRepairAllowedForSeverity } from './repair-priority';

export interface VideoClip {
  sceneId: string;
  content: string;
}

export interface QualityLoopParams {
  rawVideoUrl: string;
  videoClips: VideoClip[]; // clips individuels AVANT concaténation — nécessaires pour un CLIP_REGEN ciblé
  narrationDataUri: string;
  narrationText: string; // texte source de la narration — réutilisé pour un AUDIO_REGEN
  transcript: TranscriptSegment[] | null;
  shotPlan: ShotPlan;
  perShotQuality: Map<string, ShotQualityResult>;
  visualDna: VisualDna;
  referenceImageUrl: string;
  concept: CreativeConcept;
  productProfile: ProductIntelligenceProfile | null;
}

// Phase A (chantier V2, 2026-08-19) — état mutable de la boucle regroupé en un seul objet
// (cf. run()) : permet un snapshot/rollback fiable en une seule opération plutôt que 4 variables
// synchronisées manuellement.
interface QualityLoopState {
  rawVideoUrl: string;
  videoClips: VideoClip[];
  narrationDataUri: string;
  transcript: TranscriptSegment[] | null;
}

export interface RepairAction {
  criterion: JudgeCriterionName;
  strategy: RepairStrategy;
  sceneId?: string;
  reason: string;
}

export interface QualityLoopAttemptTrace {
  attempt: number;
  judge: VideoJudgeResult;
  repairsApplied: RepairAction[];
  // Phase A (chantier V2, 2026-08-19) — true si CETTE réparation a régressé une dimension
  // critique ou le score global et a donc été annulée (état restauré) : le coût IA est consommé
  // (irréversible) mais l'état livré n'inclut jamais ce résultat.
  reverted?: boolean;
  regressionReason?: string;
}

export type QualityLoopOutcome =
  // transcript = état final (post-réparations éventuelles, cf. applyRepairs/SUBTITLE_ONLY et
  // AUDIO_REGEN) — c'est CE texte qui a réellement fini dans la vidéo livrée, celui à utiliser
  // pour la sécurité factuelle élargie (P0.10), pas le transcript d'origine passé en entrée.
  | { status: 'PASSED'; finalized: FinalizeResult; lastJudge: VideoJudgeResult | null; attempts: QualityLoopAttemptTrace[]; transcript: TranscriptSegment[] | null }
  // bestAttempt (Phase A) — jamais SEULEMENT le dernier jugement produit : un jugement final peut
  // être moins bon qu'une tentative antérieure (ou reverté) ; le rapport d'échec doit toujours
  // pouvoir citer la MEILLEURE version réellement produite pendant cette exécution.
  // history (Phase F) — exposé tel quel plutôt que redérivé : quality-report.ts en a besoin pour
  // ordreDePriorite/causeRacine/actionRecommandee sans dupliquer la logique de classification déjà
  // faite ici (classifyOutcome, cf. repair-history.ts).
  | { status: 'REPAIR_EXHAUSTED'; lastJudge: VideoJudgeResult; attempts: QualityLoopAttemptTrace[]; bestAttempt: { judge: VideoJudgeResult; attemptNumber: number }; history: RepairHistoryEntry[] };

// P0.7 — Quality Loop (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18) : GENERATE -> JUDGE -> (PASS -> FINALIZE) | (REPAIR_REQUIRED -> réparer UNIQUEMENT
// les parties défectueuses, moins coûteuses d'abord -> re-JUDGE), bornée par
// MAX_REPAIR_ATTEMPTS. Épuisée sans PASS -> REPAIR_EXHAUSTED, jamais un faux succès parce qu'un
// fichier a été produit (cf. règle absolue du brief).
@Injectable()
export class VideoQualityLoopService {
  private readonly logger = new Logger(VideoQualityLoopService.name);

  // 2 essais max, symétrique au budget de régénération déjà en production pour un plan
  // individuel (cf. AiOrchestratorService.generateShotPlanVideoOrDegrade, `for (attempt < 2)`)
  // — même philosophie de coût borné, appliquée maintenant à la vidéo finale assemblée.
  static readonly MAX_REPAIR_ATTEMPTS = 2;

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
    private readonly videoDirector: VideoDirectorService,
    private readonly videoFinalization: VideoFinalizationService,
    private readonly videoJudge: VideoJudgeService,
  ) {}

  // maxRepairAttempts optionnel : par défaut MAX_REPAIR_ATTEMPTS (2), mais CostControlService
  // (Checkpoint B, cf. AiOrchestratorService) peut le DÉGRADER (1 ou 0) si le budget de crédits
  // restant ne couvre pas le pire cas complet — l'appelant transmet alors la valeur dégradée ici
  // plutôt que de la recalculer.
  async run(ctx: AiCallContext, params: QualityLoopParams, maxRepairAttempts = VideoQualityLoopService.MAX_REPAIR_ATTEMPTS): Promise<QualityLoopOutcome> {
    // Phase A (chantier V2, 2026-08-19) — les 4 anciennes variables `let` indépendantes
    // (rawVideoUrl/videoClips/narrationDataUri/transcript) sont regroupées en UN SEUL objet :
    // un snapshot/rollback correct sur 4 variables séparées est source d'oubli (revert 3 sur 4,
    // état incohérent). Ici un snapshot est `{ ...state }`, un rollback une seule réassignation.
    // Sûr en `{ ...state }` (copie superficielle) : videoClips/transcript sont TOUJOURS remplacés
    // en bloc par les setters ci-dessous, jamais mutés en place (`.push()` etc.).
    let state: QualityLoopState = {
      rawVideoUrl: params.rawVideoUrl,
      videoClips: params.videoClips,
      narrationDataUri: params.narrationDataUri,
      transcript: params.transcript,
    };
    const attempts: QualityLoopAttemptTrace[] = [];
    // Meilleur jugement réellement produit sur toute l'exécution — jamais perdu même si une
    // tentative ultérieure régresse ou si la boucle s'épuise sans PASS (spec Règle 20).
    let bestEver: { judge: VideoJudgeResult; state: QualityLoopState; attempt: number } | null = null;
    // Jugement de référence pour la comparaison de régression ET pour choisir la prochaine
    // réparation — ne pointe JAMAIS vers un jugement dont l'état a été reverté.
    let operativeJudge: VideoJudgeResult | null = null;
    let preRepairState: QualityLoopState | null = null;
    // Phase B (chantier V2, 2026-08-19) — historique anti-boucle RÉELLEMENT consulté (pas
    // seulement journalisé, contrairement à `attempts` ci-dessus) : avant de sélectionner une
    // stratégie pour un défaut, applyRepairs() interroge cet historique pour ne jamais répéter à
    // l'identique une stratégie déjà classée ECHEC sur le même (critère, scène).
    const history: RepairHistoryEntry[] = [];
    let pendingRepairContext: { judge: VideoJudgeResult; repairs: RepairAction[] } | null = null;

    for (let attempt = 1; attempt <= maxRepairAttempts + 1; attempt++) {
      const finalized = await this.videoFinalization.finalize({ rawVideoUrl: state.rawVideoUrl, narrationDataUri: state.narrationDataUri, transcript: state.transcript });

      // Mode mock (ou tout fournisseur sans média réel) : rien à juger, même repli que le
      // comportement historique de VideoFinalizationService — pas un échec du Quality Loop.
      if (finalized.status === 'skipped') {
        return { status: 'PASSED', finalized, lastJudge: null, attempts, transcript: state.transcript };
      }

      const narrationBuffer = await this.decodeNarration(state.narrationDataUri);
      const judge = await this.videoJudge.judge(ctx, {
        finalVideoBuffer: finalized.buffer,
        narrationBuffer,
        shotPlan: params.shotPlan,
        perShotQuality: params.perShotQuality,
        visualDna: params.visualDna,
        concept: params.concept,
        transcript: state.transcript,
        productProfile: params.productProfile,
      });

      // Phase B — enregistre l'issue des réparations de la tentative PRÉCÉDENTE (delta par
      // critère entre le jugement qui les a motivées et ce nouveau jugement) — indépendant du
      // rollback ci-dessous : même une réparation reveretée doit être mémorisée comme un ÉCHEC,
      // sinon la même stratégie inefficace serait retentée à l'identique.
      if (pendingRepairContext) {
        const deltas = computeCriterionDeltas(pendingRepairContext.judge, judge);
        for (const action of pendingRepairContext.repairs) {
          const scoreDelta = deltas.get(action.criterion) ?? 0;
          history.push({ criterion: action.criterion, sceneId: action.sceneId, strategy: action.strategy, scoreDelta, outcome: classifyOutcome(scoreDelta) });
        }
      }

      // Protection contre les régressions (spec Règle 19) : cette tentative suit-elle une
      // réparation (preRepairState défini) ? Comparer AVANT d'adopter le nouvel état — une
      // réparation qui corrige une dimension en en dégradant une autre plus grave est REJETÉE,
      // quel que soit le gain obtenu par ailleurs.
      let reverted = false;
      let regressionReason: string | undefined;
      if (preRepairState && operativeJudge) {
        const regression = evaluateRepairOutcome(operativeJudge, judge);
        if (!regression.accepted) {
          reverted = true;
          regressionReason = regression.reason;
          this.logger.warn(`Réparation rejetée (régression détectée) à la tentative ${attempt} : ${regression.reason} — retour à l'état de la tentative précédente.`);
          state = preRepairState;
        }
      }

      if (!reverted) {
        operativeJudge = judge;
        if (!bestEver || judge.globalScore > bestEver.judge.globalScore) {
          bestEver = { judge, state, attempt };
        }

        if (judge.verdict === 'PASS') {
          return { status: 'PASSED', finalized, lastJudge: judge, attempts: [...attempts, { attempt, judge, repairsApplied: [] }], transcript: state.transcript };
        }
      }

      if (attempt > maxRepairAttempts) {
        const effectiveLastJudge = reverted ? operativeJudge! : judge;
        const best = bestEver ?? { judge: effectiveLastJudge, attempt };
        return { status: 'REPAIR_EXHAUSTED', lastJudge: effectiveLastJudge, attempts, bestAttempt: { judge: best.judge, attemptNumber: best.attempt }, history };
      }

      preRepairState = { ...state };
      const repairsApplied = await this.applyRepairs(
        ctx,
        operativeJudge!,
        params,
        {
          getVideoClips: () => state.videoClips,
          setVideoClips: (clips) => (state = { ...state, videoClips: clips }),
          setRawVideoUrl: (url) => (state = { ...state, rawVideoUrl: url }),
          getNarrationText: () => params.narrationText,
          setNarrationDataUri: (uri) => (state = { ...state, narrationDataUri: uri }),
          getTranscript: () => state.transcript,
          setTranscript: (t) => (state = { ...state, transcript: t }),
        },
        history,
      );
      pendingRepairContext = repairsApplied.length > 0 ? { judge: operativeJudge!, repairs: repairsApplied } : null;

      attempts.push({ attempt, judge, repairsApplied, reverted, regressionReason });

      // Aucun défaut réparable (uniquement des critères UNREPAIRABLE) : continuer la boucle ne
      // changerait rien — inutile de dépenser un cycle finalize+judge supplémentaire pour rien.
      if (repairsApplied.length === 0) {
        const effectiveLastJudge = reverted ? operativeJudge! : judge;
        const best = bestEver ?? { judge: effectiveLastJudge, attempt };
        return { status: 'REPAIR_EXHAUSTED', lastJudge: effectiveLastJudge, attempts, bestAttempt: { judge: best.judge, attemptNumber: best.attempt }, history };
      }
    }

    // Inatteignable (la boucle retourne toujours avant) — TypeScript exige un retour explicite.
    throw new Error('VideoQualityLoopService.run: sortie de boucle inattendue');
  }

  private async decodeNarration(narrationDataUri: string): Promise<Buffer | null> {
    try {
      return await resolveMediaBuffer(narrationDataUri);
    } catch {
      return null;
    }
  }

  private async applyRepairs(
    ctx: AiCallContext,
    judge: VideoJudgeResult,
    params: QualityLoopParams,
    io: {
      getVideoClips: () => VideoClip[];
      setVideoClips: (clips: VideoClip[]) => void;
      setRawVideoUrl: (url: string) => void;
      getNarrationText: () => string;
      setNarrationDataUri: (uri: string) => void;
      getTranscript: () => TranscriptSegment[] | null;
      setTranscript: (t: TranscriptSegment[] | null) => void;
    },
    history: RepairHistoryEntry[],
  ): Promise<RepairAction[]> {
    // Mission 3 (validation empirique, 2026-08-20) — UNAVAILABLE_DEFECT signale un ÉCHEC DE
    // MESURE (l'appel Judge groupé n'a pas pu évaluer ce critère), jamais un vrai défaut de
    // contenu : aucune stratégie de réparation (SUBTITLE_ONLY/AUDIO_REGEN/CLIP_REGEN) ne peut
    // corriger "le Judge n'a pas répondu". Exclu ici, AVANT le dispatch par stratégie — confirmé
    // par 3 campagnes réelles historiques où ces défauts fantômes ont consommé 2 cycles de
    // réparation entiers sans jamais pouvoir progresser (cf. root-cause.ts, qui classe désormais
    // ce cas en PROVIDER plutôt que STORYBOARD/CONCEPT).
    const defects = judge.criteria.filter(
      (c): c is JudgeCriterionResult & { defect: string } => Boolean(c.defect) && c.defect !== UNAVAILABLE_DEFECT,
    );
    const byStrategy = new Map<RepairStrategy, JudgeCriterionResult[]>();
    for (const defect of defects) {
      const strategy = classifyRepair(defect.name);
      byStrategy.set(strategy, [...(byStrategy.get(strategy) ?? []), defect]);
    }

    const applied: RepairAction[] = [];

    for (const strategy of REPAIR_STRATEGY_COST_ORDER) {
      const fullGroup = byStrategy.get(strategy);
      if (!fullGroup?.length) continue;

      if (strategy === 'UNREPAIRABLE') {
        // Jamais de tentative aveugle — remonté tel quel dans la trace, cf. P0.11.
        continue;
      }

      // Phase B — jamais répéter à l'identique une stratégie déjà classée ECHEC sur EXACTEMENT
      // ce (critère, scène) : SUBTITLE_ONLY/AUDIO_REGEN n'ont pas de scène (sceneId=undefined ici
      // est déjà la valeur réelle utilisée) — CLIP_REGEN résout sa scène (repli sur la pire notée
      // si sceneRef absent) et vérifie l'historique APRÈS résolution, plus bas, pas ici.
      let group = strategy === 'CLIP_REGEN' ? fullGroup : fullGroup.filter((d) => !shouldSkipStrategy(history, d.name, undefined, strategy));
      if (group.length === 0) {
        this.logger.warn(`Stratégie "${strategy}" ignorée pour ${fullGroup.map((d) => d.name).join(', ')} — déjà classée ECHEC dans l'historique, jamais répétée à l'identique.`);
        continue;
      }

      // Phase C (spec Section 5) — un défaut MINEUR (score >= PASS_THRESHOLD) ne justifie JAMAIS
      // un correctif coûteux (CLIP_REGEN/AUDIO_REGEN) : exclu ici, remonté tel quel dans la trace
      // (comme UNREPAIRABLE) plutôt que dépensé à l'aveugle. SUBTITLE_ONLY reste éligible (quasi
      // gratuit, cf. isRepairAllowedForSeverity).
      const beforeMineurFilter = group.length;
      group = group.filter((d) => isRepairAllowedForSeverity(computeSeverity(d.score), strategy));
      if (group.length < beforeMineurFilter) {
        this.logger.warn(`${beforeMineurFilter - group.length} défaut(s) MINEUR(s) ignoré(s) pour la stratégie "${strategy}" — coût non justifié par la gravité (spec Section 5).`);
      }
      if (group.length === 0) continue;

      // Phase C (spec Section 6) — à l'intérieur de CE palier de coût, traite les défauts les
      // plus prioritaires en premier (sévérité × poids × impact publicitaire ÷ coût), jamais
      // l'ordre arbitraire renvoyé par le Judge. Trie directement `group` (préserve tous les
      // champs de JudgeCriterionResult, pas seulement ceux de PriorityInput).
      group = [...group].sort(
        (a, b) => computePriority({ criterion: b.name, score: b.score, strategy }) - computePriority({ criterion: a.name, score: a.score, strategy }),
      );

      if (strategy === 'SUBTITLE_ONLY') {
        const transcript = io.getTranscript();
        const priorAttemptFailed = group.some((d) => needsEscalation(history, d.name, d.sceneRef, strategy));
        if (transcript && transcript.length > 0) {
          io.setTranscript(await this.repairTranscript(ctx, transcript, group.map((d) => d.justification || d.name), priorAttemptFailed));
        }
        applied.push(...group.map((d) => ({ criterion: d.name, strategy, reason: d.defect! })));
      }

      if (strategy === 'AUDIO_REGEN') {
        const audio = await this.aiGateway.generateAudio(ctx, { prompt: io.getNarrationText() }, 'openai');
        io.setNarrationDataUri(audio.content);
        const newTranscript = await this.retranscribe(ctx, audio.content);
        if (newTranscript) io.setTranscript(newTranscript);
        applied.push(...group.map((d) => ({ criterion: d.name, strategy, reason: d.defect! })));
      }

      if (strategy === 'CLIP_REGEN') {
        for (const defect of group) {
          // Mission 4 Phase H — formatCompliance/sceneConsistency portent chacun leur propre
          // gate de confiance (repair-dispatch.ts) : à défaut de le satisfaire, JAMAIS de repli
          // sur la pire scène notée pour ces deux critères précisément — remonté comme
          // UNREPAIRABLE (Round 4 : "jamais un CLIP_REGEN 'au mieux'"), contrairement aux autres
          // critères CLIP_REGEN (motionDynamism/productConsistency/productVisibility) qui
          // conservent leur repli historique juste en dessous.
          if (!isClipRegenGateSatisfied(defect)) {
            this.logger.warn(`CLIP_REGEN refusé pour "${defect.name}" — gate de confiance non satisfait (confidence=${defect.confidence ?? 'n/a'}, sceneRef=${defect.sceneRef ?? 'n/a'}), remonté comme UNREPAIRABLE.`);
            continue;
          }
          const sceneId = defect.sceneRef ?? this.worstSceneId(params.perShotQuality);
          if (!sceneId) continue;
          if (shouldSkipStrategy(history, defect.name, sceneId, strategy)) {
            this.logger.warn(`CLIP_REGEN ignoré pour "${defect.name}" sur ${sceneId} — déjà classé ECHEC dans l'historique, jamais répété à l'identique.`);
            continue;
          }
          const shot = params.shotPlan.find((s) => s.sceneId === sceneId);
          const quality = params.perShotQuality.get(sceneId);
          if (!shot || !quality) continue;

          const escalation = needsEscalation(history, defect.name, sceneId, strategy) ? { priorFailureReason: defect.defect! } : undefined;
          const prompt = this.videoDirector.repairShotPrompt(shot, quality, undefined, escalation);
          try {
            const clip = await this.aiGateway.generateVideo(ctx, { prompt, imageUrl: params.referenceImageUrl, durationSeconds: 6 }, 'google-veo');
            const clips = io.getVideoClips().map((c) => (c.sceneId === sceneId ? { sceneId, content: clip.content } : c));
            io.setVideoClips(clips);
            io.setRawVideoUrl(await this.recomposeVideo(clips));
            applied.push({ criterion: defect.name, strategy, sceneId, reason: defect.defect! });
          } catch (error) {
            this.logger.warn(`Régénération du plan ${sceneId} échouée, plan conservé tel quel : ${error}`);
          }
        }
      }
    }

    return applied;
  }

  private async recomposeVideo(clips: VideoClip[]): Promise<string> {
    if (clips.length === 1) return clips[0].content;
    return this.videoFinalization.concatenateClips(clips.map((c) => c.content));
  }

  private worstSceneId(perShotQuality: Map<string, ShotQualityResult>): string | undefined {
    let worst: { sceneId: string; score: number } | null = null;
    for (const [sceneId, quality] of perShotQuality.entries()) {
      if (!worst || quality.qualityScore < worst.score) worst = { sceneId, score: quality.qualityScore };
    }
    return worst?.sceneId;
  }

  // Corrige UNIQUEMENT le texte (grammaire/lisibilité) d'un transcript déjà généré — conserve
  // les horodatages start/end tels quels (re-synchronisés sur l'audio déjà enregistré, jamais
  // régénéré pour ce type de défaut). Défensif : une réponse malformée conserve le transcript
  // d'origine plutôt que de risquer de le corrompre.
  private async repairTranscript(ctx: AiCallContext, transcript: TranscriptSegment[], defects: string[], priorAttemptFailed = false): Promise<TranscriptSegment[]> {
    const originalText = transcript.map((s) => s.text).join(' ');
    const prompt = this.promptEngine.render(PromptTask.REPAIR, { originalText, defects, priorAttemptFailed });

    try {
      const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic', PROMPT_VERSIONS.repairGrammar);
      const parsed = parseAiJson<any>(result.content);
      const correctedText = typeof parsed.correctedText === 'string' ? parsed.correctedText : null;
      if (!correctedText) return transcript;

      // Répartit le texte corrigé sur le MÊME nombre de segments, proportionnellement à leur
      // durée d'origine — approximation simple (comme SubtitleBuilderService.splitIntoCues),
      // suffisante pour rester synchronisé sans transcription mot-à-mot exacte.
      const words = correctedText.split(/\s+/).filter(Boolean);
      const totalDuration = transcript.reduce((sum, s) => sum + (s.end - s.start), 0) || 1;
      let wordIndex = 0;
      return transcript.map((segment) => {
        const share = (segment.end - segment.start) / totalDuration;
        const wordCount = Math.max(1, Math.round(words.length * share));
        const segmentWords = words.slice(wordIndex, wordIndex + wordCount);
        wordIndex += wordCount;
        return { ...segment, text: segmentWords.join(' ') || segment.text };
      });
    } catch (error) {
      this.logger.warn(`Correction du transcript échouée, transcript d'origine conservé : ${error}`);
      return transcript;
    }
  }

  private async retranscribe(ctx: AiCallContext, narrationDataUri: string): Promise<TranscriptSegment[] | null> {
    const match = /^data:(.+?);base64,(.+)$/.exec(narrationDataUri);
    if (!match) return null;
    try {
      const [, mimeType, base64] = match;
      const audioBuffer = Buffer.from(base64, 'base64');
      const result = await this.aiGateway.transcribeAudio(ctx, { audioBuffer, mimeType }, 'openai');
      return parseAiJson<TranscriptSegment[]>(result.content);
    } catch (error) {
      this.logger.warn(`Retranscription après AUDIO_REGEN échouée, transcript précédent conservé : ${error}`);
      return null;
    }
  }
}
