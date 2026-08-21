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
  // true dès qu'au moins un plan planifié n'a pas été livré — TOUJOURS renseigné, y compris
  // quand ce n'est pas bloquant (cf. MIN_SHOT_DELIVERY_RATIO ci-dessous) : le signal ne doit
  // JAMAIS dépendre de savoir si le seuil de blocage a été atteint (P0-4).
  partialDelivery: boolean;
}

// Seul format produit par le pipeline aujourd'hui (P0, décision de périmètre explicite) — ce
// contrôle reste un point d'extension documenté, pas une vraie logique multi-format.
const SUPPORTED_FORMAT = '9:16';

// Audit forensique Mission 4.2 (P0-4) : NE PAS bloquer automatiquement toute livraison partielle
// — la correction obligatoire de cette même mission ("ne pas considérer automatiquement une
// vidéo 3/4 comme livrable... puis appliquer les gates normaux") demande explicitement que le
// Video Judge et les gates existants restent seuls juges de la qualité d'une vidéo partielle,
// jamais un rejet automatique dès le 1er plan manquant. Ce seuil est un filet de sécurité pour
// le cas dégénéré (ex. 1 plan livré sur 5), pas un plancher de complétude à 100% — configurable,
// documenté, jamais le même symbole qu'un autre seuil du pipeline (cf. PASS_THRESHOLD etc.).
const MIN_SHOT_DELIVERY_RATIO = 0.5;

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
  if (partialDelivery && input.deliveredShotCount / input.plannedShotCount < MIN_SHOT_DELIVERY_RATIO) {
    blockingReasons.push(
      `Livraison trop partielle : ${input.deliveredShotCount}/${input.plannedShotCount} plan(s) prévu(s) réellement livré(s) (minimum ${Math.ceil(MIN_SHOT_DELIVERY_RATIO * 100)}%)`,
    );
  }

  return { deliverable: blockingReasons.length === 0, blockingReasons, partialDelivery };
}
