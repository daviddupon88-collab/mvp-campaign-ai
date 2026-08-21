import { JudgeCriterionName } from './video-judge.types';
import { RepairStrategy } from './repair-dispatch';

// Phase B — Historique anti-boucle réellement consulté + escalade de la correction (chantier
// "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Section 3-4). Fonctions
// PURES, coût zéro — même convention que shot-diversity.ts/repair-priority.ts.
export type RepairOutcomeClass = 'SIGNIFICANT' | 'FAIBLE' | 'ECHEC'; // seuils du spec : ≥+5 / 0-4 / <0

export interface RepairHistoryEntry {
  criterion: JudgeCriterionName;
  sceneId?: string;
  strategy: RepairStrategy;
  scoreDelta: number;
  outcome: RepairOutcomeClass;
}

export function classifyOutcome(scoreDelta: number): RepairOutcomeClass {
  if (scoreDelta >= 5) return 'SIGNIFICANT';
  if (scoreDelta >= 0) return 'FAIBLE';
  return 'ECHEC';
}

// Ne bloque QUE les stratégies déjà classées ECHEC (une réparation qui a activement AGGRAVÉ le
// défaut) — jamais une stratégie FAIBLE, qui mérite UNE correction escalade (texte plus radical)
// avant d'être abandonnée, cf. buildEscalation ci-dessous. "Une stratégie ayant échoué ne doit
// jamais être répétée à l'identique" (spec Section 4) : ECHEC = identique inutile, skip complet.
export function shouldSkipStrategy(history: RepairHistoryEntry[], criterion: JudgeCriterionName, sceneId: string | undefined, strategy: RepairStrategy): boolean {
  return history.some((e) => e.criterion === criterion && e.sceneId === sceneId && e.strategy === strategy && e.outcome === 'ECHEC');
}

// Une correction mérite d'être ESCALADÉE (texte de correction renforcé, cf.
// VideoDirectorService.repairShotPrompt) si une tentative précédente sur EXACTEMENT ce
// (critère, scène, stratégie) a eu un résultat FAIBLE — un progrès insuffisant, pas un échec net,
// donc pas bloquée par shouldSkipStrategy, mais qui ne doit jamais être retentée à l'identique.
export function needsEscalation(history: RepairHistoryEntry[], criterion: JudgeCriterionName, sceneId: string | undefined, strategy: RepairStrategy): boolean {
  return history.some((e) => e.criterion === criterion && e.sceneId === sceneId && e.strategy === strategy && e.outcome === 'FAIBLE');
}
