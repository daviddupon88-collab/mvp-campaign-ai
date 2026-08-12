// Décroissance temporelle (Phase 8) — ajuste la confiance EN LECTURE seulement, jamais en
// réécrivant confidenceScore en base : une connaissance ancienne perd du poids dans le
// classement/la sélection (cf. BrandMemoryQueryService), mais n'est jamais supprimée ni
// dégradée silencieusement dans son état stocké. Une entrée régulièrement reconfirmée
// (lastObservedAt récent, via recordObservation) ne décroît jamais puisque la décroissance
// repart de zéro depuis la dernière observation, pas depuis la création.

// Demi-vie : au bout de HALF_LIFE_DAYS sans nouvelle confirmation, le poids effectif d'une
// connaissance est divisé par deux. Repère raisonnable plutôt que dérivé de données réelles
// (pas encore assez de volume en production pour le calibrer) — cf. limitations connues.
const HALF_LIFE_DAYS = 120;

// Plancher : une connaissance ancienne garde toujours un poids résiduel non nul — elle reste
// consultable/explicable, seulement moins prioritaire dans la sélection de contexte.
const DECAY_FLOOR = 0.05;

export function daysSince(date: Date, now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

// Retourne un multiplicateur [DECAY_FLOOR, 1] à appliquer à confidenceScore — jamais la
// valeur stockée elle-même, qui reste intacte pour l'audit/l'historique.
export function decayFactor(lastObservedAt: Date, now: Date = new Date()): number {
  const days = daysSince(lastObservedAt, now);
  const factor = Math.pow(0.5, days / HALF_LIFE_DAYS);
  return Math.max(DECAY_FLOOR, factor);
}

export function computeEffectiveConfidence(storedConfidence: number, lastObservedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.min(1, storedConfidence * decayFactor(lastObservedAt, now)));
}
