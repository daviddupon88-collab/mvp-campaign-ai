// Point d'audit UNIQUE pour toutes les versions de template de prompt en usage dans le backend.
// Bumper une valeur ici est le geste attendu à chaque modification de contenu d'un prompt —
// permet de corréler un résultat IA (AiGeneration.promptVersion) à une révision précise du
// template qui l'a produit, via `git blame` sur ce seul fichier plutôt que dispersé dans 8+
// fichiers. Chantier "prompts précis, orientés objectif, tracés" (2026-08-18).
export const PROMPT_VERSIONS = {
  productAnalysis: 'product-analysis-v1',
  strategy: 'strategy-v1',
  channelCopy: 'channel-copy-v2', // v2 : ajout de la ligne Objectif explicite
  visual: 'visual-v2', // v2 : réécriture complète (objectif + stratégie + consignes de composition)
  visualDna: 'visual-dna-v1',
  shotPlan: 'shot-plan-v2', // v2 : ajout du champ objective dédié
  visualFidelity: 'visual-fidelity-v1',
  moderationMisleadingClaims: 'moderation-misleading-claims-v1',
  moderationTrademark: 'moderation-trademark-v1',
  moderationObjectiveAchievement: 'moderation-objective-achievement-v1',
  brandConsistencyText: 'brand-consistency-text-v1',
  brandConsistencyImage: 'brand-consistency-image-v1',
  optimizerRecommendation: 'optimizer-recommendation-v1',
} as const;
