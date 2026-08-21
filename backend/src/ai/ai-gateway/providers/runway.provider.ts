import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, GenerateVideoParams, AiGenerationResult } from './ai-provider.interface';
import { fetchWithTimeout } from '../../../common/http/fetch-with-timeout';
import { resolveMediaBuffer } from '../../../common/http/resolve-media-buffer';

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
    const promptImage = await this.resolvePromptImage(params.imageUrl);

    const submitRes = await fetchWithTimeout('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': RunwayProvider.API_VERSION,
      },
      body: JSON.stringify({
        model: RunwayProvider.MODEL,
        promptImage,
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

  // Bug corrigé le 2026-08-18 (constaté en conditions réelles — bascule Veo→Runway) : Runway
  // n'accepte promptImage QUE sous 3 formes (https://, runway:// ou data:image/...;base64,...) —
  // jamais un http:// brut, cf. son propre schéma de validation. Or referenceImageUrl (passé par
  // AiOrchestratorService) est souvent servi par NOTRE stockage local en dev (http://localhost:
  // .../uploads/...), une URL que Runway ne pourrait de toute façon jamais atteindre depuis ses
  // serveurs même si le préfixe passait. On récupère nous-mêmes les octets (resolveMediaBuffer,
  // déjà utilisé ailleurs pour ce même besoin) et on les réinjecte en data URI — la même
  // information, sous une forme que l'API accepte et n'a pas besoin d'aller chercher elle-même.
  private async resolvePromptImage(imageUrl: string): Promise<string> {
    if (/^https:\/\//.test(imageUrl) || /^runway:\/\//.test(imageUrl) || /^data:image\//.test(imageUrl)) {
      return imageUrl;
    }
    const buffer = await resolveMediaBuffer(imageUrl);
    const extension = /\.(png|jpe?g|webp|gif)(?:$|\?)/i.exec(imageUrl)?.[1]?.toLowerCase() ?? 'png';
    const mimeSubtype = extension === 'jpg' ? 'jpeg' : extension;
    return `data:image/${mimeSubtype};base64,${buffer.toString('base64')}`;
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
