// P0.5 — Prompt Engine V2 (chantier "Product Intelligence & Creative Intelligence Engine V2",
// 2026-08-18), étendu par le chantier "Creative Intelligence Engine & Video Quality Loop"
// (2026-08-18). Liste complète des tâches de prompt spécialisées demandées par les deux briefs.
// Enregistrées dans PromptEngineService à ce jour : PRODUCT_ANALYSIS, PRODUCT_IDENTIFICATION,
// CREATIVE_BRIEF, VIDEO_CONCEPT, VIDEO_JUDGE, REPAIR, CREATIVE_VARIATION — les prompts NEUFS
// des deux chantiers. Les autres valeurs (MARKET_ANALYSIS, CAMPAIGN_OBJECTIVE, MARKETING_STRATEGY,
// COPY_GENERATION, IMAGE_PROMPT, VIDEO_STORYBOARD, VIDEO_SHOT, VOICE_SCRIPT, CONTENT_JUDGE)
// existent pour documenter le vocabulaire cible et permettre un enregistrement futur, sans
// migrer les ~15 prompts existants (stratégie, copywriting, shot plan, modération...) dans ces
// passes. Portée assumée et documentée dans les rapports finaux — pas un faux statut "terminé".
export enum PromptTask {
  PRODUCT_ANALYSIS = 'PRODUCT_ANALYSIS',
  PRODUCT_IDENTIFICATION = 'PRODUCT_IDENTIFICATION',
  MARKET_ANALYSIS = 'MARKET_ANALYSIS',
  CAMPAIGN_OBJECTIVE = 'CAMPAIGN_OBJECTIVE',
  MARKETING_STRATEGY = 'MARKETING_STRATEGY',
  CREATIVE_BRIEF = 'CREATIVE_BRIEF',
  COPY_GENERATION = 'COPY_GENERATION',
  IMAGE_PROMPT = 'IMAGE_PROMPT',
  VIDEO_CONCEPT = 'VIDEO_CONCEPT',
  VIDEO_STORYBOARD = 'VIDEO_STORYBOARD',
  VIDEO_SHOT = 'VIDEO_SHOT',
  VOICE_SCRIPT = 'VOICE_SCRIPT',
  CONTENT_JUDGE = 'CONTENT_JUDGE',
  VIDEO_JUDGE = 'VIDEO_JUDGE',
  REPAIR = 'REPAIR',
  // Ajouté au chantier "Creative Intelligence Engine & Video Quality Loop" (2026-08-18, P0.12)
  // — aucun des placeholders ci-dessus ne correspond à "générer des variantes d'un concept déjà
  // accepté", contrairement aux autres templates de ce chantier qui réutilisent des valeurs
  // déjà présentes dans cette liste.
  CREATIVE_VARIATION = 'CREATIVE_VARIATION',
  // Ajoutés au chantier "Moteur d'optimisation de la qualité vidéo — V2" (2026-08-19, Phases G/H)
  // — nouvelles portes de validation amont, aucun placeholder existant ne correspondait.
  CREATIVE_GATE = 'CREATIVE_GATE',
  STORYBOARD_GATE = 'STORYBOARD_GATE',
}
