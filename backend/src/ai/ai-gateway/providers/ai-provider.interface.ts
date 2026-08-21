// Contrat commun que tout fournisseur d'IA doit respecter.
// C'est ce contrat qui garantit qu'ajouter/retirer un fournisseur
// ne touche jamais la couche métier (Campaign, Content, etc.).

export interface GenerateTextParams {
  prompt: string;
  maxTokens?: number;
}

export interface GenerateImageParams {
  prompt: string;
  size?: string;
  // Image de référence à ancrer la génération dessus (édition, pas une pure invention
  // textuelle) — pour un fournisseur qui le supporte (OpenAI, cf. /v1/images/edits). Optionnel :
  // un fournisseur texte-vers-image pur (Flux, Ideogram) l'ignore silencieusement, même
  // convention que GenerateVideoParams.imageUrl pour Runway.
  imageUrl?: string;
}

export interface GenerateVideoParams {
  prompt: string;
  durationSeconds?: number;
  // Image de référence à animer/ancrer — pour Runway (image-to-video pur) c'est la première
  // frame ; pour Google Veo (depuis le 2026-08-18) c'est une image de conditionnement transmise
  // au modèle en plus du prompt texte (cf. GoogleVeoProvider.resolveImageForVeo), pour que la
  // vidéo générée reste fidèle au produit réellement injecté plutôt qu'une pure invention
  // textuelle. Optionnel — un fournisseur texte-vers-vidéo pur peut l'ignorer si non supporté.
  imageUrl?: string;
}

export interface GenerateAudioParams {
  prompt: string; // texte à synthétiser (narration/voix off)
  // Mission 4 Phase E — champs additifs, EXCLUSIVEMENT consommés par le benchmark TTS isolé
  // (backend/src/scripts/mission4-tts-benchmark.ts), jamais par le pipeline de campagne normal
  // (Correction obligatoire 5). `model` permet de forcer `gpt-4o-mini-tts` pour la comparaison
  // (défaut `tts-1` inchangé si omis) ; `instructions` n'a d'effet que sur ce modèle (l'API
  // OpenAI l'ignore pour `tts-1`/`tts-1-hd`, qui n'exposent aucun contrôle d'expressivité).
  model?: 'tts-1' | 'gpt-4o-mini-tts';
  instructions?: string;
}

// Timing d'un segment transcrit — sert de base à la génération de sous-titres (.srt), pas
// seulement à afficher le texte : start/end sont indispensables pour synchroniser l'incrustation
// avec l'audio réellement généré (cf. VideoAssemblyService), pas une estimation depuis le texte.
export interface TranscriptSegment {
  start: number; // secondes
  end: number; // secondes
  text: string;
}

export interface TranscribeAudioParams {
  audioBuffer: Buffer;
  mimeType: string;
}

export interface AiGenerationResult {
  content: string; // texte généré, ou URL de l'asset pour image/vidéo
  provider: string;
  model: string;
  tokensUsed?: number;
  costEstimate?: number;
  durationMs: number;
  // Renseigné par AiGatewayService après coup (pas par les providers eux-mêmes) — permet
  // au Content Studio de relier un Asset à sa ligne AiGeneration (traçabilité, coût réel).
  generationId?: string;
}

export interface AnalyzeImageParams {
  prompt: string;
  imageUrl: string;
  // Mission 4 Phase B — images SUPPLÉMENTAIRES pour un appel vision GROUPÉ (ex. comparer
  // plusieurs plans entre eux, cf. VideoJudgeService.buildSceneConsistencyCriterion) : UN SEUL
  // appel IA reçoit toutes les images, jamais N appels séparés. Optionnel et additif — les
  // appelants à une seule image (analyse produit, cohérence de marque...) restent inchangés.
  additionalImageUrls?: string[];
}

export interface ModerateTextResult {
  flagged: boolean;
  categories: string[];
  raw?: unknown;
}

export interface AiProvider {
  readonly name: string;

  generateText?(params: GenerateTextParams): Promise<AiGenerationResult>;
  generateImage?(params: GenerateImageParams): Promise<AiGenerationResult>;
  generateVideo?(params: GenerateVideoParams): Promise<AiGenerationResult>;
  // Voix off / narration — cf. OpenAiProvider.generateAudio(). content renvoie un data URI
  // (data:audio/...;base64,...), pas une URL hébergée : contrairement à generateImage/
  // generateVideo, l'API TTS ne fournit aucune URL temporaire à re-héberger.
  generateAudio?(params: GenerateAudioParams): Promise<AiGenerationResult>;

  // Transcription (voix -> texte horodaté) — utilisée pour générer les sous-titres à partir de
  // la narration déjà générée (cf. AiOrchestratorService), pas depuis le texte du script : le
  // timing réel de la parole (rythme, pauses) ne peut venir que de l'audio effectivement produit.
  // content renvoie du JSON stringifié (TranscriptSegment[]), même convention que analyzeImage.
  transcribeAudio?(params: TranscribeAudioParams): Promise<AiGenerationResult>;

  // Analyse multimodale (texte + image) — utilisée pour la cohérence de marque et la
  // détection de marques déposées dans les visuels générés. Retourne du texte (le prompt
  // demande un JSON strict), pas un nouvel asset : réutilise AiGenerationResult par commodité.
  analyzeImage?(params: AnalyzeImageParams): Promise<AiGenerationResult>;

  // Modération de sécurité (haine, violence, contenu explicite) — API dédiée chez la plupart
  // des fournisseurs, distincte des endpoints de génération, avec sa propre forme de réponse.
  moderateText?(text: string): Promise<ModerateTextResult>;
}
