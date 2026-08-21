import { VideoJudgeResult, JudgeCriterionName, CRITICAL_CRITERIA, CRITICAL_FLOOR } from './video-judge.types';

// Phase A — Mémoire de la meilleure version + protection contre les régressions (chantier
// "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Règles 19-20). Fonction
// PURE, coût zéro — même convention que shot-diversity.ts. Une réparation ne doit JAMAIS être
// conservée si elle corrige un défaut en en aggravant un autre plus grave : "Mouvement 45->75
// mais Fidélité produit 88->62 : RÉPARATION REJETÉE" (exemple du spec).
export interface RegressionCheck {
  accepted: boolean;
  reason?: string;
}

export function evaluateRepairOutcome(before: VideoJudgeResult, after: VideoJudgeResult): RegressionCheck {
  for (const name of CRITICAL_CRITERIA) {
    const beforeScore = before.criteria.find((c) => c.name === name)?.score ?? 0;
    const afterScore = after.criteria.find((c) => c.name === name)?.score ?? 0;
    // Rejeté si un critère CRITIQUE régresse ET tombe sous le plancher — un critère déjà sous le
    // plancher qui reste sous le plancher n'est pas une NOUVELLE régression (il n'y avait rien à
    // perdre), mais un critère qui FRANCHIT le plancher vers le bas à cause de cette réparation
    // précise doit annuler la réparation, quelle que soit l'amélioration obtenue ailleurs.
    if (afterScore < beforeScore && afterScore < CRITICAL_FLOOR) {
      return { accepted: false, reason: `le critère critique "${name}" régresse de ${beforeScore} à ${afterScore} (sous le plancher ${CRITICAL_FLOOR})` };
    }
  }

  if (after.globalScore < before.globalScore) {
    return { accepted: false, reason: `le score global régresse de ${before.globalScore} à ${after.globalScore}` };
  }

  return { accepted: true };
}

// Delta par critère (avant/après) — sert à la fois au rapport structuré (Phase F) et à
// l'historique anti-boucle (Phase B, classification SIGNIFICANT/FAIBLE/ECHEC par critère précis,
// pas seulement au niveau du score global).
export function computeCriterionDeltas(before: VideoJudgeResult, after: VideoJudgeResult): Map<JudgeCriterionName, number> {
  const deltas = new Map<JudgeCriterionName, number>();
  for (const afterCriterion of after.criteria) {
    const beforeScore = before.criteria.find((c) => c.name === afterCriterion.name)?.score ?? afterCriterion.score;
    deltas.set(afterCriterion.name, afterCriterion.score - beforeScore);
  }
  return deltas;
}
