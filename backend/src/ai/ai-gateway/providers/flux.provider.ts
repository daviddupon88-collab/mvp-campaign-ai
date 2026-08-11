import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, GenerateImageParams, AiGenerationResult } from './ai-provider.interface';

// Provider Flux : génération d'image via l'API Replicate, qui héberge le modèle Flux
// (Black Forest Labs). Comme Veo, l'appel est asynchrone côté Replicate — on encapsule
// le polling ici pour respecter le contrat synchrone AiProvider.
// Nécessite REPLICATE_API_TOKEN.
@Injectable()
export class FluxProvider implements AiProvider {
  readonly name = 'flux';
  private readonly logger = new Logger(FluxProvider.name);
  private readonly apiToken: string | undefined;
  private static readonly MODEL_VERSION = 'black-forest-labs/flux-1.1-pro';

  constructor(private readonly config: ConfigService) {
    this.apiToken = this.config.get<string>('REPLICATE_API_TOKEN');
  }

  async generateImage(params: GenerateImageParams): Promise<AiGenerationResult> {
    const start = Date.now();

    const createRes = await fetch(`https://api.replicate.com/v1/models/${FluxProvider.MODEL_VERSION}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        Prefer: 'wait', // demande à Replicate d'attendre jusqu'à ~60s avant de répondre
      },
      body: JSON.stringify({
        input: {
          prompt: params.prompt,
          aspect_ratio: this.mapSizeToAspectRatio(params.size),
          output_format: 'jpg',
        },
      }),
    });

    if (!createRes.ok) throw new Error(`Flux (Replicate) error: ${createRes.status} ${await createRes.text()}`);
    let prediction = await createRes.json();

    // Si le header Prefer:wait n'a pas suffi (génération plus longue), on poll.
    if (prediction.status !== 'succeeded') {
      prediction = await this.pollUntilComplete(prediction.urls.get);
    }

    const imageUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!imageUrl) throw new Error('Flux: réponse sans image générée');

    return {
      content: imageUrl,
      provider: this.name,
      model: 'flux-1.1-pro',
      costEstimate: 0.04, // tarif indicatif Replicate par génération, à ajuster selon la grille réelle
      durationMs: Date.now() - start,
    };
  }

  private mapSizeToAspectRatio(size?: string): string {
    if (size === '1024x1792' || size === '1080x1920') return '9:16'; // format story/reel
    if (size === '1792x1024') return '16:9';
    return '1:1'; // par défaut, adapté aux posts Facebook/Instagram carrés
  }

  private async pollUntilComplete(statusUrl: string, maxAttempts = 20): Promise<any> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await fetch(statusUrl, { headers: { Authorization: `Bearer ${this.apiToken}` } });
      const data = await res.json();
      if (data.status === 'succeeded') return data;
      if (data.status === 'failed' || data.status === 'canceled') {
        throw new Error(`Flux: génération échouée (${data.status})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('Flux: délai d\'attente dépassé pour la génération image');
  }
}
