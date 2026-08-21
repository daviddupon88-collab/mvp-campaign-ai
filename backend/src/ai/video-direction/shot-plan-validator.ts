import { ShotPlan, isShotStructurallyValid } from './video-director.service';

// Phase E (chantier "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Section
// 23-24 : "ne jamais utiliser un cycle de génération de 15 minutes pour découvrir un défaut
// détectable avant"). Fonction PURE, coût zéro (aucun appel IA) — même convention que
// shot-diversity.ts. Placée juste avant la boucle de génération vidéo (generateVideo, 150
// crédits/plan) : un plan structurellement brisé ne doit jamais atteindre cette boucle.
export interface ShotPlanValidationResult {
  passed: boolean;
  reasons: string[];
  // Audit forensique Mission 4.2 (P0-2) : non-bloquant (n'affecte jamais `passed` — un plan
  // partiellement comblé par DEFAULT_SHOT_PLAN reste structurellement valide et n'a jamais dû
  // faire échouer la génération) mais visible, pour ne plus jamais laisser une substitution
  // générique passer totalement inaperçue.
  warnings: string[];
}

// Durée par défaut d'un plan sans `duration` explicite — alignée sur `durationSeconds: 6` déjà
// utilisé partout ailleurs pour l'appel `generateVideo` (cf. AiOrchestratorService), pas une
// valeur inventée ici.
const DEFAULT_SHOT_DURATION_SECONDS = 6;
const MIN_TOTAL_DURATION_SECONDS = 5;
const MAX_TOTAL_DURATION_SECONDS = 90;

export function validateShotPlan(shotPlan: ShotPlan, expected: { shotCount: number }): ShotPlanValidationResult {
  const reasons: string[] = [];

  if (shotPlan.length === 0) {
    return { passed: false, reasons: ['le plan de tournage est vide'], warnings: [] };
  }

  if (shotPlan.length !== expected.shotCount) {
    reasons.push(`nombre de plans incorrect : ${shotPlan.length} généré(s) au lieu de ${expected.shotCount} attendu(s) par le concept créatif`);
  }

  // Annotation de retour explicite (: boolean) nécessaire : sans elle, TS infère parfois ce
  // callback comme un type predicate négatif (`shot is never`) à cause de isShotStructurallyValid,
  // ce qui ferait typer invalidShots en never[] au lieu de Shot[].
  const invalidShots = shotPlan.filter((shot): boolean => !isShotStructurallyValid(shot));
  if (invalidShots.length > 0) {
    reasons.push(`${invalidShots.length} plan(s) avec des champs requis manquants (camera/subject/motion/lighting/background) : ${invalidShots.map((s) => s.sceneId).join(', ')}`);
  }

  // Signal CTA minimal — pas une vérification de mot-clé (aucune liste de mots inventée ici),
  // juste : au moins UN plan porte un texte destiné au spectateur. Un plan sans aucun texte à
  // l'écran ni voix off ne peut structurellement porter aucun appel à l'action.
  const hasAnyText = shotPlan.some((shot) => Boolean(shot.onScreenText?.trim()) || Boolean(shot.voiceover?.trim()));
  if (!hasAnyText) {
    reasons.push("aucun plan ne porte de texte à l'écran ni de voix off — aucun appel à l'action possible");
  }

  const totalDuration = shotPlan.reduce((sum, shot) => sum + (shot.duration ?? DEFAULT_SHOT_DURATION_SECONDS), 0);
  if (totalDuration < MIN_TOTAL_DURATION_SECONDS || totalDuration > MAX_TOTAL_DURATION_SECONDS) {
    reasons.push(`durée totale implausible : ${totalDuration}s (attendu entre ${MIN_TOTAL_DURATION_SECONDS}s et ${MAX_TOTAL_DURATION_SECONDS}s)`);
  }

  const warnings: string[] = [];
  const fallbackShots = shotPlan.filter((shot) => shot.usedFallbackTemplate);
  if (fallbackShots.length > 0) {
    warnings.push(`${fallbackShots.length} plan(s) généré(s) sont un gabarit générique de repli (entrée individuellement malformée dans la réponse du modèle) : ${fallbackShots.map((s) => s.sceneId).join(', ')}`);
  }

  return { passed: reasons.length === 0, reasons, warnings };
}
