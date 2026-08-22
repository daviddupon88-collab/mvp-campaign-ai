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
  shotPlan: 'shot-plan-v4', // v4 : audit forensic (2026-08-22, campagnes réelles) — v3 ajoutait l'alignement visuel/verbal + complétude ADN visuel + fidélité au beat ; v4 ajoute la règle SHOW > TELL explicite pour proofElement (dernier maillon de la chaîne proofToShow -> proofStrategy -> requiredVisualEvidence -> proofElement, jusqu'ici seul maillon sans consigne propre)
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
  videoConcept: 'video-concept-v3', // v3 : audit forensic (2026-08-22, campagnes réelles) — règle SHOW > TELL réaffirmée explicitement pour proofStrategy (se diluait en affirmation verbale entre proofToShow et proofStrategy, corrompant toute la chaîne en aval)
  videoJudge: 'video-judge-v3', // v3 : Mission 4.3 Phase 6c — comparaison attendu (NarrativeBlueprint.beats) vs réel (transcript), plus un jugement esthétique isolé
  productVisibilityFinal: 'product-visibility-final-v1',
  repairGrammar: 'repair-grammar-v2', // v2 : escalade (priorAttemptFailed) — Phase B, chantier V2, 2026-08-19
  creativeVariation: 'creative-variation-v1',
  creativeGate: 'creative-gate-v2', // v2 : Mission 4.3 Phase 2 — qualityRequirementsBlock (seuil piloté par QualityTarget, plus une constante figée)
  storyboardGate: 'storyboard-gate-v3', // v3 : Mission 4.3 Phase 5b — fusion PreProductionQualityJudge (criterionScores/blockingDefects/risks/requiredChanges/rootCauseLevel, NarrativeBlueprint + instructions d'exécution compilées + grounding produit)
  // Mission 4 Phase B ("Creative Video & Audio Intelligence", 2026-08-20).
  sceneConsistency: 'scene-consistency-v1',
  // Mission 4.3 (Goal-First Quality Architecture, Phase 3, Étape 4).
  narrativeBlueprint: 'narrative-blueprint-v3',
  // Mission 4.4 (Product URL Intelligence, Phase H) — repli LLM, invoqué seulement quand
  // l'extraction déterministe (JSON-LD/OpenGraph/HTML) est insuffisante.
  productPageExtraction: 'product-page-extraction-v1', // v3 : audit forensic (2026-08-22, campagnes réelles) — v2 plafonnait beats.length à scenesCount ; v3 ajoute la règle SHOW > TELL explicite pour requiredVisualEvidence (héritait à tort de la consigne "prêt à voix haute" destinée aux champs narratifs top-level, produisant des preuves visuelles qui n'étaient en réalité que des phrases à prononcer)
} as const;
