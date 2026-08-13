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
  FetchInsightsParams,
  InsightsResult,
} from './social-adapter.interface';
import { SocialApiError } from './social-api-error';

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PLATFORM = 'META_FACEBOOK';

// Adaptateur Meta : gère à la fois Facebook Pages et Instagram Business,
// qui partagent la même Graph API et le même flux OAuth applicatif.
// Prérequis Meta : app en mode "Live" + review des permissions
// pages_manage_posts, pages_read_engagement, instagram_content_publish.
@Injectable()
export class MetaAdapter implements SocialAdapter {
  readonly platform = PLATFORM;
  private readonly appId: string;
  private readonly appSecret: string;

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('META_APP_ID', '');
    this.appSecret = this.config.get<string>('META_APP_SECRET', '');
  }

  buildAuthorizeUrl({ organizationId, redirectUri }: OAuthAuthorizeParams): string {
    const scopes = ['pages_manage_posts', 'pages_read_engagement', 'instagram_content_publish', 'pages_show_list'];
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: redirectUri,
      state: organizationId, // permet de retrouver le tenant au retour du callback
      scope: scopes.join(','),
      response_type: 'code',
    });
    return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
  }

  async exchangeCodeForToken({ code, redirectUri }: OAuthCallbackParams): Promise<OAuthTokenResult> {
    // Étape 1 : échange du code contre un token utilisateur court terme.
    const tokenUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
    tokenUrl.search = new URLSearchParams({
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: redirectUri,
      code,
    }).toString();

    const tokenRes = await fetchWithTimeout(tokenUrl.toString());
    if (!tokenRes.ok) throw SocialApiError.fromHttpStatus(PLATFORM, tokenRes.status, `OAuth error: ${await tokenRes.text()}`);
    const { access_token: shortLivedToken } = await tokenRes.json();

    const longLived = await this.exchangeForLongLivedToken(shortLivedToken);

    // Étape 3 : récupère la première Page gérée par l'utilisateur (MVP : une page par organisation).
    const pagesRes = await fetchWithTimeout(`${GRAPH_BASE}/me/accounts?access_token=${longLived.accessToken}`);
    if (!pagesRes.ok) throw SocialApiError.fromHttpStatus(PLATFORM, pagesRes.status, `Échec de récupération des pages: ${await pagesRes.text()}`);
    const pagesData = await pagesRes.json();
    const page = pagesData.data?.[0];
    if (!page) throw new SocialApiError('Aucune page Facebook trouvée pour ce compte', { platform: PLATFORM, retryable: false });

    return {
      accessToken: page.access_token, // token de la Page, requis pour publier en son nom
      expiresAt: longLived.expiresAt,
      externalAccountId: page.id,
      externalAccountName: page.name,
      scopes: 'pages_manage_posts,pages_read_engagement,instagram_content_publish',
    };
  }

  // Meta n'expose pas de refresh_token OAuth2 classique : un token de Page longue durée
  // (~60 jours) se "rafraîchit" en le ré-échangeant via le même mécanisme fb_exchange_token
  // AVANT son expiration — d'où l'utilisation du token courant comme entrée, pas d'un
  // refresh_token distinct. SocialConnectionsService appelle ceci avec le refreshToken
  // stocké ; pour Meta, on y stocke en réalité une copie du dernier accessToken valide
  // (cf. exchangeCodeForToken, qui pourrait être étendu pour le renseigner explicitement).
  async refreshAccessToken(currentAccessToken: string): Promise<OAuthTokenResult> {
    const longLived = await this.exchangeForLongLivedToken(currentAccessToken);
    return {
      accessToken: longLived.accessToken,
      refreshToken: longLived.accessToken, // cf. note ci-dessus
      expiresAt: longLived.expiresAt,
      externalAccountId: '', // non modifié par un refresh — SocialConnectionsService conserve l'existant
    };
  }

  private async exchangeForLongLivedToken(token: string): Promise<{ accessToken: string; expiresAt?: Date }> {
    const longLivedUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
    longLivedUrl.search = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: this.appId,
      client_secret: this.appSecret,
      fb_exchange_token: token,
    }).toString();
    const res = await fetchWithTimeout(longLivedUrl.toString());
    if (!res.ok) throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec d'échange de token longue durée: ${await res.text()}`);
    const { access_token, expires_in } = await res.json();
    return { accessToken: access_token, expiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : undefined };
  }

  async publish({ accessToken, externalAccountId, caption, mediaUrl }: PublishContentParams): Promise<PublishResult> {
    // Publication avec média (photo) sur la Page Facebook.
    const endpoint = mediaUrl
      ? `${GRAPH_BASE}/${externalAccountId}/photos`
      : `${GRAPH_BASE}/${externalAccountId}/feed`;

    const body = new URLSearchParams({
      access_token: accessToken,
      ...(mediaUrl ? { url: mediaUrl, caption: caption ?? '' } : { message: caption ?? '' }),
    });

    const res = await fetchWithTimeout(endpoint, { method: 'POST', body });
    if (!res.ok) {
      const errText = await res.text();
      throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec de publication: ${errText}`);
    }
    const data = await res.json();
    return { externalPostId: data.post_id ?? data.id };
  }

  // Remonte les statistiques d'une publication déjà diffusée — alimente l'AI Optimizer.
  // Les posts organiques Facebook exposent des métriques d'engagement (pas de "spend",
  // réservé aux publicités via Marketing API) : on utilise ce qui est disponible en
  // organique et on laisse `spend` non renseigné pour ce type de publication.
  async fetchInsights({ accessToken, externalPostId }: FetchInsightsParams): Promise<InsightsResult> {
    const metrics = 'post_impressions,post_engaged_users';
    const res = await fetchWithTimeout(
      `${GRAPH_BASE}/${externalPostId}/insights?metric=${metrics}&access_token=${accessToken}`,
    );
    if (!res.ok) return {}; // insights non-critiques : échec silencieux, pas de SocialApiError ici

    const data = await res.json();
    const impressions = data.data?.find((m: any) => m.name === 'post_impressions')?.values?.[0]?.value;
    const engaged = data.data?.find((m: any) => m.name === 'post_engaged_users')?.values?.[0]?.value;

    return {
      impressions: typeof impressions === 'number' ? impressions : undefined,
      clicks: typeof engaged === 'number' ? engaged : undefined, // proxy: engagement organique, pas un clic publicitaire strict
      raw: data,
    };
  }
}
