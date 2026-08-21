import { JudgeCriterionName, WEIGHTS, CRITICAL_FLOOR, ADVERTISING_EFFECTIVENESS_CRITERIA } from './video-judge.types';
import { PASS_THRESHOLD } from './video-judge.service';
import { RepairStrategy } from './repair-dispatch';
import { CREDIT_COSTS } from '../../plans/plan-catalog';

// Phase C — Score de priorité pour choisir quel défaut réparer en premier (chantier "Moteur
// d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Section 5-6). Fonctions PURES, coût
// zéro — même convention que shot-diversity.ts/repair-history.ts.
export type DefectSeverity = 'CRITIQUE' | 'IMPORTANT' | 'MINEUR';

export function computeSeverity(score: number): DefectSeverity {
  if (score < CRITICAL_FLOOR) return 'CRITIQUE';
  if (score < PASS_THRESHOLD) return 'IMPORTANT';
  return 'MINEUR';
}

// Mappe chaque stratégie vers le taskType facturé correspondant (cf. repair-dispatch.ts
// commentaires : CLIP_REGEN->generateVideo, AUDIO_REGEN->generateAudio, SUBTITLE_ONLY->generateText).
// AUCUN nouveau tarif inventé ici — CREDIT_COSTS (plan-catalog.ts) reste la seule grille. Exportée
// (Mission 4, repair log enrichi — quality-report.ts) : la même grille sert à estimer le coût
// d'une réparation dans le rapport, jamais dupliquée.
export function strategyCost(strategy: RepairStrategy): number {
  const c = CREDIT_COSTS.campaign_generation;
  if (strategy === 'CLIP_REGEN') return c.generateVideo;
  if (strategy === 'AUDIO_REGEN') return c.generateAudio;
  if (strategy === 'SUBTITLE_ONLY') return c.generateText;
  return Infinity; // UNREPAIRABLE — jamais sélectionné, coût infini par construction
}

// Multiplicateur de sévérité — écart volontairement large (CRITIQUE traité 3x plus prioritaire
// qu'un défaut MINEUR à poids/coût égaux) pour qu'un défaut critique passe TOUJOURS avant un
// défaut mineur, même coûteux à ignorer.
const SEVERITY_MULTIPLIER: Record<DefectSeverity, number> = { CRITIQUE: 3, IMPORTANT: 2, MINEUR: 1 };
// Bonus pour un critère publicitaire (persuasion) vs purement visuel — reflète la Règle 2 du spec
// ("l'efficacité publicitaire prime sur l'esthétique") jusque dans l'ordre de réparation.
const ADVERTISING_IMPACT_MULTIPLIER = 1.5;

export interface PriorityInput {
  criterion: JudgeCriterionName;
  score: number;
  strategy: RepairStrategy;
}

export function computePriority(input: PriorityInput): number {
  const severity = computeSeverity(input.score);
  const adImpact = ADVERTISING_EFFECTIVENESS_CRITERIA.includes(input.criterion);
  const weight = WEIGHTS[input.criterion] ?? 0;
  const cost = strategyCost(input.strategy);
  if (cost === Infinity) return 0;
  return (weight * SEVERITY_MULTIPLIER[severity] * (adImpact ? ADVERTISING_IMPACT_MULTIPLIER : 1)) / cost;
}

// Trie par priorité DÉCROISSANTE — ne réordonne jamais les paliers de coût déjà en place
// (REPAIR_STRATEGY_COST_ORDER, cf. repair-dispatch.ts) : cette fonction est appliquée par
// VideoQualityLoopService.applyRepairs UNIQUEMENT à l'intérieur d'un même palier, jamais entre
// SUBTITLE_ONLY et CLIP_REGEN.
export function rankDefects<T extends PriorityInput>(defects: T[]): T[] {
  return [...defects].sort((a, b) => computePriority(b) - computePriority(a));
}

// Spec Section 5 : un défaut MINEUR n'est réparé que si le correctif est "très peu coûteux" —
// jamais 150 crédits (CLIP_REGEN) ni même ~4 crédits (AUDIO_REGEN) pour un défaut mineur, seul
// SUBTITLE_ONLY (0-8 crédits, aucun média régénéré) reste éligible.
export function isRepairAllowedForSeverity(severity: DefectSeverity, strategy: RepairStrategy): boolean {
  if (severity !== 'MINEUR') return true;
  return strategy === 'SUBTITLE_ONLY';
}

// Phase L — Valeur attendue avant génération (chantier "Optimisation du pipeline vidéo — V2.1",
// 2026-08-19, spec Section 6-7 : "75 sans défaut critique est un succès, ne pas chercher 77").
// Fonctions PURES, coût zéro — additif à ce module, aucune signature existante changée.
export interface ExpectedValueInput {
  priority: number; // déjà calculée par computePriority
  attemptsRemaining: number;
  currentScore: number;
  hasCriticalDefect: boolean;
}

// Pénalise les cycles tardifs : plus il reste de tentatives, plus regénérer maintenant a de la
// valeur (un score corrigé tôt profite à tous les tours suivants restants) ; à 0 tentative
// restante, la priorité brute seule reste le signal (pas de bonus "tours futurs"). Multiplicateur
// simple, point de départ documenté (même convention que WEIGHTS, cf. video-judge.types.ts) —
// aucun facteur temps ici, aucune horloge fiable n'existe avant la Phase Q, cf. plan.
export function computeExpectedValue(input: ExpectedValueInput): number {
  return input.priority * (1 + Math.max(0, input.attemptsRemaining));
}

// Seuil de départ documenté (spec Section 7) : sous cette valeur, poursuivre un défaut
// IMPORTANT déjà sous le seuil de succès n'est plus rentable — jamais appliqué à un défaut
// CRITIQUE (cf. hasCriticalDefect ci-dessous, qui court-circuite toujours vers REGENERATE).
export const MIN_EXPECTED_VALUE = 0.5;

export function shouldRegenerate(input: ExpectedValueInput): { decision: 'REGENERATE' | 'DO_NOT_REGENERATE'; reason: string } {
  if (input.hasCriticalDefect) {
    return { decision: 'REGENERATE', reason: 'Défaut critique présent — jamais bloqué par le calcul de valeur attendue' };
  }
  if (input.currentScore >= PASS_THRESHOLD) {
    const expectedValue = computeExpectedValue(input);
    if (expectedValue < MIN_EXPECTED_VALUE) {
      return {
        decision: 'DO_NOT_REGENERATE',
        reason: `Score déjà au-dessus du seuil (${input.currentScore} >= ${PASS_THRESHOLD}) et gain attendu faible (${expectedValue.toFixed(2)} < ${MIN_EXPECTED_VALUE})`,
      };
    }
  }
  return { decision: 'REGENERATE', reason: 'Gain attendu suffisant ou score encore sous le seuil de succès' };
}

