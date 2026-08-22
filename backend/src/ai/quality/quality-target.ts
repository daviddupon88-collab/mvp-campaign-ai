// Mission 4.3 — Goal-First Quality Architecture, Phase 1, Étape 1. Avant ce chantier, le score
// cible (75) était dupliqué indépendamment dans CreativeGateService (CREATIVE_GATE_THRESHOLD) et
// StoryboardGateService (STORYBOARD_GATE_THRESHOLD) — deux constantes qui pouvaient diverger sans
// qu'aucun test ne le détecte. QualityTarget devient la source unique, versionnée, créée AVANT le
// Creative Concept (cf. AiOrchestratorService.generateCampaign()) et menée jusqu'à la trace de
// génération (CreativeGenerationTrace.qualityTarget).
//
// Portée Phase 1 : seul targetScore est réellement appliqué (par les deux gates existantes).
// minimumCriticalScore/criticalCriteria sont documentés ici mais pas encore appliqués par critère
// — aucune des deux gates ne renvoie de score par critère aujourd'hui (seulement un score global +
// des champs qualitatifs). L'application réelle du plancher critique arrive avec le
// PreProductionQualityJudge (Phase 5 du plan Mission 4.3).
export interface QualityTarget {
  targetScore: number;
  version: string;
  // Sous-ensemble de JudgeCriterionName (video-judge.types.ts) — jamais des libellés inventés,
  // pour que la Phase 5 (PreProductionQualityJudge) puisse les confronter directement au Judge
  // sans migration de nommage.
  criticalCriteria: string[];
  minimumCriticalScore: number;
  prohibitedConditions: string[];
}

// Mission 4.4 (Product URL Intelligence, Phase L) — factualConsistency ajouté aux critères
// critiques (brief : "productConsistency = CRITICAL, factualConsistency = CRITICAL") : une
// affirmation publicitaire en contradiction avec les faits produit vérifiés (URL/photo) devient
// désormais un plancher critique appliqué EN CODE (cf. StoryboardGateService.applyCriticalFloor),
// jamais laissé à la seule confiance du LLM. targetScore/minimumCriticalScore INCHANGÉS (75/60 —
// règle absolue de ce chantier, ne jamais les modifier arbitrairement). version bumpée en v2 :
// changement de contenu réel du QualityTarget par défaut, même discipline que PROMPT_VERSIONS.
export const QUALITY_TARGET_V1: QualityTarget = {
  targetScore: 75,
  version: 'goal-first-v2',
  criticalCriteria: ['hookStrength', 'ctaClarity', 'storytelling', 'productConsistency', 'factualConsistency'],
  minimumCriticalScore: 60,
  prohibitedConditions: [
    'Visual DNA indisponible ou en repli neutre (isFallback=true)',
    'Aucun CTA défini dans le concept ou le plan de tournage',
    'Hook absent ou générique',
    // Mission 4.4 (Product URL Intelligence, Phase L) — verbatim du brief.
    'unsupported product claim',
    'unresolved critical product conflict',
  ],
};
