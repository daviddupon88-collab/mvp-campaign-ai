import { Shot, ShotPlan } from './video-director.service';

// Phase I — Faisabilité, risque et priorité de génération par scène (chantier "Moteur
// d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Sections 54-55, 57). Fonctions
// PURES, coût zéro (aucun appel IA) — même convention que shot-diversity.ts.
export type SceneRisk = 'FAIBLE' | 'MOYEN' | 'ÉLEVÉ';

// Signaux de complexité (spec Section 55) recherchés dans le texte déjà présent sur le plan
// (action/motion/characters/visualDetails/onScreenText) — heuristique DOCUMENTÉE comme un proxy,
// pas une garantie (le fournisseur vidéo n'expose aucune API de capacités interrogeable, cf.
// plan) : plus un plan cumule de signaux, plus il a statistiquement de chances d'échouer/décevoir
// à la génération, sans certitude individuelle.
// \w* en suffixe (pas \b strict) : tolère les conjugaisons (talk/talks/talking) sans avoir à
// lister chaque forme — un texte au présent simple ("talks") ne doit pas échapper au signal
// juste parce que la forme exacte "talk" n'apparaît pas telle quelle.
const RISK_SIGNALS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(talk\w*|speak\w*|dialogue\w*|lip[- ]?sync\w*|mouth\w*)\b/i, label: 'synchronisation labiale' },
  { pattern: /\b(transform\w*|morph\w*|change[s]? shape|melt\w*|assemble\w*|disassemble\w*)\b/i, label: 'transformation complexe' },
  { pattern: /\b(multiple people|several people|crowd\w*|group of)\b/i, label: 'plusieurs personnages' },
  { pattern: /\b(interact\w*|hand[s]? (holding|touching|grabbing))\b/i, label: 'interaction physique complexe' },
  { pattern: /\b(many objects|several objects|cluttered|numerous items)\b/i, label: "nombre élevé d'objets" },
];

const MULTIPLE_CHARACTERS_PATTERN = /,| and |&/i; // characters listant plusieurs noms/rôles séparés
const LONG_ON_SCREEN_TEXT_THRESHOLD = 60; // caractères — au-delà, texte généré dans la vidéo jugé risqué (lisibilité)

function combinedText(shot: Shot): string {
  return [shot.action, shot.motion, shot.visualDetails, shot.soundDesign].filter(Boolean).join(' ');
}

function countRiskSignals(shot: Shot): number {
  const text = combinedText(shot);
  let count = RISK_SIGNALS.filter((s) => s.pattern.test(text)).length;
  if (shot.characters && MULTIPLE_CHARACTERS_PATTERN.test(shot.characters)) count += 1;
  if (shot.onScreenText && shot.onScreenText.length > LONG_ON_SCREEN_TEXT_THRESHOLD) count += 1;
  return count;
}

export function classifySceneRisk(shot: Shot): SceneRisk {
  const count = countRiskSignals(shot);
  if (count >= 3) return 'ÉLEVÉ';
  if (count >= 1) return 'MOYEN';
  return 'FAIBLE';
}

// Priorité de génération (spec Section 57) — les scènes les plus importantes pour le message
// publicitaire (hook, démonstration produit, CTA/payoff) sont générées EN PREMIER, réutilisant
// narrativeRole déjà présent sur Shot (P0.3) plutôt qu'un nouveau champ. Score purement ordinal,
// jamais persisté — sert uniquement à trier la boucle de génération.
const NARRATIVE_ROLE_PRIORITY: { pattern: RegExp; priority: number }[] = [
  { pattern: /hook/i, priority: 4 },
  { pattern: /demonstration|product/i, priority: 3 },
  { pattern: /cta|payoff/i, priority: 2 },
];
const SECONDARY_PRIORITY = 1;

export function computeGenerationPriority(shot: Shot): number {
  const role = shot.narrativeRole ?? '';
  const match = NARRATIVE_ROLE_PRIORITY.find((r) => r.pattern.test(role));
  return match?.priority ?? SECONDARY_PRIORITY;
}

// Trie par priorité décroissante — tri STABLE (Array.prototype.sort est stable en JS moderne),
// préserve l'ordre relatif des scènes de même priorité plutôt que de le mélanger arbitrairement.
export function sortByGenerationPriority(shotPlan: ShotPlan): ShotPlan {
  return [...shotPlan].sort((a, b) => computeGenerationPriority(b) - computeGenerationPriority(a));
}
