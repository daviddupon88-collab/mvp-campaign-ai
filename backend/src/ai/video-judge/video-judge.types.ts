// P0.5 — Video Judge (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Campaign-ai doit REGARDER sa propre vidéo finale assemblée avant de la
// considérer terminée — jamais un succès automatique parce qu'un provider a renvoyé un fichier.
export type JudgeCriterionName =
  | 'productConsistency'
  | 'motionDynamism'
  | 'audioQuality'
  | 'voiceAudibility'
  | 'formatCompliance'
  | 'productVisibility'
  | 'storytelling'
  | 'hookStrength'
  | 'pacing'
  | 'textReadability'
  | 'grammar'
  | 'ctaClarity'
  | 'brandCoherence'
  | 'factualConsistency'
  | 'advertisingEffectiveness'
  // Mission 4 ("Creative Video & Audio Intelligence", 2026-08-20) — critères additifs, cf.
  // video-judge.service.ts pour leur mesure. `pacing` (ci-dessus) reste un critère TEXTE
  // (rythme narratif jugé par le Judge groupé) — `voicePacing` mesure un signal distinct,
  // déterministe, dérivé des TranscriptSegment (débit de parole/pauses réelles).
  | 'voiceDynamism'
  | 'voicePacing'
  // Phase A — qualité créative du cadrage (vision), distincte de formatCompliance (géométrie,
  // ffmpeg cropdetect) : les deux ne sont jamais mélangés (spec Mission 4 section 5).
  | 'visualComposition'
  // Phase B — cohérence visuelle ENTRE plans (éclairage/environnement/style), un seul appel
  // vision groupé sur une frame par plan.
  | 'sceneConsistency';

// Poids (somme = 100) — point de départ documenté, à recalibrer après le premier passage E2E
// réel (cf. plan), pas une spec figée. La hiérarchie reflète : la fidélité au produit et
// l'absence d'affirmation inventée pèsent le plus lourd (12+10), suivi des leviers publicitaires
// (hook/CTA/preuve, 8 chacun), puis le confort de forme (lisibilité/grammaire, 2 chacun — des
// défauts réels mais mineurs face à un mensonge ou un produit méconnaissable). Déplacé ici depuis
// video-judge.service.ts (Phase C, chantier V2, 2026-08-19) : repair-priority.ts en a besoin sans
// import circulaire vers le service.
// Mission 4 (2026-08-20) : ajout de voiceDynamism (4), voicePacing (3), visualComposition (3),
// sceneConsistency (3), poids prélevés sur productVisibility/hookStrength/brandCoherence/
// motionDynamism/audioQuality/voiceAudibility/storytelling/ctaClarity/pacing pour que la somme
// reste exactement 100 — computeGlobalScore (video-judge.service.ts) divise par 100 en dur,
// cette invariance doit être préservée à chaque ajout de critère plutôt que de changer ce calcul.
export const WEIGHTS: Record<JudgeCriterionName, number> = {
  productConsistency: 12,
  factualConsistency: 10,
  advertisingEffectiveness: 10,
  productVisibility: 7,
  storytelling: 7,
  hookStrength: 6,
  ctaClarity: 7,
  brandCoherence: 5,
  motionDynamism: 4,
  pacing: 5,
  audioQuality: 4,
  voiceAudibility: 3,
  formatCompliance: 3,
  textReadability: 2,
  grammar: 2,
  voiceDynamism: 4,
  voicePacing: 3,
  visualComposition: 3,
  sceneConsistency: 3,
};

// Un score moyen élevé ne masque JAMAIS une défaillance critique — même philosophie que
// ShotQualityResult (passed = motionQuality.passed && visualFidelity.passed), étendue à 3
// critères non négociables ici : produit méconnaissable, affirmation inventée, ou fichier
// techniquement non conforme sont chacun un motif de refus, quel que soit le score global.
// Déplacées ici depuis video-judge.service.ts (Phase A, chantier V2, 2026-08-19) : partagées
// avec repair-regression-guard.ts, qui en a besoin sans créer d'import circulaire vers le service.
export const CRITICAL_CRITERIA: JudgeCriterionName[] = ['productConsistency', 'factualConsistency', 'formatCompliance'];
export const CRITICAL_FLOOR = 50;

// Champs additifs Mission 4 ("Creative Video & Audio Intelligence", 2026-08-20, section 3 du
// spec) — renseignés UNIQUEMENT par les nouveaux critères introduits par cette mission
// (formatCompliance mesuré, visualComposition, sceneConsistency, voiceDynamism, voicePacing) ;
// les critères existants restent valides sans eux, aucune retouche de leur contrat.
export type JudgeMeasurementMethod =
  | 'FFMPEG_RMS_VARIANCE'
  | 'FFMPEG_CROPDETECT'
  | 'FFMPEG_TIMING'
  | 'VISION_MULTI_FRAME'
  | 'TEXT_JUDGE';

// Mission 4 Phase B — un défaut sceneConsistency DOIT être attribuable à un plan (ou une paire)
// précis pour être réparable, jamais un texte libre non structuré (Correction obligatoire 3).
export interface SceneConsistencyDefect {
  sceneRef: string | [string, string];
  issue: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number; // 0-1
}

