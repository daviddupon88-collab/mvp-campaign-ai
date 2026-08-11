import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider, GenerateVideoParams, AiGenerationResult } from './ai-provider.interface';

// Provider Google Veo : génération vidéo via Vertex AI.
// Le flux Veo est asynchrone (predictLongRunning) — cette implémentation encapsule
// le polling pour respecter le contrat synchrone de AiProvider ; l'appelant (AI Orchestrator)
// tourne déjà dans un worker BullMQ, donc attendre ici ne bloque jamais l'API HTTP.
//
// Prérequis : projet Google Cloud avec Vertex AI activé, accès Veo autorisé (accès restreint
// à la date d'écriture), et un token d'accès (Application Default Credentials ou service account).
@Injectable()
export class GoogleVeoProvider implements AiProvider {
  readonly name = 'google-veo';
  private readonly logger = new Logger(GoogleVeoProvider.name);
  private readonly projectId: string;
  private readonly location: string;
  private readonly accessToken: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.projectId = this.config.get<string>('GOOGLE_CLOUD_PROJECT_ID', '');
    this.location = this.config.get<string>('GOOGLE_CLOUD_LOCATION', 'us-central1');
    // En production : générer ce token via google-auth-library plutôt qu'une variable statique
    // (les tokens Google Cloud expirent après 1h) — voir note en fin de fichier.
    this.accessToken = this.config.get<string>('GOOGLE_CLOUD_ACCESS_TOKEN');
  }

  async generateVideo(params: GenerateVideoParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'veo-2.0-generate-001';
    const endpoint = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${model}:predictLongRunning`;

    const submitRes = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: params.prompt }],
        parameters: { durationSeconds: params.durationSeconds ?? 8, aspectRatio: '9:16' },
      }),
    });
    if (!submitRes.ok) throw new Error(`Google Veo error: ${submitRes.status} ${await submitRes.text()}`);
    const { name: operationName } = await submitRes.json();

    const videoUrl = await this.pollUntilComplete(operationName);

    return {
      content: videoUrl,
      provider: this.name,
      model,
      durationMs: Date.now() - start,
    };
  }

  // Interroge périodiquement l'opération longue jusqu'à obtenir le résultat.
  // Le SLA Veo publié tourne autour de quelques dizaines de secondes à quelques minutes.
  private async pollUntilComplete(operationName: string, maxAttempts = 30): Promise<string> {
    const fetchOpUrl = `https://${this.location}-aiplatform.googleapis.com/v1/${operationName}`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const res = await fetch(fetchOpUrl, { headers: { Authorization: `Bearer ${this.accessToken}` } });
      const data = await res.json();

      if (data.done) {
        const videoUri = data.response?.predictions?.[0]?.videoUri;
        if (!videoUri) throw new Error('Google Veo: réponse sans URI vidéo');
        return videoUri;
      }
    }
    throw new Error('Google Veo: délai d\'attente dépassé pour la génération vidéo');
  }
}

// NOTE PRODUCTION : remplacer GOOGLE_CLOUD_ACCESS_TOKEN par une génération dynamique via
// `google-auth-library` (GoogleAuth().getAccessToken()) avec un compte de service dédié —
// un token statique en variable d'environnement expire en ~1h et cassera silencieusement.
