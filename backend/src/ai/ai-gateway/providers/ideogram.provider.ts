import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, GenerateImageParams, AiGenerationResult } from './ai-provider.interface';
import { fetchWithTimeout } from '../../../common/http/fetch-with-timeout';

// Provider Ideogram : particulièrement adapté aux visuels publicitaires qui intègrent
// du texte lisible (bannières, affiches, miniatures) — un point faible connu des autres
// générateurs d'image. Utile pour le Creative Studio (Module 10) sur ce cas précis.
// Nécessite IDEOGRAM_API_KEY.
@Injectable()
export class IdeogramProvider implements AiProvider {
  readonly name = 'ideogram';
  private readonly apiKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('IDEOGRAM_API_KEY');
  }

  async generateImage(params: GenerateImageParams): Promise<AiGenerationResult> {
    const start = Date.now();

    const response = await fetchWithTimeout('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Api-Key': this.apiKey ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_request: {
          prompt: params.prompt,
          aspect_ratio: 'ASPECT_1_1',
          model: 'V_2',
          magic_prompt_option: 'AUTO',
        },
      }),
    });

    if (!response.ok) throw new Error(`Ideogram error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    const image = data.data?.[0];
    if (!image?.url) throw new Error('Ideogram: réponse sans image générée');

    return {
      content: image.url,
      provider: this.name,
      model: 'ideogram-v2',
      // $0.08/image (modèle V_2, standard) — tarif public vérifié le 2026-08-13 (cf. l'audit
      // "coût réel d'un crédit"). Avant cette correction, ce provider ne renseignait jamais
      // `costEstimate`, laissant tout appel à ce fournisseur de repli invisible dans le
      // reporting de marge réelle (AiEconomicsService.getMarginSummary()).
      costEstimate: 0.08,
      durationMs: Date.now() - start,
    };
  }
}
