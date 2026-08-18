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

  // Même logique que OpenAiProvider.toInlineImageUrl() (data URI déjà inline vs URL à récupérer
  // et encoder), mais renvoie {bytesBase64Encoded, mimeType} séparés plutôt qu'un data URI —
  // c'est la forme attendue par le champ `image` de Vertex AI, pas une chaîne data URI unique.
  private async resolveImageForVeo(imageUrl: string): Promise<{ bytesBase64Encoded: string; mimeType: string }> {
    const dataUriMatch = /^data:(.+?);base64,(.+)$/.exec(imageUrl);
    if (dataUriMatch) {
      const [, mimeType, base64] = dataUriMatch;
      return { bytesBase64Encoded: base64, mimeType };
    }

    const res = await fetchWithTimeout(imageUrl);
    if (!res.ok) throw new Error(`Google Veo: impossible de récupérer l'image de référence : HTTP ${res.status}`);
    const mimeType = res.headers.get('content-type') ?? 'image/png';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { bytesBase64Encoded: buffer.toString('base64'), mimeType };
  }

  // ~$0.05/seconde de vidéo générée (vidéo seule, sans audio) pour Veo 3.1 Lite — estimation
  // reconstituée le 2026-08-17 à partir de sources tierces (agrégateurs de prix), PAS de la
  // page de tarification officielle Vertex AI elle-même (non accessible en l'état) — à
  // confirmer sur un vrai relevé de facturation avant de s'appuyer dessus pour un calcul de
  // marge fin, même principe que USD_PER_CREDIT dans RunwayProvider.
  private static readonly USD_PER_SECOND = 0.05;

  async generateVideo(params: GenerateVideoParams): Promise<AiGenerationResult> {
    const start = Date.now();
    // veo-3.1-lite-generate-001, pas veo-3.0-generate-001 : Veo 3.0 (comme Veo 3.1 standard et
    // Veo 3.1 Fast) est un modèle à accès restreint (allowlist Google requise projet par
    // projet, cf. réponse 404 NOT_FOUND observée en conditions réelles le 2026-08-17 malgré
    // facturation/API/IAM correctement configurés). Veo 3.1 Lite, lancé le 2026-03-31, est
    // disponible en preview PUBLIQUE sans allowlist — seul modèle Veo confirmé accessible sans
    // démarche d'accès séparée sur ce projet (vérifié le 2026-08-17 par sondage direct de
    // l'API : les variantes "-preview" comme "veo-3.1-lite-generate-preview" renvoient 404,
    // seul le suffixe "-generate-001" a répondu 200 à une vraie soumission predictLongRunning).
    const model = 'veo-3.1-lite-generate-001';
    const modelResource = `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${model}`;
    const endpoint = `https://${this.location}-aiplatform.googleapis.com/v1/${modelResource}:predictLongRunning`;
    const accessToken = await this.getAccessToken();
    const durationSeconds = params.durationSeconds ?? 8;

    // Ancrage sur la vraie image produit (image-to-video) — correction du 2026-08-18 : jusqu'ici
    // `params.imageUrl` était transmis par l'appelant (cf. AiOrchestratorService) mais jamais lu
    // ici, Veo générait donc en texte-vers-vidéo PUR, sans jamais voir la photo produit réelle —
    // rien ne garantissait que la vidéo générée représente fidèlement le produit injecté. Le
    // champ `image` de predictLongRunning (instance-level, pas `parameters`) prend le même
    // couple {bytesBase64Encoded, mimeType} que celui déjà utilisé pour LIRE la réponse de Veo
    // plus bas dans ce fichier — cohérent avec la forme documentée par Google
    // (VideoGenerationModelInstance), non vérifiée contre une vraie réponse API à ce stade :
    // à confirmer au premier test réel (un 400 mentionnant `image` serait un rejet informatif).
    const instance: Record<string, unknown> = { prompt: params.prompt };
    if (params.imageUrl) {
      instance.image = await this.resolveImageForVeo(params.imageUrl);
    }

    const submitRes = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [instance],
        // generateAudio: false, EXPLICITE (pas seulement l'absence du champ) : Veo 3 sait générer
        // son propre son/dialogue, mais à $0.75/s au lieu de $0.50/s (cf. USD_PER_SECOND), ET ce
        // son serait générique/imprévisible plutôt que la narration exacte du script généré par
        // l'Orchestrator. L'audio final (narration + nappe musicale + sous-titres) est déjà
        // garanti en aval par VideoAssemblyService (mixage ffmpeg) puis vérifié par
        // VideoQcService.validate() — qui fait ÉCHOUER la génération si `hasAudioStream` est
        // faux — donc Veo n'a jamais besoin de produire de son lui-même pour que la vidéo finale
        // en ait un.
        parameters: { durationSeconds, aspectRatio: '9:16', generateAudio: false },
      }),
    });
    if (!submitRes.ok) throw new Error(`Google Veo error: ${submitRes.status} ${await submitRes.text()}`);
    const { name: operationName } = await submitRes.json();

    const videoContent = await this.pollUntilComplete(modelResource, operationName);

    return {
      content: videoContent,
      provider: this.name,
      model,
      costEstimate: durationSeconds * GoogleVeoProvider.USD_PER_SECOND,
      durationMs: Date.now() - start,
    };
  }

  // Interroge périodiquement l'opération longue jusqu'à obtenir le résultat.
  // Corrige un bug réel constaté en conditions réelles le 2026-08-17 (jamais détecté avant,
  // faute d'avoir pu soumettre une vraie opération avec des credentials GCP valides) : les
  // opérations `predictLongRunning` de Vertex AI ne s'interrogent PAS via un GET générique sur
  // le nom de l'opération (pattern générique "Long-running operations" de l'API Google Cloud)
  // — Vertex AI expose sa propre méthode dédiée `models.fetchPredictOperation`, un POST sur la
  // ressource du MODÈLE (pas sur l'opération) avec `{"operationName": "..."}` dans le corps.
  // L'ancien GET produisait une page HTML 404 générique de Google plutôt qu'une erreur JSON
  // API, que `res.json()` (jamais gardé par un `res.ok`) faisait planter en SyntaxError opaque
  // au lieu de remonter une erreur exploitable.
  // Le SLA Veo publié tourne autour de quelques dizaines de secondes à quelques minutes —
  // un polling de plusieurs minutes peut franchir la fenêtre de validité d'un token, donc le
  // token est redemandé à chaque itération (getAccessToken() renvoie le cache tant qu'il est
  // valide, ne fait un appel réseau que lorsqu'un renouvellement est réellement nécessaire).
  private async pollUntilComplete(modelResource: string, operationName: string, maxAttempts = 30): Promise<string> {
    const fetchOpUrl = `https://${this.location}-aiplatform.googleapis.com/v1/${modelResource}:fetchPredictOperation`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const accessToken = await this.getAccessToken();
      const res = await fetchWithTimeout(
        fetchOpUrl,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationName }),
        },
        15_000,
      );
      if (!res.ok) throw new Error(`Google Veo error (poll): ${res.status} ${await res.text()}`);
      const data = await res.json();

      if (data.done) {
        // BUG CORRIGÉ le 2026-08-16 (jamais détecté faute d'avoir pu tester avec de vrais
        // credentials GCP) : la réponse predictLongRunning de Veo n'a JAMAIS eu de champ
        // `response.predictions[0].videoUri` (lu ici avant cette correction) — ce chemin
        // n'existe dans aucune version documentée de l'API. Sans `storageUri` dans la requête
        // (choix délibéré, cf. generateVideo — évite de dépendre d'un bucket GCS), Veo renvoie
        // la vidéo INLINE en base64 sous `response.videos[0].bytesBase64Encoded` (+ `mimeType`
        // sibling), jamais sous `predictions`. Avant ce correctif, CHAQUE appel Veo qui aurait
        // réussi authentification + génération aurait quand même échoué ici avec "réponse sans
        // URI vidéo" — indépendamment de toute configuration de credentials.
        const video = data.response?.videos?.[0];
        if (!video?.bytesBase64Encoded) throw new Error('Google Veo: réponse sans vidéo (bytesBase64Encoded absent)');
        // Data URI, même convention que generateAudio()/generateImage() côté OpenAI quand le
        // fournisseur ne renvoie pas d'URL hébergée — cf. VideoFinalizationService.resolveVideoBuffer()
        // pour la lecture correspondante côté assemblage.
        return `data:${video.mimeType ?? 'video/mp4'};base64,${video.bytesBase64Encoded}`;
      }
    }
    throw new Error('Google Veo: délai d\'attente dépassé pour la génération vidéo');
  }
}