export interface JudgeCriterionResult {
  name: JudgeCriterionName;
  score: number; // 0-100
  justification: string;
  defect?: string; // présent uniquement si le score est sous le seuil réparable
  sceneRef?: string; // Shot.sceneId, quand le défaut est attribuable à UN SEUL plan sans ambiguïté
  confidence?: number; // 0-1 — confiance de la MESURE elle-même, distincte du score
  measurementMethod?: JudgeMeasurementMethod;
  isApproximation?: boolean; // true si le critère approxime un signal qu'aucun provider actuel ne mesure directement (ex. dynamique acoustique ≠ émotion réelle)
  // Mission 4 Phase B — UNIQUEMENT renseigné par sceneConsistency : liste structurée des défauts
  // inter-plans détectés (`defect`/`sceneRef`/`confidence` ci-dessus restent la vue "réduite à un
  // seul défaut" utilisée par le reste du pipeline générique ; `defects` porte le détail complet
  // pour le gate de réparation dédié, cf. repair-dispatch.ts Phase H).
  defects?: SceneConsistencyDefect[];
}

// Phase D (chantier "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19, Règle 2 du
// spec : "l'efficacité publicitaire prime sur l'esthétique"). Regroupe les 15 critères EXISTANTS
// (aucun nouvel appel IA) en deux sous-scores — une vidéo magnifique mais qui ne vend pas ne doit
// JAMAIS passer, même à globalScore suffisant. Répartition : VISUAL_QUALITY = fidélité/qualité
// technique (le produit est-il montré correctement ?), ADVERTISING_EFFECTIVENESS = persuasion
// (cette vidéo donne-t-elle envie d'agir ?). brandCoherence classé côté visuel (cohérence
// d'IDENTITÉ, pas de persuasion) ; factualConsistency côté publicitaire (une affirmation inventée
// nuit directement à la crédibilité commerciale, pas à la qualité de l'image).
export const VISUAL_QUALITY_CRITERIA: JudgeCriterionName[] = [
  'productConsistency',
  'motionDynamism',
  'productVisibility',
  'brandCoherence',
  'formatCompliance',
  'textReadability',
  'grammar',
  'audioQuality',
  'voiceAudibility',
  // Mission 4 : voiceDynamism/voicePacing rejoignent audioQuality/voiceAudibility dans ce
  // groupe (en réalité "qualité technique de production", pas seulement visuel) plutôt que
  // ADVERTISING_EFFECTIVENESS — ce sont des mesures de PERFORMANCE technique de la narration,
  // pas des leviers de persuasion.
  'voiceDynamism',
  'voicePacing',
  // Mission 4 Phase A : qualité créative du cadrage, mesure vision — bucket visuel, comme
  // productVisibility/brandCoherence.
  'visualComposition',
  // Mission 4 Phase B : cohérence visuelle ENTRE plans, mesure vision — bucket visuel.
  'sceneConsistency',
];

export const ADVERTISING_EFFECTIVENESS_CRITERIA: JudgeCriterionName[] = [
  'advertisingEffectiveness',
  'hookStrength',
  'ctaClarity',
  'storytelling',
  'pacing',
  'factualConsistency',
];

export interface JudgeSubScore {
  score: number; // 0-100, moyenne pondérée DANS le sous-groupe (poids WEIGHTS renormalisés)
  criteria: JudgeCriterionName[];
  // false si TOUS les critères du sous-groupe sont UNAVAILABLE_DEFECT (panne de mesure, pas un
  // vrai défaut) — permet au verdict de ne jamais opposer un plancher (ex. ADVERTISING_FLOOR) à
  // un sous-score qui ne reflète aucune donnée réelle, cf. audit forensique Mission 4.2 (P0-3).
  // Optionnel/additif (absent = true, comportement historique) pour ne pas casser les fixtures
  // de test existantes qui construisent un JudgeSubScore à la main.
  dataAvailable?: boolean;
}

export interface VideoJudgeResult {
  criteria: JudgeCriterionResult[];
  globalScore: number; // moyenne pondérée, 0-100
  visualQuality: JudgeSubScore;
  advertisingEffectiveness: JudgeSubScore; // nommage distinct du critère JudgeCriterionName 'advertisingEffectiveness' — c'est un sous-score AGRÉGÉ, pas un critère isolé
  verdict: 'PASS' | 'REPAIR_REQUIRED';
}

// Marqueur d'ÉCHEC DE MESURE (mesure/appel indisponible), à distinguer d'un vrai défaut de
// contenu — Mission 3 (validation empirique, 2026-08-20) : l'audit des traces réelles a confirmé
// que ce marqueur était produit sur 9 critères simultanément (échec de l'appel texte groupé du
// Judge) et traité EXACTEMENT comme 9 vrais défauts de contenu par le reste du pipeline (réparé,
// puis escaladé) — aucune réparation de sous-titres/audio/storyboard/concept ne peut jamais
// corriger "le Judge n'a pas pu évaluer ce critère". Déplacé ici depuis video-judge.service.ts
// (qui le produit) pour que repair-priority.ts/video-quality-loop.service.ts/root-cause.ts
// puissent le consommer sans import circulaire vers le service.
export const UNAVAILABLE_DEFECT = 'Vérification indisponible';
