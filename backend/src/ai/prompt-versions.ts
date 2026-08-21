// Point d'audit UNIQUE pour toutes les versions de template de prompt en usage dans le backend.
// Bumper une valeur ici est le geste attendu à chaque modification de contenu d'un prompt —
// permet de corréler un résultat IA (AiGeneration.promptVersion) à une révision précise du
// template qui l'a produit, via `git blame` sur ce seul fichier plutôt que dispersé dans 8+
// fichiers. Chantier "prompts précis, orientés objectif, tracés" (2026-08-18).
export const PROMPT_VERSIONS = {
  productAnalysis: 'product-analysis-v1',
  strategy: 'strategy-v1',
  channelCopy: 'channel-copy-v3', // v3 : injection du Creative Concept (hook/storytellingApproach/emotionalDirection) — audit forensic campagne 5345726a, 2026-08-20
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
  // Product Intelligence (2026-08-18) : distinct de `productAnalysis` (l'analyse 4 champs
  // existante, inchangée, toujours utilisée par AiOrchestratorService.analyzeProductImage) —
  // ce chantier ajoute une 2e analyse produit, plus riche (17 champs), NOUVELLE et séparée.
  // Noms distincts pour ne jamais confondre les deux dans la traçabilité.
  productAnalysisV2: 'product-analysis-v2-1',
  productIdentification: 'product-identification-v1',
  // Creative Intelligence Engine & Video Quality Loop (2026-08-18).
  creativeBrief: 'creative-brief-v1',
  videoConcept: 'video-concept-v1',
  videoJudge: 'video-judge-v2', // v2 : clarification advertisingEffectiveness (Phase D, chantier V2 — sous-score publicitaire distinct de l'esthétique)
  productVisibilityFinal: 'product-visibility-final-v1',
  repairGrammar: 'repair-grammar-v2', // v2 : escalade (priorAttemptFailed) — Phase B, chantier V2, 2026-08-19
  creativeVariation: 'creative-variation-v1',
  creativeGate: 'creative-gate-v1',
  storyboardGate: 'storyboard-gate-v1',
  // Mission 4 Phase B ("Creative Video & Audio Intelligence", 2026-08-20).
  sceneConsistency: 'scene-consistency-v1',
} as const;
