import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

const PLATFORM = 'GOOGLE_ADS';
const API_VERSION = 'v16';
const API_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

// Adaptateur Google Ads : différent des autres par nature — il n'y a pas de "post organique",
// mais une hiérarchie CampaignBudget > Campaign > AdGroup > AdGroupAd à créer via des appels
// REST "mutate" séquentiels (utilise l'API REST directement plutôt que le SDK gRPC officiel,
// pour rester cohérent avec les autres adaptateurs de ce module — mêmes dépendances, même
// gestion d'erreur/retry).
//
// SÉCURITÉ PAR DÉFAUT : la campagne est créée au statut PAUSED, jamais ENABLED directement —
// une campagne publicitaire engage un budget réel ; l'activation doit être un geste humain
// explicite (extension naturelle : bouton "Activer" côté frontend une fois la campagne créée
// et vérifiée), pas une conséquence automatique de l'approbation éditoriale du contenu.
@Injectable()
export class GoogleAdsAdapter implements SocialAdapter {
  readonly platform = PLATFORM;
  private readonly logger = new Logger(GoogleAdsAdapter.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly developerToken: string;
  private readonly loginCustomerId: string;

  constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('GOOGLE_ADS_CLIENT_ID', '');
    this.clientSecret = this.config.get<string>('GOOGLE_ADS_CLIENT_SECRET', '');
    this.developerToken = this.config.get<string>('GOOGLE_ADS_DEVELOPER_TOKEN', '');
    this.loginCustomerId = this.config.get<string>('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '');
  }

  buildAuthorizeUrl({ organizationId, redirectUri }: OAuthAuthorizeParams): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline', // nécessaire pour obtenir un refresh_token
      prompt: 'consent',
      state: organizationId,
      scope: 'https://www.googleapis.com/auth/adwords',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForToken({ code, redirectUri }: OAuthCallbackParams): Promise<OAuthTokenResult> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `OAuth error: ${await res.text()}`);
    const data = await res.json();

    // Le compte Google Ads (customer_id) doit être sélectionné séparément après connexion
    // (un utilisateur peut administrer plusieurs comptes clients) — à gérer côté UI, en
    // listant les comptes accessibles via GET /v16/customers:listAccessibleCustomers.
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      externalAccountId: 'pending-customer-id-selection',
      scopes: 'https://www.googleapis.com/auth/adwords',
    };
  }

  // Google Ads utilise le refresh_token OAuth2 standard — expiration de l'access_token
  // toujours 1h, refresh_token valide indéfiniment sauf révocation explicite.
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokenResult> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec du rafraîchissement: ${await res.text()}`);
    const data = await res.json();

    return {
      accessToken: data.access_token,
      refreshToken, // Google ne renvoie pas de nouveau refresh_token sur un refresh classique
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      externalAccountId: '',
    };
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': this.developerToken,
      ...(this.loginCustomerId ? { 'login-customer-id': this.loginCustomerId } : {}),
      'Content-Type': 'application/json',
    };
  }

  private async mutate(accessToken: string, customerId: string, path: string, body: unknown): Promise<any> {
    const res = await fetch(`${API_BASE}/customers/${customerId}/${path}`, {
      method: 'POST',
      headers: this.headers(accessToken),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec mutate (${path}): ${errText}`);
    }
    return res.json();
  }

  // Enchaîne les 4 mutations nécessaires à une annonce texte minimale (recherche) :
  // budget quotidien -> campagne (PAUSED) -> groupe d'annonces -> annonce responsive.
  // Simplification assumée pour cette version : pas de mots-clés ni de ciblage géographique/
  // démographique configurés ici (la campagne PAUSED laisse le temps de les paramétrer
  // manuellement dans Google Ads avant activation) — cf. commentaire de classe.
  async publish({ accessToken, externalAccountId: customerId, caption, linkUrl }: PublishContentParams): Promise<PublishResult> {
    if (!this.developerToken) {
      throw new SocialApiError('GOOGLE_ADS_DEVELOPER_TOKEN manquant — publication impossible', { platform: PLATFORM, retryable: false });
    }

    const budgetResourceName = `customers/${customerId}/campaignBudgets/${Date.now()}`;
    const budgetRes = await this.mutate(accessToken, customerId, 'campaignBudgets:mutate', {
      operations: [{ create: { resourceName: budgetResourceName, amountMicros: 5_000_000, deliveryMethod: 'STANDARD' } }],
    });
    const budgetName = budgetRes.results[0].resourceName;

    const campaignRes = await this.mutate(accessToken, customerId, 'campaigns:mutate', {
      operations: [
        {
          create: {
            name: `Campaign-ai — ${new Date().toISOString()}`,
            status: 'PAUSED', // jamais ENABLED automatiquement — cf. commentaire de classe
            advertisingChannelType: 'SEARCH',
            campaignBudget: budgetName,
            manualCpc: {},
          },
        },
      ],
    });
    const campaignName = campaignRes.results[0].resourceName;

    const adGroupRes = await this.mutate(accessToken, customerId, 'adGroups:mutate', {
      operations: [{ create: { name: 'Ad Group principal', campaign: campaignName, status: 'ENABLED', type: 'SEARCH_STANDARD' } }],
    });
    const adGroupName = adGroupRes.results[0].resourceName;

    const adRes = await this.mutate(accessToken, customerId, 'adGroupAds:mutate', {
      operations: [
        {
          create: {
            adGroup: adGroupName,
            status: 'PAUSED',
            ad: {
              finalUrls: [linkUrl ?? 'https://example.com'],
              responsiveSearchAd: {
                headlines: [{ text: (caption ?? 'Découvrez notre offre').slice(0, 30) }],
                descriptions: [{ text: (caption ?? '').slice(0, 90) || 'Description générée par Campaign-ai' }],
              },
            },
          },
        },
      ],
    });

    return { externalPostId: adRes.results[0].resourceName };
  }

  // GAQL scopé au customer (externalAccountId) — un ad_group_ad n'est interrogeable que dans
  // le contexte du compte client qui le possède, contrairement aux plateformes organiques.
  // Les champs int64 (impressions, clicks, costMicros...) sont sérialisés en string par l'API
  // REST Google Ads (convention proto3 JSON) — d'où le Number(...) systématique.
  async fetchInsights({ accessToken, externalPostId, externalAccountId: customerId }: FetchInsightsParams): Promise<InsightsResult> {
    if (!this.developerToken) return {};

    const query = `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM ad_group_ad WHERE ad_group_ad.resource_name = '${externalPostId}'`;

    const res = await fetch(`${API_BASE}/customers/${customerId}/googleAds:search`, {
      method: 'POST',
      headers: this.headers(accessToken),
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return {}; // insights non-critiques : échec silencieux, pas de SocialApiError ici

    const data = await res.json();
    const metrics = data.results?.[0]?.metrics;
    if (!metrics) return {};

    return {
      impressions: metrics.impressions !== undefined ? Number(metrics.impressions) : undefined,
      clicks: metrics.clicks !== undefined ? Number(metrics.clicks) : undefined,
      spend: metrics.costMicros !== undefined ? Number(metrics.costMicros) / 1_000_000 : undefined,
      conversions: metrics.conversions !== undefined ? Number(metrics.conversions) : undefined,
      conversionValue: metrics.conversionsValue !== undefined ? Number(metrics.conversionsValue) : undefined,
      raw: data,
    };
  }
}
