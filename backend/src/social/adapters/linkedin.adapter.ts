import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SocialAdapter,
  OAuthAuthorizeParams,
  OAuthCallbackParams,
  OAuthTokenResult,
  PublishContentParams,
  PublishResult,
} from './social-adapter.interface';
import { SocialApiError } from './social-api-error';

const PLATFORM = 'LINKEDIN';

// Adaptateur LinkedIn : publication sur une Page entreprise via l'API "Share on LinkedIn".
// Prérequis : app LinkedIn avec le produit "Marketing Developer Platform" approuvé
// (délai de validation LinkedIn généralement de plusieurs jours). Ce produit donne accès
// à un vrai refresh_token (contrairement à l'accès de base LinkedIn), valable ~1 an,
// permettant de renouveler l'access_token (60 jours) sans repasser par un consentement.
@Injectable()
export class LinkedInAdapter implements SocialAdapter {
  readonly platform = PLATFORM;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('LINKEDIN_CLIENT_ID', '');
    this.clientSecret = this.config.get<string>('LINKEDIN_CLIENT_SECRET', '');
  }

  buildAuthorizeUrl({ organizationId, redirectUri }: OAuthAuthorizeParams): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state: organizationId,
      scope: 'w_member_social,r_organization_social,w_organization_social,rw_organization_admin',
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  async exchangeCodeForToken({ code, redirectUri }: OAuthCallbackParams): Promise<OAuthTokenResult> {
    const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `OAuth error: ${await res.text()}`);
    const data = await res.json();

    // Récupère l'organisation (Page entreprise) administrée par l'utilisateur.
    const orgRes = await fetch(
      'https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR',
      { headers: { Authorization: `Bearer ${data.access_token}` } },
    );
    if (!orgRes.ok) throw SocialApiError.fromHttpStatus(PLATFORM, orgRes.status, `Échec de récupération de l'organisation: ${await orgRes.text()}`);
    const orgData = await orgRes.json();
    const orgUrn = orgData.elements?.[0]?.organizationalTarget;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token, // présent uniquement si le produit MDP est approuvé
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      externalAccountId: orgUrn ?? 'urn:li:person:me',
      externalAccountName: 'Page LinkedIn connectée',
      scopes: 'w_organization_social',
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokenResult> {
    const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec du rafraîchissement: ${await res.text()}`);
    const data = await res.json();

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken, // LinkedIn peut ou non en renvoyer un nouveau
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      externalAccountId: '', // non modifié par un refresh — SocialConnectionsService conserve l'existant
    };
  }

  async publish({ accessToken, externalAccountId, caption, linkUrl }: PublishContentParams): Promise<PublishResult> {
    const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({
        author: externalAccountId,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text: caption ?? '' },
            shareMediaCategory: linkUrl ? 'ARTICLE' : 'NONE',
            ...(linkUrl ? { media: [{ status: 'READY', originalUrl: linkUrl }] } : {}),
          },
        },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw SocialApiError.fromHttpStatus(PLATFORM, res.status, `Échec de publication: ${errText}`);
    }
    const postId = res.headers.get('x-restli-id') ?? 'unknown';
    return { externalPostId: postId };
  }
}
