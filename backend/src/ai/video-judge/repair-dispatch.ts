import { JudgeCriterionName, JudgeCriterionResult } from './video-judge.types';

// P0.6 — Réparation à coût étagé (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Classifieur PUR (aucune I/O) : pour chaque critère du Video Judge en défaut,
// détermine la stratégie de réparation la MOINS COÛTEUSE qui peut réellement le corriger —
// c'est la décision de conception centrale de la Phase 14 (contrôle des coûts) du brief :
// régénérer un clip vidéo (150 crédits) n'est justifié QUE pour un défaut que rien de moins cher
// ne peut corriger.
export type RepairStrategy = 'CLIP_REGEN' | 'SUBTITLE_ONLY' | 'AUDIO_REGEN' | 'UNREPAIRABLE';

// CLIP_REGEN (~150 crédits, cf. AiOrchestratorService.repairShotPrompt) : le défaut est dans le
// CONTENU FILMÉ lui-même — rien de moins cher ne peut le corriger.
// SUBTITLE_ONLY (0-8 crédits) : le défaut est dans le TEXTE affiché/le rythme des sous-titres —
// corrigeable en ré-écrivant/ré-timant le SRT, sans re-générer aucun média (cf.
// VideoQualityLoopService, P0.7).
// AUDIO_REGEN (~4 crédits) : le défaut est dans LA VOIX elle-même — corrigeable en régénérant
// narration + transcription, sans toucher aux clips vidéo.
// UNREPAIRABLE : jugement holistique (storytelling, ton de marque...) sans correctif mécanique
// ciblé — remonté tel quel dans la trace d'observabilité (P0.11), jamais une tentative aveugle.
const REPAIR_STRATEGY_BY_CRITERION: Record<JudgeCriterionName, RepairStrategy> = {
  motionDynamism: 'CLIP_REGEN',
  productConsistency: 'CLIP_REGEN',
  productVisibility: 'CLIP_REGEN',
  textReadability: 'SUBTITLE_ONLY',
  pacing: 'SUBTITLE_ONLY',
  grammar: 'SUBTITLE_ONLY',
  ctaClarity: 'AUDIO_REGEN', // repli conservateur : le CTA est supposé parlé, cf. plan
  audioQuality: 'AUDIO_REGEN',
  voiceAudibility: 'AUDIO_REGEN',
  // Mission 4 Phase H — le défaut est dans LA VOIX (dynamique/débit), corrigeable en régénérant
  // narration + transcription (nouvelle direction vocale, cf. Phase E), jamais les clips vidéo.
  voiceDynamism: 'AUDIO_REGEN',
  voicePacing: 'AUDIO_REGEN',
  // Mission 4 Phase H — le défaut PEUT être dans le CONTENU FILMÉ d'un plan précis (géométrie
  // de cadrage) — CLIP_REGEN est la bonne portée, mais UNIQUEMENT si isClipRegenGateSatisfied()
  // l'autorise (ci-dessous) ; sinon `applyRepairs` (video-quality-loop.service.ts) le remonte
  // comme UNREPAIRABLE, sans jamais tenter un CLIP_REGEN aveugle sur la pire scène notée.
  formatCompliance: 'CLIP_REGEN',
  storytelling: 'UNREPAIRABLE',
  hookStrength: 'UNREPAIRABLE',
  brandCoherence: 'UNREPAIRABLE',
  advertisingEffectiveness: 'UNREPAIRABLE',
  factualConsistency: 'UNREPAIRABLE',
  // Mission 4 Phase A : jugement créatif holistique (cadrage/équilibre), pas de correctif
  // mécanique ciblé — jamais CLIP_REGEN, contrairement à formatCompliance (géométrie) et
  // sceneConsistency (cohérence inter-plans), qui EUX peuvent être réparés ciblés sous gate.
  visualComposition: 'UNREPAIRABLE',
  // Mission 4 Phase H — même logique que formatCompliance ci-dessus, sous son propre gate
  // (repairConfidenceThreshold, distinct de formatRepairConfidenceThreshold — jamais le même
  // seuil réutilisé entre les deux critères, Round 4).
  sceneConsistency: 'CLIP_REGEN',
};

