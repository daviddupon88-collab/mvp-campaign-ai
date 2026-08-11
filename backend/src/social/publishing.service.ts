import { Injectable, Logger, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SocialConnectionsService } from './social-connections.service';
import { EntitlementsService } from '../plans/entitlements.service';
import { BrandService } from '../brand/brand.service';
import { withRetry } from './retry.util';
import { SocialApiError } from './adapters/social-api-error';

export interface PublishRequest {
  organizationId: string;
  campaignId: string;
  socialConnectionId: string;
  caption?: string;
  mediaUrl?: string;
  linkUrl?: string;
  // Quelle créative précise est diffusée — renseigné quand la publication provient du
  // Content Studio (calendrier, ou sélection explicite d'une version) ; sans lui, l'analytics
  // ne peut pas redescendre au niveau créatif pour cette publication (cf. ContentMetric).
  contentVersionId?: string;
}

// Module 14 — Social Publishing Hub : diffuse un contenu de campagne sur un réseau connecté,
// et journalise systématiquement le résultat (succès ou échec) dans PublishedPost.
//
// GARDE-FOU (verrou final) : aucune publication n'est possible tant que la campagne n'a
// pas explicitement le statut APPROVED, ni si l'abonnement de l'organisation n'est plus actif.
//
// IDEMPOTENCE : la contrainte unique (campaignId, socialConnectionId) sur PublishedPost
// garantit qu'un appel répété (retry client, double clic, nouvelle tentative après timeout)
// ne publie jamais deux fois sur la plateforme réelle — cf. publishToChannel().
@Injectable()
export class PublishingService {
  private readonly logger = new Logger(PublishingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectionsService: SocialConnectionsService,
    private readonly entitlements: EntitlementsService,
    private readonly brandService: BrandService,
  ) {}

