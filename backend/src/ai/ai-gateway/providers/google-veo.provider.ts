import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuth } from 'google-auth-library';
import { AiProvider, GenerateVideoParams, AiGenerationResult } from './ai-provider.interface';
import { fetchWithTimeout } from '../../../common/http/fetch-with-timeout';

// Provider Google Veo : génération vidéo via Vertex AI.
// Le flux Veo est asynchrone (predictLongRunning) — cette implémentation encapsule
// le polling pour respecter le contrat synchrone de AiProvider ; l'appelant (AI Orchestrator)
// tourne déjà dans un worker BullMQ, donc attendre ici ne bloque jamais l'API HTTP.
//
// Prérequis : projet Google Cloud avec Vertex AI activé, accès Veo autorisé (accès restreint
// à la date d'écriture), et des identifiants (Application Default Credentials ou compte de
// service — cf. getAccessToken()).
@Injectable()
export class GoogleVeoProvider implements AiProvider {
  readonly name = 'google-veo';
  private readonly projectId: string;
  private readonly location: string;
  // GOOGLE_CLOUD_ACCESS_TOKEN reste utilisable tel quel (commodité dev/test local, comme
  // avant) mais n'est plus le SEUL chemin : dès qu'il est absent, on bascule sur
  // google-auth-library (Application Default Credentials / compte de service), qui gère le
  // renouvellement automatique — corrige la panne silencieuse après ~1h documentée ici même
  // avant cette correction (token statique jamais renouvelé en production).
  private readonly staticAccessToken: string | undefined;
  private auth: GoogleAuth | null = null;

  constructor(private readonly config: ConfigService) {
    this.projectId = this.config.get<string>('GOOGLE_CLOUD_PROJECT_ID', '');
    this.location = this.config.get<string>('GOOGLE_CLOUD_LOCATION', 'us-central1');
    this.staticAccessToken = this.config.get<string>('GOOGLE_CLOUD_ACCESS_TOKEN');
  }

  private async getAccessToken(): Promise<string> {
    if (this.staticAccessToken) return this.staticAccessToken;

    // GoogleAuth met lui-même en cache et renouvelle le token en interne (appel réseau
    // seulement quand nécessaire) — un seul client réutilisé pour tous les appels du provider.
    this.auth ??= new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await this.auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error('Google Veo: impossible d\'obtenir un token d\'accès (Application Default Credentials absentes/invalides)');
    return token;
  }

  // $0.50/seconde de vidéo générée (720p/1080p, vidéo seule) — tarif Vertex AI vérifié le
  // 2026-08-13 (cf. l'audit "coût réel d'un crédit"). Avant cette correction, ce provider ne
  // renseignait JAMAIS `costEstimate` : le poste de coût dominant d'une campagne (98%+ du
  // coût réel total) était invisible dans AiEconomicsService.getMarginSummary() et tout le
  // reporting /ai-usage, qui sous-estimaient donc structurellement la marge réelle.
  private static readonly USD_PER_SECOND = 0.5;

  async generateVideo(params: GenerateVideoParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'veo-2.0-generate-001';
    const endpoint = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${model}:predictLongRunning`;
    const accessToken = await this.getAccessToken();
    const durationSeconds = params.durationSeconds ?? 8;

    const submitRes = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: params.prompt }],
        parameters: { durationSeconds, aspectRatio: '9:16' },
      }),
    });
    if (!submitRes.ok) throw new Error(`Google Veo error: ${submitRes.status} ${await submitRes.text()}`);
    const { name: operationName } = await submitRes.json();

    const videoUrl = await this.pollUntilComplete(operationName);

    return {
      content: videoUrl,
      provider: this.name,
      model,
      costEstimate: durationSeconds * GoogleVeoProvider.USD_PER_SECOND,
      durationMs: Date.now() - start,
    };
  }

  // Interroge périodiquement l'opération longue jusqu'à obtenir le résultat.
  // Le SLA Veo publié tourne autour de quelques dizaines de secondes à quelques minutes —
  // un polling de plusieurs minutes peut franchir la fenêtre de validité d'un token, donc le
  // token est redemandé à chaque itération (getAccessToken() renvoie le cache tant qu'il est
  // valide, ne fait un appel réseau que lorsqu'un renouvellement est réellement nécessaire).
  private async pollUntilComplete(operationName: string, maxAttempts = 30): Promise<string> {
    const fetchOpUrl = `https://${this.location}-aiplatform.googleapis.com/v1/${operationName}`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const accessToken = await this.getAccessToken();
      const res = await fetchWithTimeout(fetchOpUrl, { headers: { Authorization: `Bearer ${accessToken}` } }, 15_000);
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
