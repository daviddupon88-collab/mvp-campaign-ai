import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, GenerateTextParams, AiGenerationResult } from './ai-provider.interface';

// Provider Anthropic : utilisé notamment pour l'analyse stratégique / SEO
// (cf. exemple d'orchestration du chapitre 9 du business plan).
// Nécessite ANTHROPIC_API_KEY dans l'environnement.
@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
  }

  async generateText(params: GenerateTextParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'claude-sonnet-5';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: params.maxTokens ?? 1000,
        messages: [{ role: 'user', content: params.prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const textBlock = data.content.find((b: any) => b.type === 'text');

    return {
      content: textBlock?.text ?? '',
      provider: this.name,
      model,
      tokensUsed: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      costEstimate: this.estimateCost(data.usage),
      durationMs: Date.now() - start,
    };
  }

  private estimateCost(usage: { input_tokens?: number; output_tokens?: number } | undefined): number {
    if (!usage) return 0;
    // Estimation grossière — à remplacer par la grille tarifaire réelle.
    return ((usage.input_tokens ?? 0) * 0.003 + (usage.output_tokens ?? 0) * 0.015) / 1000;
  }
}