  private async assertCampaignApproved(organizationId: string, campaignId: string) {
    await this.entitlements.assertActiveSubscription(organizationId);

    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, organizationId } });
    if (!campaign) throw new NotFoundException('Campagne introuvable');
    if (campaign.status !== 'APPROVED') {
      throw new ForbiddenException(
        `Publication refusée : la campagne doit être au statut "APPROVED" (statut actuel : "${campaign.status}"). ` +
          `Une validation humaine explicite est requise avant toute diffusion.`,
      );
    }
    return campaign;
  }

  async publishToChannel(req: PublishRequest) {
    // Idempotence : si une publication existe déjà pour ce couple (campagne, canal)...
    const existing = await this.prisma.publishedPost.findUnique({
      where: { campaignId_socialConnectionId: { campaignId: req.campaignId, socialConnectionId: req.socialConnectionId } },
    });

    // ... et qu'elle a déjà réussi, on la renvoie telle quelle SANS rappeler la plateforme —
    // c'est la garantie concrète qu'aucun doublon ne peut être créé par un retry.
    if (existing?.status === 'PUBLISHED') {
      this.logger.log(`Publication déjà existante pour campagne=${req.campaignId} canal=${req.socialConnectionId}, aucun appel réémis`);
      return existing;
    }

    const connection = await this.connectionsService.getActiveConnection(req.organizationId, req.socialConnectionId);
    const adapter = this.connectionsService.getAdapterFor(connection.platform);

    // Plafonds dédiés (essai gratuit) : quota de publications réelles + restriction aux
    // plateformes incluses dans le plan (ex: Meta/LinkedIn pendant l'essai, sans Google
    // Ads/TikTok). No-op sur les plans payants. Vérifiés ici, après la sortie anticipée
    // d'idempotence ci-dessus : rejouer une publication déjà réussie ne doit jamais
    // consommer une seconde fois le quota.
    await this.entitlements.assertSocialPostQuotaAvailable(req.organizationId);
    await this.entitlements.assertChannelsAllowed(req.organizationId, [connection.platform]);

    // PENDING ou FAILED : on retente sur la MÊME ligne (upsert), jamais une nouvelle —
    // c'est ce qui matérialise la contrainte d'unicité au niveau applicatif.
    const record = await this.prisma.publishedPost.upsert({
      where: { campaignId_socialConnectionId: { campaignId: req.campaignId, socialConnectionId: req.socialConnectionId } },
      create: {
        organizationId: req.organizationId,
        campaignId: req.campaignId,
        socialConnectionId: connection.id,
        platform: connection.platform,
        status: 'PENDING',
        attemptCount: 1,
        contentVersionId: req.contentVersionId,
      },
      update: { status: 'PENDING', attemptCount: { increment: 1 }, errorMessage: null, contentVersionId: req.contentVersionId },
    });

    try {
      const result = await withRetry(
        () =>
          adapter.publish({
            accessToken: connection.accessToken,
            externalAccountId: connection.externalAccountId,
            caption: req.caption,
            mediaUrl: req.mediaUrl,
            linkUrl: req.linkUrl,
          }),
        { label: `publish ${connection.platform}`, maxAttempts: 3 },
      );

      // Plateformes à traitement asynchrone (TikTok) : publish() renvoie un ID de tâche,
      // pas encore une publication confirmée — on interroge le statut avant de conclure.
      const finalStatus = adapter.checkPublishStatus
        ? await this.pollAsyncStatus(adapter, connection.accessToken, result.externalPostId)
        : 'PUBLISHED';

      if (finalStatus === 'FAILED') {
        throw new SocialApiError('La plateforme a rejeté la publication après traitement asynchrone', {
          platform: connection.platform,
          retryable: false,
        });
      }

      return await this.prisma.publishedPost.update({
        where: { id: record.id },
        data: { status: 'PUBLISHED', externalPostId: result.externalPostId, publishedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(`Échec de publication (campagne ${req.campaignId}, ${connection.platform}): ${error}`);
      return this.prisma.publishedPost.update({
        where: { id: record.id },
        data: { status: 'FAILED', errorMessage: String(error) },
      });
    }
  }

  // Interroge le statut d'une publication asynchrone à intervalles courts, avec un nombre
  // borné de tentatives — évite de bloquer indéfiniment la requête HTTP de publication si
  // la plateforme met un temps anormal à traiter (dans ce cas, la publication reste PENDING
  // côté Campaign-ai et devra être vérifiée manuellement ; pas de file d'attente dédiée à
  // ce polling long terme dans cette version, cf. roadmap).
  private async pollAsyncStatus(
    adapter: { checkPublishStatus?: (token: string, id: string) => Promise<'PROCESSING' | 'PUBLISHED' | 'FAILED'> },
    accessToken: string,
    externalPostId: string,
    maxAttempts = 5,
  ): Promise<'PROCESSING' | 'PUBLISHED' | 'FAILED'> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const status = await adapter.checkPublishStatus!(accessToken, externalPostId);
      if (status !== 'PROCESSING') return status;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
    this.logger.warn(`Statut de publication toujours PROCESSING après ${maxAttempts} vérifications (${externalPostId})`);
    return 'PROCESSING';
  }

  // Diffuse sur plusieurs connexions en parallèle. Vérifie le statut APPROVED une seule fois
  // en amont, puis fait passer la campagne à PUBLISHED si au moins une diffusion a réussi —
  // un échec partiel ne doit pas bloquer les canaux qui ont fonctionné.
  async publishToMultipleChannels(requests: PublishRequest[]) {
    if (requests.length === 0) throw new BadRequestException('Aucun canal sélectionné pour la publication');

    const { organizationId, campaignId } = requests[0];
    await this.assertCampaignApproved(organizationId, campaignId);

    const results = await Promise.all(requests.map((r) => this.publishToChannel(r)));

    const hasSuccess = results.some((r) => r.status === 'PUBLISHED');
    if (hasSuccess) {
      await this.prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PUBLISHED' } });

      // Brand Brain : mémorise cette campagne comme apprentissage — c'est ce qui permet
      // à une future génération de savoir "on a déjà fait une campagne avec cet objectif,
      // sur ces canaux" plutôt que de repartir de zéro à chaque fois.
      const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
      if (campaign) {
        const channels = Array.isArray(campaign.channels) ? (campaign.channels as string[]).join(', ') : 'non précisés';
        await this.brandService.logMemory(
          organizationId,
          'CAMPAIGN_LEARNING',
          `Campagne "${campaign.name}" publiée sur ${channels}, objectif : ${campaign.objective ?? 'non précisé'}`,
          campaignId,
        );
      }
    }

    return results;
  }

  async listPublicationsForCampaign(organizationId: string, campaignId: string) {
    return this.prisma.publishedPost.findMany({
      where: { organizationId, campaignId },
      include: { socialConnection: { select: { platform: true, externalAccountName: true } } },
    });
  }
}
