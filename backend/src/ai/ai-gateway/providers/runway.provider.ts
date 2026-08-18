import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, GenerateVideoParams, AiGenerationResult } from './ai-provider.interface';
import { fetchWithTimeout } from '../../../common/http/fetch-with-timeout';

// Provider Runway (api.dev.runwayml.com) : génération vidéo par image-to-video — contrairement
// à Google Veo (texte seul), Runway exige une image source (params.imageUrl : le visuel déjà
// généré pour cette même campagne par AiOrchestratorService, animé plutôt que produit depuis
// rien). Fournisseur de REPLI : câblé dans AiGatewayService.fallbackChains après google-veo,
// jamais tenté en premier tant que Veo répond — utile quand Veo est indisponible (facturation
// GCP non configurée, panne, quota), sans dépendre de sa remise en service.
@Injectable()
export class RunwayProvider implements AiProvider {
  readonly name = 'runway';
  private readonly apiKey: string | undefined;
  private static readonly API_VERSION = '2024-11-06';
  private static readonly MODEL = 'gen4_turbo';
  // Coût approximatif : ~$0.01/crédit (tarif Runway usuellement documenté ainsi), pas vérifié
  // avec la même rigueur que le $0.50/s de Google Veo (cf. GoogleVeoProvider) — à confirmer sur
  // un vrai relevé de facturation avant de s'appuyer dessus pour un calcul de marge fin.
  private static readonly USD_PER_CREDIT = 0.01;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('RUNWAY_API_KEY');
  }

  async generateVideo(params: GenerateVideoParams): Promise<AiGenerationResult> {
    const start = Date.now();
    if (!params.imageUrl) {
      throw new Error("Runway: image source requise (image-to-video) — aucune image fournie par l'appelant.");
    }
    // gen4_turbo n'accepte que 5 ou 10 secondes — la valeur demandée (8s par défaut, cf.
    // AiOrchestratorService) est arrondie à la plus proche plutôt que rejetée.
    const requested = params.durationSeconds ?? 8;
    const duration = requested <= 7 ? 5 : 10;

    const submitRes = await fetchWithTimeout('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': RunwayProvider.API_VERSION,
      },
      body: JSON.stringify({
        model: RunwayProvider.MODEL,
        promptImage: params.imageUrl,
        promptText: params.prompt.slice(0, 1000), // limite documentée côté Runway
        ratio: '720:1280', // portrait — cohérent avec l'aspectRatio 9:16 déjà utilisé par Google Veo
        duration,
      }),
    });
    if (!submitRes.ok) throw new Error(`Runway error: ${submitRes.status} ${await submitRes.text()}`);
    const { id, estimatedCost } = await submitRes.json();

    const videoUrl = await this.pollUntilComplete(id);

    return {
      content: videoUrl,
      provider: this.name,
      model: RunwayProvider.MODEL,
      costEstimate: (estimatedCost?.credits ?? duration * 5) * RunwayProvider.USD_PER_CREDIT,
      durationMs: Date.now() - start,
    };
  }

  // Flux asynchrone (soumission puis polling) — même contrat que GoogleVeoProvider : l'appelant
  // (AI Orchestrator) tourne déjà dans un worker BullMQ, attendre ici ne bloque jamais l'API HTTP.
  private async pollUntilComplete(taskId: string, maxAttempts = 30): Promise<string> {
    const url = `https://api.dev.runwayml.com/v1/tasks/${taskId}`;
    const headers = { Authorization: `Bearer ${this.apiKey}`, 'X-Runway-Version': RunwayProvider.API_VERSION };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const res = await fetchWithTimeout(url, { headers }, 15_000);
      const data = await res.json();

      if (data.status === 'SUCCEEDED') {
        const videoUrl = data.output?.[0];
        if (!videoUrl) throw new Error('Runway: réponse sans URL vidéo');
        return videoUrl;
      }
      if (data.status === 'FAILED') {
        throw new Error(`Runway: génération échouée — ${data.failure ?? 'raison inconnue'}`);
      }
    }
    throw new Error("Runway: délai d'attente dépassé pour la génération vidéo");
  }
}
