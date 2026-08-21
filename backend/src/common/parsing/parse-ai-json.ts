// Bug corrigé le 2026-08-19 (constaté en conditions réelles — Video Judge notant storytelling
// 15/100, hookStrength 15/100, ctaClarity 25/100 malgré un Creative Concept riche) : TOUS les
// services IA de ce projet qui attendent du JSON brut (CreativeConceptService,
// CreativeIntelligenceService, VideoJudgeService, VideoDirectorService, VisualDnaService,
// ProductIdentificationService, etc. — 13 sites au total) appelaient JSON.parse(raw) directement,
// sans jamais retirer un éventuel bloc markdown ```json ... ``` autour de la réponse. Anthropic
// (et parfois OpenAI) enveloppe régulièrement sa réponse de cette façon même quand le prompt
// demande explicitement du JSON brut — un comportement du modèle, pas une erreur, mais que
// JSON.parse() rejette immédiatement (SyntaxError sur le premier backtick). Chaque service
// retombait alors sur son repli neutre par défaut (champs vides/scores neutres) — un VRAI
// contenu généré, silencieusement jeté, sans jamais remonter comme une erreur.
//
// Centralisé ici plutôt que redupliqué dans chacun des 13 sites : un seul endroit à faire
// évoluer si un nouveau format d'enveloppe apparaît. Ne remplace jamais le parsing défensif
// existant (try/catch + repli neutre) — le retire seulement en amont, pour que JSON.parse()
// reçoive du JSON véritablement brut dans le cas (fréquent) où c'est la SEULE raison de l'échec.
export function stripJsonCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

// Point d'entrée unique recommandé pour les 13 sites de parsing JSON IA de ce projet : retire
// l'enveloppe markdown si présente, puis JSON.parse() standard — laisse l'appelant gérer le
// try/catch et son repli neutre propre (jamais de throw supplémentaire introduit ici).
export function parseAiJson<T = unknown>(raw: string): T {
  return JSON.parse(stripJsonCodeFence(raw)) as T;
}
