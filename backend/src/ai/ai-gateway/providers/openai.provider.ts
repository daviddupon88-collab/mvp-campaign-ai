import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProvider,
  GenerateTextParams,
  GenerateImageParams,
  AnalyzeImageParams,
  ModerateTextResult,
  AiGenerationResult,
} from './ai-provider.interface';

// Provider OpenAI : implémentation de référence pour brancher un vrai fournisseur.
// Nécessite OPENAI_API_KEY dans l'environnement.
@Injectable()
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private readonly apiKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('OPENAI_API_KEY');
  }

  async generateText(params: GenerateTextParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'gpt-5';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: params.prompt }],
        max_tokens: params.maxTokens ?? 1000,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      provider: this.name,
      model,
      tokensUsed: data.usage?.total_tokens,
      costEstimate: this.estimateCost(data.usage?.total_tokens ?? 0),
      durationMs: Date.now() - start,
    };
  }

  async generateImage(params: GenerateImageParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'gpt-image-1';

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: params.prompt,
        size: params.size ?? '1024x1024',
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      content: data.data[0].url,
      provider: this.name,
      model,
      // Les endpoints d'images ne renvoient pas de "usage" en tokens — coût forfaitaire
      // indicatif par génération, à ajuster avec la grille tarifaire réelle du fournisseur.
      costEstimate: 0.04,
      durationMs: Date.now() - start,
    };
  }

  // Analyse multimodale (vision) : utilisée par ModerationService (détection de marques
  // déposées) et BrandConsistencyService (score de cohérence visuelle). Centralisée ici
  // plutôt que rappelée en `fetch()` brut par chaque service métier — c'est ce qui garantit
  // que CHAQUE appel, y compris ceux-ci, passe par le tracking de AiGatewayService.
  async analyzeImage(params: AnalyzeImageParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'gpt-5';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: params.prompt },
              { type: 'image_url', image_url: { url: params.imageUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI vision error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      provider: this.name,
      model,
      tokensUsed: data.usage?.total_tokens,
      costEstimate: this.estimateCost(data.usage?.total_tokens ?? 0),
      durationMs: Date.now() - start,
    };
  }

  // Modération de sécurité : endpoint dédié, non facturé par tokens chez OpenAI (coût=0),
  // mais tout de même journalisé pour le volume d'appels et la fiabilité du fournisseur.
  async moderateText(text: string): Promise<ModerateTextResult> {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI moderation error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const result = data.results?.[0];
    const flaggedCategories = Object.entries(result?.categories ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);

    return { flagged: !!result?.flagged, categories: flaggedCategories, raw: result };
  }

  // Estimation grossière — à affiner avec la vraie grille tarifaire du fournisseur.
  private estimateCost(tokens: number): number {
    return (tokens / 1000) * 0.01;
  }
}
