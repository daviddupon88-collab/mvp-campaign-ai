import { JudgeCriterionName, JudgeCriterionResult, UNAVAILABLE_DEFECT } from './video-judge.types';
import { RepairHistoryEntry } from './repair-history';

// Phase K — Cause racine (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19, spec
// Section 3-5). Fonction PURE, coût zéro — même convention que repair-history.ts/repair-priority.ts.
// Détermine à QUEL NIVEAU du pipeline une réparation doit être tentée : une scène qui rate un
// détail visuel (SCENE) n'a pas la même cause qu'un scénario qui ne convainc jamais (CONCEPT).
export type RootCauseLevel =
  | 'SCENE'
  | 'STORYBOARD'
  | 'CONCEPT'
  | 'PROVIDER'
  | 'ASSEMBLY'
  | 'AUDIO'
  | 'BRAND'
  | 'PRODUCT_FIDELITY'
  | 'UNKNOWN'
  // Mission 4 Phase G ("Creative Video & Audio Intelligence", 2026-08-20) — extension MINIMALE :
  // seules les valeurs qui changent réellement la décision de réparation (repair-dispatch.ts).
  | 'VOICE'
  | 'VISUAL_COMPOSITION'
  // Corrige un gap réel confirmé par l'audit : pacing/textReadability/grammar retombaient sur
  // UNKNOWN alors qu'ils mappent déjà tous les trois sur SUBTITLE_ONLY (repair-dispatch.ts) —
  // root-cause manquant, pas une nouvelle catégorie de défaut.
  | 'SUBTITLE';

// Critères ambigus entre STORYBOARD et CONCEPT (aucun signal du Judge aujourd'hui ne les
// distingue) : classés STORYBOARD par défaut (spec Section 5, "toujours réparer au niveau le
// plus bas possible"), et ne deviennent CONCEPT que si l'historique prouve qu'une escalade
// STORYBOARD a déjà été tentée sans succès significatif sur EXACTEMENT ce critère.
const AMBIGUOUS_STORYBOARD_OR_CONCEPT: JudgeCriterionName[] = ['storytelling', 'hookStrength', 'advertisingEffectiveness'];

const DETERMINISTIC_ROOT_CAUSE: Partial<Record<JudgeCriterionName, RootCauseLevel>> = {
  factualConsistency: 'CONCEPT',
  brandCoherence: 'BRAND',
  audioQuality: 'AUDIO',
  voiceAudibility: 'AUDIO',
  ctaClarity: 'AUDIO',
  // Mission 4 Phase G : formatCompliance est désormais une mesure RÉELLE de composition
  // (cropdetect, Phase A) — rejoint VISUAL_COMPOSITION plutôt que le rubber-stamp ASSEMBLY
  // hérité de l'époque où ce critère valait toujours 100.
  formatCompliance: 'VISUAL_COMPOSITION',
  visualComposition: 'VISUAL_COMPOSITION',
  sceneConsistency: 'VISUAL_COMPOSITION',
  voiceDynamism: 'VOICE',
  voicePacing: 'VOICE',
  pacing: 'SUBTITLE',
  textReadability: 'SUBTITLE',
  grammar: 'SUBTITLE',
};

// Une escalade STORYBOARD est jugée "déjà tentée sans succès" si l'historique contient une
// entrée pour ce critère (n'importe quelle scène, n'importe quelle stratégie) classée ECHEC ou
// FAIBLE — signe qu'agir au niveau du plan de tournage n'a pas suffi.
function storyboardEscalationAlreadyFailed(history: RepairHistoryEntry[], criterion: JudgeCriterionName): boolean {
  return history.some((e) => e.criterion === criterion && (e.outcome === 'ECHEC' || e.outcome === 'FAIBLE'));
}

