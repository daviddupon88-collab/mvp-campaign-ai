import { VideoJudgeResult } from './video-judge.types';
import { CreativeGateStatus } from '../creative-intelligence/creative-gate.types';
import { StoryboardGateStatus } from '../video-direction/storyboard-gate.types';
import { TranscriptSegment } from '../ai-gateway/providers/ai-provider.interface';

// Phase J — Final Advertising Gate (chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 59-61). Fonction PURE, câblage final : ET logique stricte entre
// toutes les portes déjà franchies — aucun nouveau jugement, aucun nouvel appel IA.
export interface FinalDeliveryInput {
  creativeGateStatus: CreativeGateStatus;
  storyboardGateStatus: StoryboardGateStatus;
  judge: VideoJudgeResult; // porte déjà globalScore/verdict/visualQuality/advertisingEffectiveness (Phase D)
  narrationDataUri: string | null;
  transcript: TranscriptSegment[] | null;
  format: string;
  // Audit forensique Mission 4.2 (P0-4) : nombre de plans PLANIFIÉS (ShotPlan.length) vs
  // réellement LIVRÉS (VideoClip[].length, après abandon éventuel de plans malgré récupération,
  // cf. AiOrchestratorService.generateShotPlanVideoOrDegrade) — sans ces deux champs, une vidéo
  // 3/4 était structurellement indiscernable d'une vidéo 4/4 complète.
  plannedShotCount: number;
  deliveredShotCount: number;
}

export interface FinalDeliveryResult {
  deliverable: boolean;
  blockingReasons: string[];
  // true dès qu'au moins un plan planifié n'a pas été livré. Depuis Mission 4.3 (Étape 14/18,
  // tolérance zéro), ce cas est TOUJOURS aussi présent dans blockingReasons — le champ reste
  // néanmoins distinct de `deliverable` pour que l'appelant puisse le citer explicitement (cf.
  // campaign-generation.processor.ts) sans reparser blockingReasons.
  partialDelivery: boolean;
}

// Seul format produit par le pipeline aujourd'hui (P0, décision de périmètre explicite) — ce
// contrôle reste un point d'extension documenté, pas une vraie logique multi-format.
const SUPPORTED_FORMAT = '9:16';

// Mission 4.3 (Goal-First Quality Architecture, Phase 1, Étape 14/18) — SUPERSÈDE la politique de
// tolérance 50% de l'audit forensique Mission 4.2 (P0-4). Cette même mission impose désormais une
// règle absolue explicite : "deliveredShots === plannedShots... Une vidéo 3/4 ne peut pas être
// considérée comme une livraison complète" (tolérance = 0). L'ancien raisonnement (laisser le
// Video Judge et les gates seuls juges d'une vidéo partielle, ne bloquer qu'un cas dégénéré) reste
// valable EN GÉNÉRAL, mais la construction goal-first vise justement à rendre la livraison
// partielle rare — quand elle survient malgré tout, elle doit être un signal dur, pas une
// tolérance silencieuse de 50%.
export function evaluateFinalDelivery(input: FinalDeliveryInput): FinalDeliveryResult {
  const blockingReasons: string[] = [];

  if (input.creativeGateStatus !== 'APPROVED') {
    blockingReasons.push(`Creative Gate non approuvé (statut ${input.creativeGateStatus})`);
  }
  if (input.storyboardGateStatus !== 'APPROVED') {
    blockingReasons.push(`Storyboard Gate non approuvé (statut ${input.storyboardGateStatus})`);
  }
  if (input.judge.verdict !== 'PASS') {
    blockingReasons.push(`Video Judge n'a pas atteint le verdict PASS (score global ${input.judge.globalScore}/100)`);
  }
  if (!input.narrationDataUri || !input.transcript || input.transcript.length === 0) {
    blockingReasons.push('Audio requis (narration/transcript) incomplet');
  }
  if (input.format !== SUPPORTED_FORMAT) {
    blockingReasons.push(`Format "${input.format}" non compatible avec la plateforme (seul ${SUPPORTED_FORMAT} est supporté)`);
  }

  const partialDelivery = input.plannedShotCount > 0 && input.deliveredShotCount < input.plannedShotCount;
  if (partialDelivery) {
    blockingReasons.push(
      `Livraison incomplète : ${input.deliveredShotCount}/${input.plannedShotCount} plan(s) prévu(s) réellement livré(s) — tolérance zéro (Mission 4.3, Étape 14/18)`,
    );
  }

  return { deliverable: blockingReasons.length === 0, blockingReasons, partialDelivery };
}
