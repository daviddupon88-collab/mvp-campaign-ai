// Mission 4.3 — Goal-First Quality Architecture, Phase 3, Étape 4. Couche intermédiaire explicite
// entre CreativeConcept et tout ce qui "dit" la publicité (narration, script TikTok/canaux,
// rythme du Shot Plan) : avant ce chantier, la narration était reconstituée par regex depuis le
// script TikTok (scriptToNarration) quand un canal TikTok était sélectionné, ou depuis un repli
// bien plus pauvre sinon (buildFallbackNarration) — deux pipelines créatifs indépendants pouvant
// diverger. NarrativeBlueprint devient la source UNIQUE dont narration ET script de canal
// dérivent tous les deux, jamais l'un de l'autre.
export interface NarrativeBeat {
  id: string;
  // Libellé libre (ex: "hook", "problem", "productIntroduction", "cta") — même discipline que
  // Shot.narrativeRole, jamais un enum strict qui figerait le vocabulaire.
  role: string;
  objective: string;
  duration: number; // secondes, indicatif
  requiredVisualEvidence: string;
  requiredVoiceover: string;
  // Toujours [] en Phase 3 — les shots n'existent pas encore au moment où le Blueprint est
  // généré (il précède le Shot Plan). Peuplé en Phase 4 (ShotExecutionCompiler).
  shotIds: string[];
}

export interface NarrativeBlueprint {
  hook: string;
  problem: string;
  tension: string;
  reveal: string;
  productIntroduction: string;
  benefit: string;
  proof: string;
  emotionalPayoff: string;
  cta: string;
  // Description textuelle du rythme voulu (ex: "rapide, coupes courtes sur les 5 premières
  // secondes, ralenti sur la preuve") — jamais composité directement, sert de guidage.
  pacing: string;
  // Repères textuels des 1-3 moments où la voix off doit marquer une respiration/pause.
  pausePoints: string[];
  beats: NarrativeBeat[];
  raw: string;
}