export function classifyRepair(criterion: JudgeCriterionName): RepairStrategy {
  return REPAIR_STRATEGY_BY_CRITERION[criterion];
}

// Mission 4 Phase H — gate de confiance DÉDIÉ pour les deux seuls critères CLIP_REGEN "mesurés
// par géométrie/vision comparative" introduits par cette mission : un défaut formatCompliance ou
// sceneConsistency n'est JAMAIS dispatché en CLIP_REGEN sans satisfaire son propre gate — jamais
// de repli sur la pire scène notée pour CES deux critères précisément (contrairement aux critères
// CLIP_REGEN préexistants — motionDynamism/productConsistency/productVisibility — qui gardent
// leur comportement historique, `worstSceneId` en repli, cf. VideoQualityLoopService.applyRepairs).
// Deux constantes DISTINCTES, jamais interchangées (Round 4, Correction obligatoire) : même valeur
// de départ documentée, mais deux symboles séparés pour pouvoir être recalibrés indépendamment.
export const FORMAT_REPAIR_CONFIDENCE_THRESHOLD = 0.7;
export const SCENE_REPAIR_CONFIDENCE_THRESHOLD = 0.7;

export function isClipRegenGateSatisfied(defect: JudgeCriterionResult): boolean {
  if (defect.name === 'formatCompliance') {
    return typeof defect.confidence === 'number' && defect.confidence >= FORMAT_REPAIR_CONFIDENCE_THRESHOLD && Boolean(defect.sceneRef);
  }
  if (defect.name === 'sceneConsistency') {
    return typeof defect.confidence === 'number' && defect.confidence >= SCENE_REPAIR_CONFIDENCE_THRESHOLD && Boolean(defect.sceneRef);
  }
  // Tout autre critère CLIP_REGEN : comportement historique inchangé, aucun gate supplémentaire.
  return true;
}

// Ordre de coût croissant — VideoQualityLoopService applique les stratégies dans cet ordre
// (jamais l'inverse) : si un même passage de réparation doit traiter plusieurs défauts,
// SUBTITLE_ONLY/AUDIO_REGEN sont toujours tentés avant tout CLIP_REGEN.
export const REPAIR_STRATEGY_COST_ORDER: RepairStrategy[] = ['SUBTITLE_ONLY', 'AUDIO_REGEN', 'CLIP_REGEN', 'UNREPAIRABLE'];

// Phase O — Cache/réutilisation de scène : confirmation + durcissement (chantier "Optimisation
// du pipeline vidéo — V2.1", 2026-08-19, spec Section 14-15, "ne jamais régénérer une scène déjà
// valide"). Rend explicite un comportement qui existe déjà implicitement dans
// VideoQualityLoopService.applyRepairs (CLIP_REGEN cible toujours un sceneId précis, jamais
// toutes les scènes) — type nommé uniquement, aucune logique nouvelle.
export type RepairScope = 'SCENE_ONLY' | 'SCENE_GROUP' | 'STORYBOARD' | 'CONCEPT' | 'FULL_REGENERATION';

// CLIP_REGEN cible toujours UN sceneId précis (résolu depuis defect.sceneRef ou la pire scène
// notée, cf. applyRepairs) -> SCENE_ONLY. SUBTITLE_ONLY/AUDIO_REGEN n'ont pas de portée par scène
// (transcript/narration entiers) -> SCENE_GROUP. STORYBOARD/CONCEPT sont réservés aux escalades
// de la Phase P — jamais retournés par cette fonction, qui ne connaît que les 3 stratégies P0.6.
export function repairScopeForStrategy(strategy: RepairStrategy): RepairScope {
  if (strategy === 'CLIP_REGEN') return 'SCENE_ONLY';
  return 'SCENE_GROUP';
}
