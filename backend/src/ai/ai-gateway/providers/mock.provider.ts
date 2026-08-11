import { Injectable } from '@nestjs/common';
import {
  AiProvider,
  GenerateTextParams,
  GenerateImageParams,
  GenerateVideoParams,
  AnalyzeImageParams,
  ModerateTextResult,
  AiGenerationResult,
} from './ai-provider.interface';

// Provider factice : permet de développer et tester tout le pipeline
// (Orchestrator, queue, facturation) sans consommer de vrais crédits IA.
// À utiliser en développement local, ou en fallback si tous les vrais
// fournisseurs sont indisponibles.
@Injectable()
export class MockProvider implements AiProvider {
  readonly name = 'mock';

  async generateText(params: GenerateTextParams): Promise<AiGenerationResult> {
    const start = Date.now();
    await this.simulateLatency();
    return {
      content: `[MOCK] Texte généré pour le prompt: "${params.prompt.slice(0, 60)}..."`,
      provider: this.name,
      model: 'mock-text-v1',
      tokensUsed: 120,
      costEstimate: 0,
      durationMs: Date.now() - start,
    };
  }

  async generateImage(params: GenerateImageParams): Promise<AiGenerationResult> {
    const start = Date.now();
    await this.simulateLatency();
    return {
      content: 'https://placehold.co/1024x1024?text=Mock+Image',
      provider: this.name,
      model: 'mock-image-v1',
      costEstimate: 0,
      durationMs: Date.now() - start,
    };
  }

  async generateVideo(params: GenerateVideoParams): Promise<AiGenerationResult> {
    const start = Date.now();
    await this.simulateLatency();
    return {
      content: 'https://example.com/mock-video.mp4',
      provider: this.name,
      model: 'mock-video-v1',
      costEstimate: 0,
      durationMs: Date.now() - start,
    };
  }

  private simulateLatency() {
    return new Promise((resolve) => setTimeout(resolve, 300));
  }

  // Retourne un JSON valide générique — les vrais appelants (Moderation/BrandConsistency)
  // ne passent par ce chemin qu'en dernier recours si tous les fournisseurs réels échouent ;
  // leur propre logique métier interprète une réponse inattendue comme "à vérifier" (FLAGGED)
  // plutôt que de planter.
  async analyzeImage(params: AnalyzeImageParams): Promise<AiGenerationResult> {
    const start = Date.now();
    await this.simulateLatency();
    return {
      content: '{"score":70,"summary":"(mock) analyse indisponible","detected":false,"brands":[]}',
      provider: this.name,
      model: 'mock-vision-v1',
      costEstimate: 0,
      durationMs: Date.now() - start,
    };
  }

  async moderateText(text: string): Promise<ModerateTextResult> {
    await this.simulateLatency();
    return { flagged: false, categories: [] };
  }
}
