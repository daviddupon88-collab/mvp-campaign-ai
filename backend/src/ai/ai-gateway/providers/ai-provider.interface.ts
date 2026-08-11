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
}

export interface GenerateVideoParams {
  prompt: string;
  durationSeconds?: number;
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

  // Analyse multimodale (texte + image) — utilisée pour la cohérence de marque et la
  // détection de marques déposées dans les visuels générés. Retourne du texte (le prompt
  // demande un JSON strict), pas un nouvel asset : réutilise AiGenerationResult par commodité.
  analyzeImage?(params: AnalyzeImageParams): Promise<AiGenerationResult>;

  // Modération de sécurité (haine, violence, contenu explicite) — API dédiée chez la plupart
  // des fournisseurs, distincte des endpoints de génération, avec sa propre forme de réponse.
  moderateText?(text: string): Promise<ModerateTextResult>;
}
