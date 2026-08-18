import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiProvider,
  GenerateTextParams,
  GenerateImageParams,
  GenerateAudioParams,
  TranscribeAudioParams,
  TranscriptSegment,
  AnalyzeImageParams,
  ModerateTextResult,
  AiGenerationResult,
} from './ai-provider.interface';
import { fetchWithTimeout } from '../../../common/http/fetch-with-timeout';

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

    const response = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: params.prompt }],
          // max_completion_tokens, pas max_tokens : l'API OpenAI rejette max_tokens (paramètre
          // legacy) sur les modèles récents ("Unsupported parameter", erreur 400 constatée en
          // conditions réelles) — vérifié en conditions réelles le 2026-08-16.
          // 4000, pas 1000 : gpt-5 est un modèle à raisonnement — max_completion_tokens couvre le
          // raisonnement interne ET la réponse visible, dans le même budget. 1000 s'est avéré
          // entièrement consommé par le raisonnement lors d'un test en conditions réelles le
          // 2026-08-16 (`data.choices[0].message.content` vide malgré une réponse 200).
          max_completion_tokens: params.maxTokens ?? 4000,
        }),
      },
      // 60s, pas le défaut 20s : conséquence directe du budget élevé ci-dessus — un modèle à
      // raisonnement avec plus de marge de sortie prend plus de temps à répondre. Confirmé en
      // conditions réelles le 2026-08-16 : AbortError systématique à 20s après le passage de
      // max_completion_tokens de 1000 à 4000 (la requête aurait probablement abouti, interrompue
      // avant). Même valeur que generateImage() ci-dessous, pour la même raison.
      60_000,
    );

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      provider: this.name,
      model,
      tokensUsed: data.usage?.total_tokens,
      costEstimate: this.estimateCost(data.usage),
      durationMs: Date.now() - start,
    };
  }

  async generateImage(params: GenerateImageParams): Promise<AiGenerationResult> {
    const start = Date.now();
    // gpt-image-1.5, pas gpt-image-1 : gpt-image-1 est retiré par OpenAI le 23 octobre 2026
    // (vérifié le 2026-08-16) — le repli sur cette date aurait cassé generateImage() côté
    // OpenAI, avant même de considérer Flux/Ideogram comme fournisseur de secours.
    const model = 'gpt-image-1.5';

    // Ancrage sur une image de référence (chantier "fidélité visuelle du visuel marketing",
    // 2026-08-18) : sans params.imageUrl, comportement strictement inchangé (texte-vers-image
    // pur, /v1/images/generations). Avec, bascule vers /v1/images/edits — sinon le visuel
    // publicitaire est inventé de toutes pièces à partir du texte seul, avec le risque réel
    // constaté qu'il représente un produit/une marque différente de celle réellement injectée.
    const response = params.imageUrl
      ? await this.generateImageFromReference(params, model)
      : await fetchWithTimeout(
          'https://api.openai.com/v1/images/generations',
          {
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
          },
          // 60s, pas le défaut 20s : gpt-image-1.5 met régulièrement plus de 20s à répondre (constaté
          // en conditions réelles le 2026-08-16, timeout systématique sur ce seul appel) — les
          // autres appels OpenAI (texte, TTS, vision, Whisper) restent au défaut, jamais aussi lents.
          60_000,
        );

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    // gpt-image-1.5 ne renvoie JAMAIS d'URL hébergée — uniquement `b64_json` (vérifié en
    // conditions réelles le 2026-08-16, `data.data[0]` n'a que cette clé) : contrairement à
    // dall-e-2/3, il n'existe pas de paramètre response_format pour demander une URL. Content
    // devient donc un data URI, même convention que generateAudio() (data:...;base64,...).
    const image = data.data[0];
    const content = image.url ?? `data:image/${data.output_format ?? 'png'};base64,${image.b64_json}`;
    return {
      content,
      provider: this.name,
      model,
      costEstimate: this.estimateImageCost(data.usage),
      durationMs: Date.now() - start,
    };
  }

  // Édition ancrée sur une image de référence (/v1/images/edits, multipart) — même pattern
  // FormData/Blob déjà en place pour transcribeAudio() ci-dessous. La forme de réponse
  // (`data.data[0]`, `b64_json`) est identique à /v1/images/generations pour gpt-image-1.5,
  // aucun parsing dédié nécessaire côté appelant.
  private async generateImageFromReference(params: GenerateImageParams, model: string): Promise<Response> {
    const { buffer, mimeType } = await this.resolveImageBufferForEdit(params.imageUrl!);
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', params.prompt);
    form.append('size', params.size ?? '1024x1024');
    // Uint8Array.from() : même contournement de typage que transcribeAudio() ci-dessous
    // (Buffer<ArrayBufferLike> non assignable à BlobPart).
    form.append('image', new Blob([Uint8Array.from(buffer)], { type: mimeType }), 'reference.png');

    return fetchWithTimeout(
      'https://api.openai.com/v1/images/edits',
      { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form },
      60_000, // même délai que generateImage() : gpt-image-1.5 est lent sur les deux endpoints.
    );
  }

  // Même logique que GoogleVeoProvider.resolveImageForVeo (2026-08-18) : data URI décodé
  // directement, URL hébergée récupérée par fetch — dupliqué plutôt que partagé car chaque
  // provider a une forme de sortie différente (bytesBase64Encoded+mimeType côté Veo, Buffer brut
  // ici pour construire le Blob multipart).
  private async resolveImageBufferForEdit(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const dataUriMatch = /^data:(.+?);base64,(.+)$/.exec(imageUrl);
    if (dataUriMatch) {
      const [, mimeType, base64] = dataUriMatch;
      return { buffer: Buffer.from(base64, 'base64'), mimeType };
    }
    const res = await fetchWithTimeout(imageUrl);
    if (!res.ok) throw new Error(`OpenAI: impossible de récupérer l'image de référence : HTTP ${res.status}`);
    const mimeType = res.headers.get('content-type') ?? 'image/png';
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType };
  }

  // Voix off (text-to-speech) : narration lue à partir du script vidéo généré par
  // l'Orchestrator (cf. AiOrchestratorService.generateCampaign) — l'API OpenAI ne renvoie
  // aucune URL hébergée pour l'audio (contrairement à generateImage), juste les octets bruts
  // de la réponse HTTP : encodés ici en data URI, re-hébergés ensuite comme n'importe quel
  // autre asset généré par CampaignGenerationProcessor.registerGeneratedAudio().
  async generateAudio(params: GenerateAudioParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'tts-1';

    const response = await fetchWithTimeout('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, voice: 'onyx', input: params.prompt }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI TTS error: ${response.status} ${await response.text()}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    return {
      content: `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`,
      provider: this.name,
      model,
      // Tarif tts-1 : $0.015 / 1000 caractères — pas de "tokens" à proprement parler ici.
      costEstimate: (params.prompt.length / 1000) * 0.015,
      durationMs: Date.now() - start,
    };
  }

  // Transcription (Whisper) : sert exclusivement à générer les sous-titres de la vidéo finale
  // (cf. VideoAssemblyService) — transcrit l'audio RÉELLEMENT généré par generateAudio(), pas le
  // texte du script, pour obtenir le timing effectif de la parole (débit, pauses), impossible à
  // déduire du texte seul. `verbose_json` + `timestamp_granularities=segment` sont nécessaires
  // pour obtenir des horodatages : le format par défaut ne renvoie que du texte brut.
  async transcribeAudio(params: TranscribeAudioParams): Promise<AiGenerationResult> {
    const start = Date.now();
    const model = 'whisper-1';

    const form = new FormData();
    // Uint8Array.from() plutôt que le Buffer brut : le type Buffer<ArrayBufferLike> de Node
    // n'est pas assignable à BlobPart (incompatibilité SharedArrayBuffer côté typage DOM),
    // une copie en Uint8Array standard satisfait le constructeur Blob sans changer les octets.
    form.append('file', new Blob([Uint8Array.from(params.audioBuffer)], { type: params.mimeType }), 'narration.mp3');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');

    // Pas de header Content-Type manuel : fetch génère lui-même le boundary multipart correct
    // à partir de l'objet FormData — le fixer à la main casserait le parsing côté serveur.
    const response = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`OpenAI Whisper error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const segments: TranscriptSegment[] = (data.segments ?? []).map((s: { start: number; end: number; text: string }) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));

    return {
      content: JSON.stringify(segments),
      provider: this.name,
      model,
      // Tarif Whisper : $0.006/minute — calculé sur la durée RÉELLE renvoyée par l'API
      // (`data.duration`), pas estimée depuis la taille du buffer.
      costEstimate: ((data.duration ?? 0) / 60) * 0.006,
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
    const imageUrl = await this.toInlineImageUrl(params.imageUrl);

    const response = await fetchWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
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
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          response_format: { type: 'json_object' },
          // 2500, pas 1500 : même raison que generateText() — gpt-5 (raisonnement) partage le
          // budget entre analyse interne et JSON de sortie ; 1500 a produit une réponse TRONQUÉE
          // en conditions réelles le 2026-08-18 (VisualDnaService.extract, "Unexpected end of
          // JSON input") sur un prompt demandant 6 champs (dont plusieurs tableaux), plus
          // verbeux que les usages historiques (analyse produit : 4 champs). 400 avait déjà
          // produit un contenu totalement vide le 2026-08-16 (cf. AiOrchestratorService.
          // analyzeProductImage) — same schéma, prompt plus exigeant = budget insuffisant.
          max_completion_tokens: 2500,
        }),
      },
      // 60s, pas le défaut 20s : même raison que generateText() — un budget de sortie plus
      // large (vision + raisonnement) prend plus de temps que les 400 tokens précédents.
      60_000,
    );

    if (!response.ok) {
      throw new Error(`OpenAI vision error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      provider: this.name,
      model,
      tokensUsed: data.usage?.total_tokens,
      costEstimate: this.estimateCost(data.usage),
      durationMs: Date.now() - start,
    };
  }

  // OpenAI télécharge lui-même l'image depuis `image_url.url` — ce qui suppose une URL
  // publiquement accessible DEPUIS SES PROPRES SERVEURS. Jamais vrai pour une image stockée
  // localement (STORAGE_PROVIDER=local, cf. StorageService) : `http://localhost:3001/...`
  // n'existe que sur cette machine, provoquant une erreur "invalid_image_url" côté OpenAI —
  // constaté en conditions réelles le 2026-08-16 sur la toute première analyse produit lancée
  // depuis l'interface (jamais reproduit via le script CLI, qui ne passe jamais par le
  // stockage local — image transmise directement en base64). Inliner systématiquement en data
  // URI élimine cette dépendance réseau, plutôt que de supposer l'URL joignable de l'extérieur
  // — vrai aussi en production derrière un VPN/pare-feu, pas seulement en local.
  private async toInlineImageUrl(imageUrl: string): Promise<string> {
    if (imageUrl.startsWith('data:')) return imageUrl;

    const res = await fetchWithTimeout(imageUrl);
    if (!res.ok) throw new Error(`Impossible de récupérer l'image pour l'analyse vision : HTTP ${res.status}`);
    const mimeType = res.headers.get('content-type') ?? 'image/png';
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  // Modération de sécurité : endpoint dédié, non facturé par tokens chez OpenAI (coût=0),
  // mais tout de même journalisé pour le volume d'appels et la fiabilité du fournisseur.
  async moderateText(text: string): Promise<ModerateTextResult> {
    const response = await fetchWithTimeout('https://api.openai.com/v1/moderations', {
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

  // $1,25/$10 par 1M tokens (input/output) — tarif réel gpt-5 vérifié le 2026-08-16. Remplace
  // l'ancien forfait plat de $10/1M appliqué à TOUS les tokens (input+output confondus) : ce
  // forfait surestimait fortement le coût des appels à prompt long / réponse courte (le cas
  // dominant de ce pipeline — stratégie, contexte de marque, prompts par canal), en facturant
  // l'input au tarif output (8x trop cher sur cette partie).
  private estimateCost(usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): number {
    if (!usage) return 0;
    return ((usage.prompt_tokens ?? 0) * 1.25 + (usage.completion_tokens ?? 0) * 10) / 1_000_000;
  }

  // $5/$10 par 1M tokens (input/output) — tarif réel gpt-image-1.5 vérifié le 2026-08-16.
  // L'API image renvoie bien un objet `usage` en tokens (comme les endpoints texte), contrairement
  // à ce que supposait l'ancien commentaire de ce fichier — remplace le forfait de $0.04/image.
  // Repli forfaitaire conservé seulement si l'API omet exceptionnellement `usage`.
  private estimateImageCost(usage: { input_tokens?: number; output_tokens?: number } | undefined): number {
    if (!usage) return 0.04;
    return ((usage.input_tokens ?? 0) * 5 + (usage.output_tokens ?? 0) * 10) / 1_000_000;
  }
}
