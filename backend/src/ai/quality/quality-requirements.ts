import { QualityTarget } from './quality-target';

// Mission 4.3 — Goal-First Quality Architecture, Phase 1, Étape 2. Un QualityTarget seul ("vise
// 75") ne dit rien à un LLM de génération sur QUOI construire pour l'atteindre. QualityRequirements
// dérive, de façon déterministe (aucun appel IA, même discipline que shot-plan-validator.ts), des
// consignes de CONSTRUCTION concrètes à partir des critères critiques du QualityTarget — jamais de
// simples explications produites après coup.
export interface QualityRequirement {
  criterion: string;
  target: number;
  importance: 'CRITICAL' | 'IMPORTANT' | 'MINOR';
  // Ce qu'il faut CONSTRUIRE pour satisfaire ce critère — jamais une reformulation du critère lui-même.
  constructionRequirement: string;
  evidenceRequired: string;
  blocking: boolean;
}

export interface QualityRequirements {
  target: QualityTarget;
  requirements: QualityRequirement[];
}

// Table statique — un critère absent de cette table (nom inconnu, pas encore documenté) reçoit un
// repli générique plutôt que de faire échouer la dérivation : la table s'enrichit au fil des
// phases suivantes (NarrativeBlueprint, ShotExecutionCompiler) sans jamais bloquer Phase 1.
const CONSTRUCTION_GUIDANCE: Record<string, Pick<QualityRequirement, 'constructionRequirement' | 'evidenceRequired'>> = {
  hookStrength: {
    constructionRequirement:
      "Intérêt immédiat : un événement visuel ou narratif dans les 3 premières secondes, le produit ou le problème immédiatement pertinent, jamais une ouverture statique ou générique (\"Découvrez notre produit\").",
    evidenceRequired: 'Le premier plan/la première réplique doit être identifiable comme LE hook, pas une mise en contexte.',
  },
  ctaClarity: {
    constructionRequirement:
      "Un appel à l'action explicite, présent à la fois à l'écran (onScreenText) et dans la voix-off — jamais implicite ou laissé à déduire.",
    evidenceRequired: 'Le dernier plan porteur de texte doit contenir un CTA identifiable.',
  },
  storytelling: {
    constructionRequirement:
      'Progression narrative claire (accroche -> problème/désir -> preuve/démonstration -> bénéfice -> CTA) — jamais une liste de plans déconnectés les uns des autres.',
    evidenceRequired: "Chaque plan doit avoir un rôle narratif identifiable (narrativeRole) qui s'enchaîne logiquement avec le précédent.",
  },
  productConsistency: {
    constructionRequirement:
      'Même identité visuelle (couleur, forme, matière) que le Visual DNA extrait sur TOUS les plans — jamais une variation qui rendrait le produit méconnaissable entre deux plans.',
    evidenceRequired: 'Le produit doit rester visuellement identifiable et cohérent avec visualDna sur chaque plan qui le montre.',
  },
  brandCoherence: {
    constructionRequirement: "Ton et univers visuel cohérents avec le contexte de marque fourni, sans contradiction d'un plan à l'autre.",
    evidenceRequired: 'Aucun plan ne doit introduire un ton ou un univers visuel étranger au reste du concept.',
  },
  sceneConsistency: {
    constructionRequirement: 'Continuité explicite entre plans consécutifs (produit, espace, lumière, transition) — chaque transition doit avoir une fonction.',
    evidenceRequired: 'Deux plans consécutifs doivent partager un même environnement/éclairage/sujet, ou une transition justifiée.',
  },
  // Mission 4.4 (Product URL Intelligence, Phase L) — chaque affirmation (chiffre, matière,
  // dimension, prix) doit correspondre à un fait produit VÉRIFIÉ (photo et/ou page produit),
  // jamais une caractéristique inventée ou une valeur en contradiction avec les faits résolus.
  factualConsistency: {
    constructionRequirement:
      "Chaque affirmation chiffrée ou factuelle (capacité, matière, dimension, prix, certification) doit correspondre EXACTEMENT à un fait produit vérifié — jamais une valeur approximée, arrondie autrement, ou inventée pour combler un vide.",
    evidenceRequired: 'Toute affirmation factuelle utilisée doit pouvoir être reliée à un ProductFact/ProductClaim vérifié (source PRODUCT_URL ou IMAGE), jamais une INFERENCE non confirmée.',
  },
};

const DEFAULT_GUIDANCE: Pick<QualityRequirement, 'constructionRequirement' | 'evidenceRequired'> = {
  constructionRequirement: 'Ce critère doit être construit intentionnellement, jamais laissé au hasard de la génération.',
  evidenceRequired: 'Un élément concret et vérifiable du concept/storyboard doit démontrer que ce critère a été pris en compte.',
};

export function deriveQualityRequirements(target: QualityTarget): QualityRequirements {
  const requirements = target.criticalCriteria.map((criterion): QualityRequirement => {
    const guidance = CONSTRUCTION_GUIDANCE[criterion] ?? DEFAULT_GUIDANCE;
    return {
      criterion,
      target: target.minimumCriticalScore,
      importance: 'CRITICAL',
      blocking: true,
      ...guidance,
    };
  });
  return { target, requirements };
}

// Bloc texte injecté dans les prompts (construction ET évaluation) — lisible par un LLM, jamais
// un objet JSON brut qui noierait le reste du prompt.
export function renderQualityRequirementsForPrompt(requirements: QualityRequirements): string {
  if (requirements.requirements.length === 0) return '';
  const lines = requirements.requirements.map(
    (r) => `- ${r.criterion} (cible ${requirements.target.targetScore}/100, plancher critique ${r.target}/100) : ${r.constructionRequirement}`,
  );
  return `\n\nExigences de construction pour atteindre l'objectif qualité (${requirements.target.version}, cible ${requirements.target.targetScore}/100) :\n${lines.join('\n')}`;
}

// Mission 4.3 Phase 2 — critères pertinents à CHAQUE ÉTAPE du pipeline. Auparavant dupliqués
// indépendamment (CONCEPT_STAGE_CRITERIA privé dans creative-gate.service.ts,
// STORYBOARD_STAGE_CRITERIA privé dans storyboard-gate.service.ts, chacun avec sa propre séquence
// filtre→dérive→rend) — relocalisés ici dès qu'un 3e consommateur (CreativeConceptService, la
// CONSTRUCTION du concept plutôt que son évaluation) en a eu besoin : construction et évaluation
// doivent juger le MÊME sous-ensemble de critères à un stade donné, jamais deux listes qui dérivent.
export const CONCEPT_STAGE_CRITERIA = ['hookStrength', 'ctaClarity', 'storytelling'];
// Mission 4.4 (Product URL Intelligence, Phase L/R) — factualConsistency ajouté : le
// PreProductionQualityJudge (StoryboardGateService) doit pouvoir juger la cohérence factuelle
// AVANT génération vidéo, pas seulement le Final Judge après coup.
export const STORYBOARD_STAGE_CRITERIA = ['productConsistency', 'storytelling', 'ctaClarity', 'factualConsistency'];

export function buildStageQualityRequirementsBlock(target: QualityTarget, stageCriteria: string[]): string {
  const stageTarget: QualityTarget = { ...target, criticalCriteria: target.criticalCriteria.filter((c) => stageCriteria.includes(c)) };
  return renderQualityRequirementsForPrompt(deriveQualityRequirements(stageTarget));
}
