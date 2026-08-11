// Contrat commun que tout adaptateur de réseau social doit respecter.
// Miroir du pattern AiProvider côté AI Gateway : la couche métier (PublishingService)
// ne connaît jamais les spécificités d'une API tierce, seulement ce contrat.

export interface OAuthAuthorizeParams {
  // Valeur opaque insérée telle quelle dans le paramètre `state` transmis au fournisseur —
  // depuis la correction de la vulnérabilité de falsification de state, ce n'est plus
  // l'organizationId en clair mais un jeton signé (cf. OAuthStateService). Nom conservé pour
  // limiter la surface de changement dans les adaptateurs, qui n'ont pas besoin de savoir
  // que la valeur est désormais signée — ils la transmettent telle quelle.
  organizationId: string;
  redirectUri: string;
}

export interface OAuthCallbackParams {
  code: string;
  redirectUri: string;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  externalAccountId: string;
  externalAccountName?: string;
  scopes?: string;
}

export interface PublishContentParams {
  accessToken: string;
  externalAccountId: string;
  caption?: string;
  mediaUrl?: string; // image ou vidéo hébergée (Object Storage)
  linkUrl?: string;
}

export interface PublishResult {
  externalPostId: string;
}

export interface FetchInsightsParams {
  accessToken: string;
  externalPostId: string;
  // Requis par les vraies API de reporting LinkedIn (organizationalEntityShareStatistics)
  // et Google Ads (GAQL scopé au customer) — l'ID de publication seul ne suffit pas à
  // interroger les statistiques sur ces plateformes, contrairement à Meta/TikTok qui
  // n'en ont pas besoin. Toujours renseigné par l'appelant (cf. AnalyticsIngestionService,
  // qui le lit depuis SocialConnection.externalAccountId) ; les adaptateurs qui n'en ont
  // pas besoin l'ignorent simplement.
  externalAccountId: string;
}

export interface InsightsResult {
  impressions?: number;
  clicks?: number;
  spend?: number;
  // Peu de plateformes exposent ceci sans une intégration dédiée au tracking de conversion
  // (Meta Conversions API, Google Ads conversion actions) — absentes des adaptateurs actuels,
  // c'est pourquoi POST /analytics/campaigns/:id/conversions existe en complément manuel.
  conversions?: number;
  conversionValue?: number;
  raw?: unknown;
}

// Statut d'une publication dont la plateforme traite la diffusion de façon asynchrone
// (ex: TikTok Content Posting API) — permet à PublishingService de savoir s'il doit
// attendre, considérer la publication réussie, ou la marquer en échec.
export type AsyncPublishStatus = 'PROCESSING' | 'PUBLISHED' | 'FAILED';

export interface SocialAdapter {
  readonly platform: string;

  // Construit l'URL vers laquelle rediriger l'utilisateur pour démarrer le consentement OAuth.
  buildAuthorizeUrl(params: OAuthAuthorizeParams): string;

  // Échange le code d'autorisation contre un token d'accès (et de rafraîchissement si applicable).
  exchangeCodeForToken(params: OAuthCallbackParams): Promise<OAuthTokenResult>;

  // Publie un contenu sur la plateforme, retourne l'identifiant externe de la publication.
  publish(params: PublishContentParams): Promise<PublishResult>;

  // Optionnel : remonte les statistiques de performance d'une publication déjà diffusée.
  // Alimente l'AI Optimizer nocturne (Module 16). Non implémenté par tous les adaptateurs —
  // l'AnalyticsIngestionService doit vérifier sa présence avant de l'appeler.
  fetchInsights?(params: FetchInsightsParams): Promise<InsightsResult>;

  // Optionnel : rafraîchit un token d'accès expiré ou sur le point de l'être, à partir du
  // refresh token. Absent pour les plateformes à tokens longue durée sans refresh natif
  // (Meta : ré-échange proactif via exchangeCodeForToken, pas un vrai refresh_token OAuth2).
  refreshAccessToken?(refreshToken: string): Promise<OAuthTokenResult>;

  // Optionnel : interroge le statut d'une publication traitée de façon asynchrone par la
  // plateforme (ex: TikTok). Absent pour les plateformes dont publish() est déjà synchrone.
  checkPublishStatus?(accessToken: string, externalPostId: string): Promise<AsyncPublishStatus>;
}
