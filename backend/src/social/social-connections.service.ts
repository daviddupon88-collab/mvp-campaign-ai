import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCryptoService } from '../common/crypto/token-crypto.service';
import { OAuthStateService } from './oauth-state.service';
import { MetaAdapter } from './adapters/meta.adapter';
import { LinkedInAdapter } from './adapters/linkedin.adapter';
import { GoogleAdsAdapter } from './adapters/google-ads.adapter';
import { TikTokAdapter } from './adapters/tiktok.adapter';
import { SocialAdapter } from './adapters/social-adapter.interface';

// Fenêtre de sécurité avant expiration : si le token expire dans moins de ce délai,
// on le rafraîchit proactivement plutôt que d'attendre l'échec — évite qu'une publication
// échoue au milieu de son exécution à cause d'un token qui a expiré entre deux appels.
const REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class SocialConnectionsService {
  private readonly logger = new Logger(SocialConnectionsService.name);
  private readonly adapters: Record<string, SocialAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly tokenCrypto: TokenCryptoService,
    private readonly oauthState: OAuthStateService,
    metaAdapter: MetaAdapter,
    linkedInAdapter: LinkedInAdapter,
    googleAdsAdapter: GoogleAdsAdapter,
    tikTokAdapter: TikTokAdapter,
  ) {
    this.adapters = {
      META_FACEBOOK: metaAdapter,
      META_INSTAGRAM: metaAdapter, // même app Meta, même flux OAuth que Facebook
      LINKEDIN: linkedInAdapter,
      GOOGLE_ADS: googleAdsAdapter,
      TIKTOK: tikTokAdapter,
    };
  }

  private getAdapter(platform: string): SocialAdapter {
    const adapter = this.adapters[platform];
    if (!adapter) throw new BadRequestException(`Plateforme non supportée: ${platform}`);
    return adapter;
  }

  private getRedirectUri(platform: string): string {
    const baseUrl = this.config.get<string>('API_PUBLIC_URL', 'http://localhost:3001');
    return `${baseUrl}/api/social/${platform.toLowerCase()}/callback`;
  }

  // Étape 1 du flux OAuth : génère l'URL de consentement pour le fournisseur, avec un
  // state signé (jamais l'organizationId en clair — cf. OAuthStateService).
  getAuthorizeUrl(organizationId: string, platform: string): string {
    const adapter = this.getAdapter(platform);
    const signedState = this.oauthState.create(organizationId);
    return adapter.buildAuthorizeUrl({ organizationId: signedState, redirectUri: this.getRedirectUri(platform) });
  }

  // Étape 2 : reçoit le code renvoyé par le fournisseur, VÉRIFIE la signature du state
  // (lève une exception si falsifié, rejoué au-delà de 10 minutes, ou malformé) avant de
  // faire quoi que ce soit d'autre, échange contre un token, et persiste la connexion pour
  // l'organisation authentifiée par le state — jamais celle demandée en clair par l'appelant.
  // Les tokens sont chiffrés avant écriture (cf. TokenCryptoService) — jamais en clair en base.
  async handleCallback(platform: string, code: string, signedState: string) {
    const organizationId = this.oauthState.verify(signedState);
    const adapter = this.getAdapter(platform);
    const result = await adapter.exchangeCodeForToken({ code, redirectUri: this.getRedirectUri(platform) });

    return this.prisma.socialConnection.upsert({
      where: {
        organizationId_platform_externalAccountId: {
          organizationId,
          platform: platform as any,
          externalAccountId: result.externalAccountId,
        },
      },
      create: {
        organizationId,
        platform: platform as any,
        externalAccountId: result.externalAccountId,
        externalAccountName: result.externalAccountName,
        accessToken: this.tokenCrypto.encrypt(result.accessToken),
        refreshToken: result.refreshToken ? this.tokenCrypto.encrypt(result.refreshToken) : null,
        tokenExpiresAt: result.expiresAt,
        scopes: result.scopes,
        status: 'ACTIVE',
      },
      update: {
        accessToken: this.tokenCrypto.encrypt(result.accessToken),
        refreshToken: result.refreshToken ? this.tokenCrypto.encrypt(result.refreshToken) : null,
        tokenExpiresAt: result.expiresAt,
        status: 'ACTIVE',
      },
    });
  }

  async listForOrganization(organizationId: string) {
    return this.prisma.socialConnection.findMany({
      where: { organizationId },
      select: {
        id: true,
        platform: true,
        externalAccountName: true,
        status: true,
        tokenExpiresAt: true,
        createdAt: true,
      },
    });
  }

  async disconnect(organizationId: string, connectionId: string) {
    const connection = await this.prisma.socialConnection.findFirst({
      where: { id: connectionId, organizationId },
    });
    if (!connection) throw new NotFoundException('Connexion introuvable');
    return this.prisma.socialConnection.update({
      where: { id: connectionId },
      data: { status: 'REVOKED' },
    });
  }

  // Point d'accès central utilisé par PublishingService et AnalyticsIngestionService :
  // renvoie une connexion avec un accessToken DÉCHIFFRÉ et garanti valide — rafraîchi
  // proactivement si l'expiration est proche et que l'adaptateur le permet, plutôt que
  // de laisser l'appelant découvrir l'expiration au milieu d'une publication.
  async getActiveConnection(organizationId: string, connectionId: string) {
    const connection = await this.prisma.socialConnection.findFirst({
      where: { id: connectionId, organizationId, status: 'ACTIVE' },
    });
    if (!connection) throw new NotFoundException('Connexion introuvable ou inactive');

    const expiresSoon = connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS;

    if (expiresSoon) {
      const refreshed = await this.tryRefresh(connection);
      if (refreshed) return refreshed;

      // Expiration effective sans possibilité de rafraîchissement : reconnexion requise.
      if (connection.tokenExpiresAt && connection.tokenExpiresAt < new Date()) {
        await this.prisma.socialConnection.update({ where: { id: connection.id }, data: { status: 'EXPIRED' } });
        throw new BadRequestException('Le token a expiré et ne peut pas être rafraîchi automatiquement — reconnexion nécessaire');
      }
    }

    return { ...connection, accessToken: this.tokenCrypto.decrypt(connection.accessToken) };
  }

  // Tente un rafraîchissement via l'adaptateur si celui-ci le supporte. Retourne la
  // connexion mise à jour (token déchiffré prêt à l'emploi) en cas de succès, sinon null —
  // l'appelant décide alors s'il doit considérer le token comme expiré.
  private async tryRefresh(connection: {
    id: string;
    platform: string;
    refreshToken: string | null;
  }) {
    const adapter = this.getAdapter(connection.platform);
    if (!adapter.refreshAccessToken || !connection.refreshToken) return null;

    try {
      const decryptedRefreshToken = this.tokenCrypto.decrypt(connection.refreshToken);
      const result = await adapter.refreshAccessToken(decryptedRefreshToken);

      const updated = await this.prisma.socialConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: this.tokenCrypto.encrypt(result.accessToken),
          refreshToken: result.refreshToken ? this.tokenCrypto.encrypt(result.refreshToken) : connection.refreshToken,
          tokenExpiresAt: result.expiresAt,
          status: 'ACTIVE',
        },
      });
      this.logger.log(`Token rafraîchi pour la connexion ${connection.id} (${connection.platform})`);
      return { ...updated, accessToken: result.accessToken };
    } catch (error) {
      this.logger.warn(`Échec du rafraîchissement de token pour la connexion ${connection.id}: ${error}`);
      return null;
    }
  }

  // Utilisé par le cron proactif (cf. TokenRefreshService) — liste les connexions dont le
  // token expire bientôt, sans lever d'exception (contrairement à getActiveConnection, qui
  // est appelé en plein flux de publication).
  async listExpiringSoon(withinMs: number) {
    return this.prisma.socialConnection.findMany({
      where: {
        status: 'ACTIVE',
        tokenExpiresAt: { lt: new Date(Date.now() + withinMs) },
      },
    });
  }

  async refreshConnectionById(connectionId: string): Promise<boolean> {
    const connection = await this.prisma.socialConnection.findUnique({ where: { id: connectionId } });
    if (!connection) return false;
    const result = await this.tryRefresh(connection);
    return result !== null;
  }

  getAdapterFor(platform: string): SocialAdapter {
    return this.getAdapter(platform);
  }
}