// Un défaut produit (productConsistency/productVisibility) attribué à une scène précise est
// d'abord traité comme un problème de tirage (SCENE, cf. CLIP_REGEN). S'il a déjà échoué 2 fois
// via CLIP_REGEN sur cette même scène, le fournisseur rend probablement le produit de façon
// systématiquement incorrecte — PRODUCT_FIDELITY signale que régénérer une 3e fois ne suffira
// pas, sans pour autant remonter jusqu'au storyboard ou au concept (le défaut reste local à
// cette scène).
function clipRegenFailureCount(history: RepairHistoryEntry[], criterion: JudgeCriterionName, sceneId: string | undefined): number {
  return history.filter((e) => e.criterion === criterion && e.sceneId === sceneId && e.strategy === 'CLIP_REGEN' && e.outcome === 'ECHEC').length;
}

// Mission 3 (validation empirique, 2026-08-20) — les 9 critères produits par L'UNIQUE appel texte
// groupé du Judge (cf. VideoJudgeService.buildTextCriteria). Si cet appel échoue/mal-parse, TOUS
// reçoivent SIMULTANÉMENT UNAVAILABLE_DEFECT dans le MÊME jugement — confirmé sur 3 campagnes
// réelles historiques (audit `CreativeGenerationTrace.judgeAttempts`), où ce schéma a été
// classifié comme 9 vrais défauts de contenu et a déclenché 2 cycles de réparation qui ne
// pouvaient structurellement rien corriger.
const GROUPED_TEXT_CRITERIA: JudgeCriterionName[] = [
  'storytelling', 'hookStrength', 'pacing', 'textReadability', 'grammar', 'ctaClarity', 'brandCoherence', 'factualConsistency', 'advertisingEffectiveness',
];
// Majorité de 9 — valeur de départ documentée (même convention que WEIGHTS/MIN_EXPECTED_VALUE),
// à recalibrer si un jour un appel groupé partiel devient possible (aujourd'hui, tout ou rien).
const UNAVAILABLE_MAJORITY_THRESHOLD = 5;

function isJudgeCallUnavailable(allCriteria: JudgeCriterionResult[] | undefined): boolean {
  if (!allCriteria) return false;
  const unavailableCount = allCriteria.filter((c) => GROUPED_TEXT_CRITERIA.includes(c.name) && c.defect === UNAVAILABLE_DEFECT).length;
  return unavailableCount >= UNAVAILABLE_MAJORITY_THRESHOLD;
}

export function classifyRootCause(
  criterion: JudgeCriterionName,
  context: { sceneRef?: string; history: RepairHistoryEntry[]; allCriteria?: JudgeCriterionResult[] },
): RootCauseLevel {
  const { sceneRef, history, allCriteria } = context;

  // Court-circuit PRIORITAIRE, avant toute classification par critère individuel : si l'appel
  // Judge groupé a manifestement échoué (majorité de ses 9 critères marqués UNAVAILABLE_DEFECT
  // dans ce MÊME jugement), la cause est le FOURNISSEUR — jamais le storyboard/concept, quel que
  // soit `criterion`. Inspecte TOUS les critères du jugement, pas seulement celui passé en
  // paramètre : le défaut "prioritaire" au sens computePriority n'est pas nécessairement l'un des
  // 9 (un vrai défaut audio/produit coexistant peut être classé prioritaire par son poids/coût,
  // cf. cas réel qui a motivé ce fix) — sans cette inspection large, l'échec du Judge resterait
  // invisible et le pipeline escaladerait storyboard/concept pour rien.
  if (isJudgeCallUnavailable(allCriteria)) {
    return 'PROVIDER';
  }

  if (AMBIGUOUS_STORYBOARD_OR_CONCEPT.includes(criterion)) {
    return storyboardEscalationAlreadyFailed(history, criterion) ? 'CONCEPT' : 'STORYBOARD';
  }

  if (criterion === 'productConsistency' || criterion === 'productVisibility') {
    if (sceneRef && clipRegenFailureCount(history, criterion, sceneRef) >= 2) {
      return 'PRODUCT_FIDELITY';
    }
    return 'SCENE';
  }

  return DETERMINISTIC_ROOT_CAUSE[criterion] ?? 'UNKNOWN';
}
