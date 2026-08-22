// Mission 4.5 (Phases A2/B2 → A5/B5, 2026-08-22) — interrupteur EXPÉRIMENTAL TEMPORAIRE,
// traçable, créé UNIQUEMENT pour permettre de rejouer l'ancien comportement (pré-correctif) sur
// une campagne "contrôle" (Ax) alors que le correctif lui-même est déjà permanent dans le code
// pour toute campagne normale. Jamais destiné à rester après cette mission — à supprimer une
// fois les 5 paires A/B analysées (cf. rapport final Mission 4.5), avec les deux branches
// history les DEUX comportements historiques.
//
// Traçabilité : la valeur RÉELLE de ce flag au moment de chaque génération est désormais
// persistée dans CreativeGenerationTrace.narrationLegacyMode (cf.
// creative-generation-trace.service.ts, Mission 4.5 stabilisation infrastructure) — le nom de
// campagne (texte libre, non vérifiable) n'est plus la seule source pour distinguer contrôle
// (Ax) et expérimental (Bx) après coup.
const FLAG_NAME = 'MISSION_4_5_LEGACY_NARRATION';

// Bascule manuelle directe (Phases A2-A5) : plus fiable qu'une variable d'environnement sur un
// process déjà démarré en mode watch (nest --watch recharge ce fichier à chaque édition, jamais
// besoin de relancer le process ni de repropager une variable d'environnement externe). `null` =
// se rabat sur la variable d'environnement MISSION_4_5_LEGACY_NARRATION (comportement normal,
// hors expérimentation). Remis à `null` pendant la stabilisation infrastructure (aucune campagne
// A3 tant que le backend n'est pas confirmé stable) — remettre à `true`/`false` UNIQUEMENT pour
// relancer une paire Ax/Bx explicitement demandée, jamais par défaut.
const MANUAL_OVERRIDE: boolean | null = null; // Expérimentation terminée (5 paires A/B complètes, 2026-08-22)

export function isLegacyNarrationExperimentMode(): boolean {
  if (MANUAL_OVERRIDE !== null) return MANUAL_OVERRIDE;
  return process.env[FLAG_NAME] === 'true';
}
