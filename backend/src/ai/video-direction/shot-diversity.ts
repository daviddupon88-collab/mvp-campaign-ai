import { ShotPlan } from './video-director.service';

// P0.4 — Diversité de plans (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Fonction PURE (pas un service injectable — même convention que
// product-grounding.ts / resolve-media-buffer.ts) : la richesse narrative demandée au modèle
// dans le prompt du Shot Plan (cf. VideoDirectorService.generateShotPlan) n'est vérifiée nulle
// part programmatiquement — un LLM peut malgré la consigne renvoyer plusieurs plans quasi
// identiques. Détection déterministe, jamais un appel IA.
export interface ShotRepetitionWarning {
  sceneIds: string[];
  cameraShot: string;
  cameraMovement: string;
  action: string;
}

// 2+ plans partageant EXACTEMENT le même (cameraShot, cameraMovement, action) normalisé
// déclenchent un avertissement — seuil bas car ces trois champs réunis identiques signalent une
// vraie redite, pas une simple coïncidence esthétique.
export const SHOT_REPETITION_THRESHOLD = 2;

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function detectShotRepetition(shotPlan: ShotPlan): ShotRepetitionWarning[] {
  const groups = new Map<string, { sceneIds: string[]; cameraShot: string; cameraMovement: string; action: string }>();

  for (const shot of shotPlan) {
    const cameraShot = normalize(shot.cameraShot);
    const cameraMovement = normalize(shot.cameraMovement);
    const action = normalize(shot.action);
    // Un champ vide des trois côtés (shot ancien format, sans ces champs) ne doit jamais compter
    // comme une répétition — sinon TOUS les plans sans ces champs formeraient un faux positif.
    if (!cameraShot && !cameraMovement && !action) continue;

    const key = `${cameraShot}|${cameraMovement}|${action}`;
    const group = groups.get(key) ?? { sceneIds: [], cameraShot, cameraMovement, action };
    group.sceneIds.push(shot.sceneId);
    groups.set(key, group);
  }

  return Array.from(groups.values()).filter((g) => g.sceneIds.length >= SHOT_REPETITION_THRESHOLD);
}

// Règle de déclenchement d'une régénération complète (UNE seule, jamais plus — coût borné à un
// seul generateText, cf. AiOrchestratorService) : un groupe de répétition doit couvrir AU MOINS
// la moitié des plans du storyboard pour justifier de tout recommencer plutôt que d'accepter une
// diversité imparfaite mais mineure.
export function shouldRegeneratePlan(warnings: ShotRepetitionWarning[], shotCount: number): boolean {
  return warnings.some((w) => w.sceneIds.length >= shotCount / 2);
}

// Résumé texte injecté dans GenerateShotPlanParams.avoidRepetitionHint lors de la régénération
// — liste concrètement les combinaisons à éviter, pas une consigne vague ("plus de diversité").
export function buildAvoidRepetitionHint(warnings: ShotRepetitionWarning[]): string {
  return warnings
    .map((w) => `évite de répéter le cadrage "${w.cameraShot}" avec le mouvement "${w.cameraMovement}" pour l'action "${w.action}" (${w.sceneIds.length} plans identiques détectés)`)
    .join(' ; ');
}
