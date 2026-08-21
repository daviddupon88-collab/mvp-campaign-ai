// Phase S — Préparation multi-format / multi-canal (chantier "Optimisation du pipeline vidéo —
// V2.1", 2026-08-19, spec Section 23-24). Point d'extension DÉCLARÉ, non implémenté — sépare
// explicitement ce qui SERAIT propre au format (durée, densité de texte, safe zones) de ce qui
// reste partagé (CreativeConcept, cf. creative-concept.types.ts). Aucune logique ici : matérialise
// la séparation demandée par le spec sans construire une fonctionnalité multi-format complète
// (hors périmètre explicite de ce chantier, cf. plan — seul 9:16 est réellement généré aujourd'hui).
export interface FormatAdaptation {
  format: '9:16' | '1:1' | '16:9';
  durationSeconds: number;
  textDensity: 'low' | 'medium' | 'high';
  safeZones: { top: number; bottom: number; left: number; right: number };
}
