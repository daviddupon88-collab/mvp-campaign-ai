import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fetchWithTimeout } from '../../common/http/fetch-with-timeout';
import {
  SocialAdapter,
  OAuthAuthorizeParams,
  OAuthCallbackParams,
  OAuthTokenResult,
  PublishContentParams,
  PublishResult,
  AsyncPublishStatus,
  FetchInsightsParams,
  InsightsResult,
} from './social-adapter.interface';
import { SocialApiError } from './social-api-error';

const PLATFORM = 'TIKTOK';

// Adaptateur TikTok : utilise la Content Posting API (accès "Direct Post" soumis à review
// TikTok, distinct de l'accès "Login Kit" de base). Sans cette approbation, le token ne
// permet que l'upload en brouillon dans l'app TikTok, pas la publication directe.
@Injectable()
export class TikTokAdapter implements SocialAdapter {
  readonly platform = PLATFORM;
  private readonly clientKey: string;
  private readonly clientSecret: string;

  constructor(private readonly config: ConfigService) {
    this.clientKey = this.config.get<string>('TIKTOK_CLIENT_KEY', '');
    this.clientSecret = this.config.get<string>('TIKTOK_CLIENT_SECRET', '');
  }

  buildAuthorizeUrl({ organizationId, redirectUri }: OAuthAuthorizeParams): string {
    const params = new URLSearchParams({
      client_key: this.clientKey,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'video.publish,video.upload,user.info.basic',
      state: organizationId,
    });
    return `https://www.tiktok.com/v2/auth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken({ code, redirectUri }: OAuthCallbackParams): Promise<OAuthTokenResult> {
    const res = await fetchWithTimeout('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: this.clientKey,
        client_secret: this.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `OAuth error: ${await res.text()}`);
    const data = await res.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      externalAccountId: data.open_id,
      scopes: data.scope,
    };
  }

  // TikTok expose un refresh_token OAuth2 standard, valide 365 jours.
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokenResult> {
    const res = await fetchWithTimeout('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: this.clientKey,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec du rafraîchissement: ${await res.text()}`);
    const data = await res.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      externalAccountId: data.open_id ?? '',
    };
  }

  async publish({ accessToken, mediaUrl, caption }: PublishContentParams): Promise<PublishResult> {
    if (!mediaUrl) {
      throw new SocialApiError('TikTok requiert une vidéo (mediaUrl manquant)', { platform: PLATFORM, retryable: false });
    }

    // Initie la publication asynchrone : TikTok télécharge la vidéo depuis l'URL fournie,
    // puis la traite (encodage, vérifications) avant qu'elle soit réellement publiée —
    // d'où le statut initial "PROCESSING", suivi via checkPublishStatus() par PublishingService.
    const res = await fetchWithTimeout('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_info: { title: caption ?? '', privacy_level: 'PUBLIC_TO_EVERYONE' },
        source_info: { source: 'PULL_FROM_URL', video_url: mediaUrl },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec d'initialisation de la publication: ${errText}`);
    }
    const data = await res.json();
    const publishId = data.data?.publish_id;
    if (!publishId) {
      throw new SocialApiError("Réponse TikTok sans publish_id", { platform: PLATFORM, retryable: false });
    }
    return { externalPostId: publishId };
  }

  // Interroge le statut réel de la publication — appelé par PublishingService juste après
  // publish() pour ne renvoyer PUBLISHED que lorsque TikTok a confirmé le traitement complet.
  async checkPublishStatus(accessToken: string, publishId: string): Promise<AsyncPublishStatus> {
    const res = await fetchWithTimeout('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish_id: publishId }),
    });
    if (!res.ok) throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec de vérification du statut: ${await res.text()}`);

    const data = await res.json();
    const status = data.data?.status as string | undefined;

    if (status === 'PUBLISH_COMPLETE') return 'PUBLISHED';
    if (status === 'FAILED') return 'FAILED';
    return 'PROCESSING'; // PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, etc.
  }

  // Query Video List API. Limitation assumée : externalPostId stocké par ce module est le
  // publish_id retourné par publish/video/init (identifiant du JOB de publication), pas le
  // video_id final attribué à la vidéo publiée sur le compte — TikTok ne renvoie ce dernier
  // que via checkPublishStatus() une fois PUBLISH_COMPLETE, non capturé ni persisté ailleurs
  // dans ce module pour l'instant. En pratique les deux identifiants coïncident souvent, mais
  // ce n'est pas garanti par la documentation — à fiabiliser en faisant persister le
  // video_id réel par PublishingService au moment où checkPublishStatus() confirme la
  // publication, plutôt que de réutiliser le publish_id ici.
  async fetchInsights({ accessToken, externalPostId }: FetchInsightsParams): Promise<InsightsResult> {
    const res = await fetchWithTimeout('https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: { video_ids: [externalPostId] } }),
    });
    if (!res.ok) return {}; // insights non-critiques : échec silencieux, pas de SocialApiError ici

    const data = await res.json();
    const video = data.data?.videos?.[0];
    if (!video) return {};

    return {
      impressions: typeof video.view_count === 'number' ? video.view_count : undefined,
      // Proxy d'engagement organique, même logique que MetaAdapter — pas un clic publicitaire strict.
      clicks: (video.like_count ?? 0) + (video.comment_count ?? 0) + (video.share_count ?? 0),
      raw: data,
    };
  }
}
