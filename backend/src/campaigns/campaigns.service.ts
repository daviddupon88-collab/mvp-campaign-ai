import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CAMPAIGN_GENERATION_QUEUE } from '../queue/queue.module';
import { CreateCampaignDto } from './dto/campaign.dto';
import { RejectCampaignDto } from './dto/approval.dto';
import { CampaignTemplatesService } from '../campaign-templates/campaign-templates.service';
import { EntitlementsService } from '../plans/entitlements.service';
import { mapChannelSlugsToPlatforms } from '../plans/plan-catalog';

export interface ApprovalActor {
  userId: string;
  email: string;
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(CAMPAIGN_GENERATION_QUEUE) private readonly generationQueue: Queue,
    private readonly templatesService: CampaignTemplatesService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // Isolation multi-tenant systématique : toute requête est scopée par organizationId.
  async list(organizationId: string) {
    return this.prisma.campaign.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(organizationId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
      include: {
        contentPieces: { include: { currentVersion: { include: { asset: true } } } },
        generations: true,
        moderationChecks: true,
        brandConsistencyChecks: true,
        metrics: { orderBy: { createdAt: 'desc' }, take: 10 },
        optimizationRecommendations: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!campaign) throw new NotFoundException('Campagne introuvable');
    return campaign;
  }

  // Crée la campagne en base (status IN_PROGRESS) puis empile un job asynchrone
  // pour lancer l'orchestration IA — l'API répond sans attendre la génération.
  // Le statut suivant n'est jamais PUBLISHED directement : le worker fait passer
  // la campagne par READY_FOR_REVIEW (ou REJECTED si la modération bloque).
  // Si dto.templateId est renseigné (Module 18), les champs non fournis par l'utilisateur
  // sont complétés par les valeurs par défaut du template, et l'Orchestrator reçoit ses
  // indications (ton, angle d'analyse, archétype de persona) pour guider la génération.
  async create(organizationId: string, dto: CreateCampaignDto) {
    // "Une photo suffit" (page d'accueil) : la description texte devient optionnelle dès
    // lors qu'une photo est fournie — mais il faut au moins l'un des deux, sans quoi
    // l'Orchestrator n'a rigoureusement rien à analyser.
    if (!dto.productDescription?.trim() && !dto.productImageAssetId) {
      throw new BadRequestException('Une description du produit ou une photo est requise pour générer une campagne.');
    }
    const productImageUrl = await this.resolveProductImageUrl(organizationId, dto.productImageAssetId);

    // Garde-fou SaaS : aucune création de campagne ne doit contourner le plan souscrit.
    // Ordre volontaire : d'abord l'abonnement (le plus bloquant), puis les quotas fins —
    // pas la peine de calculer le reste si l'organisation n'a même pas d'accès actif.
    await this.entitlements.assertActiveSubscription(organizationId);
    await this.entitlements.assertActiveCampaignAvailable(organizationId);
    await this.entitlements.assertCreditsAvailable(organizationId);

    let objective = dto.objective;
    let channels = dto.channels ?? [];
    let templateHints: { toneHint?: string; analysisAngle?: string; personaArchetype?: string; ctaStyle?: string } | undefined;

    if (dto.templateId) {
      const template = await this.templatesService.getById(organizationId, dto.templateId);
      objective = objective || template.defaultObjective || '';
      channels = channels.length > 0 ? channels : ((template.defaultChannels as string[] | null) ?? []);
      templateHints = {
        toneHint: template.toneHint ?? undefined,
        ...(template.structureHint as Record<string, string> | null),
      };
    }

    if (channels.length > 0) {
      await this.entitlements.assertChannelAvailable(organizationId, channels.length);

      // Restriction PAR PLATEFORME (ex: essai limité à Meta/LinkedIn, cf.
      // PlanDefinition.allowedChannels) : `channels` utilise un vocabulaire de slugs
      // internes ('facebook','tiktok'...) pour le ciblage du contenu généré, distinct de
      // l'enum SocialPlatform ('META_FACEBOOK'...) utilisé par les connexions OAuth réelles
      // — mapChannelSlugsToPlatforms() fait le pont entre les deux. La vérification reste
      // AUSSI faite dans PublishingService.publishToChannel() au moment de la diffusion
      // réelle (seul moment où un canal non autorisé aurait un coût ou un risque réel) :
      // ce contrôle-ci est un avertissement précoce, pas un remplacement, pour qu'un compte
      // en essai découvre la restriction dès le wizard plutôt qu'après avoir généré du
      // contenu pour un canal qu'il ne pourra jamais publier.
      const platforms = mapChannelSlugsToPlatforms(channels);
      if (platforms.length > 0) {
        await this.entitlements.assertChannelsAllowed(organizationId, platforms);
      }
    }

    const campaign = await this.prisma.campaign.create({
      data: {
        organizationId,
        name: dto.name,
        objective,
        budget: dto.budget,
        channels,
        templateId: dto.templateId,
        productImageUrl,
        status: 'IN_PROGRESS',
      },
    });

    if (dto.templateId) await this.templatesService.incrementUsage(dto.templateId);

    await this.generationQueue.add('generate', {
      organizationId,
      campaignId: campaign.id,
      productDescription: dto.productDescription,
      productImageUrl,
      objective,
      channels,
      templateHints,
    });

    return campaign;
  }

  // Résout un assetId (fourni par le frontend après un vrai upload via POST /assets/upload)
  // en URL réelle, en vérifiant au passage qu'il appartient bien à l'organisation appelante
  // et qu'il s'agit d'une image — jamais une URL externe arbitraire acceptée telle quelle
  // (contrairement à un simple champ texte, ceci force à passer par notre pipeline de
  // stockage contrôlé avant qu'une image ne soit soumise à l'analyse IA).
  private async resolveProductImageUrl(organizationId: string, assetId: string | undefined): Promise<string | undefined> {
    if (!assetId) return undefined;
    const asset = await this.prisma.asset.findFirst({ where: { id: assetId, organizationId, type: 'IMAGE' } });
    if (!asset) throw new NotFoundException('Photo produit introuvable');
    return asset.url;
  }

  // Validation humaine obligatoire (garde-fou n°1) : seul un rôle MARKETING_MANAGER
  // ou supérieur peut approuver (appliqué via @Roles sur le controller). Une campagne
  // ne peut être approuvée que depuis READY_FOR_REVIEW — jamais depuis DRAFT ou REJECTED
  // directement, pour forcer un passage par la génération + modération à chaque fois.
  async approve(organizationId: string, campaignId: string, actor: ApprovalActor) {
    const campaign = await this.getById(organizationId, campaignId);

    if (campaign.status !== 'READY_FOR_REVIEW') {
      throw new BadRequestException(
        `Impossible d'approuver une campagne au statut "${campaign.status}" — seule une campagne "READY_FOR_REVIEW" peut être approuvée`,
      );
    }
    if (campaign.moderationVerdict === 'BLOCKED') {
      // Filet de sécurité : ne devrait jamais arriver puisque le worker rejette
      // automatiquement en cas de BLOCKED, mais on refuse explicitement quand même.
      throw new ForbiddenException('Cette campagne a été bloquée par la modération automatique et ne peut pas être approuvée');
    }

    return this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'APPROVED',
        approvedByUserId: actor.userId,
        approvedByEmail: actor.email,
        approvedAt: new Date(),
        rejectionReason: null,
      },
    });
  }

  // Rejet humain explicite (distinct du rejet automatique par modération) : un validateur
  // peut refuser une campagne pour des raisons éditoriales même si la modération l'a laissée passer.
  async reject(organizationId: string, campaignId: string, actor: ApprovalActor, dto: RejectCampaignDto) {
    const campaign = await this.getById(organizationId, campaignId);

    if (!['READY_FOR_REVIEW', 'APPROVED'].includes(campaign.status)) {
      throw new BadRequestException(`Impossible de rejeter une campagne au statut "${campaign.status}"`);
    }

    return this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'REJECTED',
        rejectionReason: `Rejet manuel par ${actor.email} : ${dto.reason}`,
        approvedByUserId: null,
        approvedByEmail: null,
        approvedAt: null,
      },
    });
  }

  // Repasse une campagne rejetée en génération (ex: après correction du produit/objectif) —
  // évite de devoir recréer une campagne de zéro après un rejet.
  async regenerate(organizationId: string, campaignId: string, dto: CreateCampaignDto) {
    const campaign = await this.getById(organizationId, campaignId);
    if (campaign.status !== 'REJECTED') {
      throw new BadRequestException('Seule une campagne rejetée peut être régénérée');
    }
    await this.entitlements.assertActiveSubscription(organizationId);
    await this.entitlements.assertCreditsAvailable(organizationId);

    if (dto.channels && dto.channels.length > 0) {
      const platforms = mapChannelSlugsToPlatforms(dto.channels);
      if (platforms.length > 0) {
        await this.entitlements.assertChannelsAllowed(organizationId, platforms);
      }
    }

    // Une nouvelle photo remplace l'ancienne si fournie ; sinon la photo déjà enregistrée
    // sur la campagne (le cas échéant) est réutilisée telle quelle pour la régénération.
    const productImageUrl = dto.productImageAssetId
      ? await this.resolveProductImageUrl(organizationId, dto.productImageAssetId)
      : campaign.productImageUrl ?? undefined;

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'IN_PROGRESS',
        moderationVerdict: null,
        rejectionReason: null,
        channels: dto.channels ?? campaign.channels ?? undefined,
        productImageUrl,
      },
    });

    await this.generationQueue.add('generate', {
      organizationId,
      campaignId,
      productDescription: dto.productDescription ?? undefined,
      productImageUrl,
      objective: dto.objective ?? campaign.objective,
      channels: dto.channels ?? (campaign.channels as string[] | null) ?? [],
    });

    return this.getById(organizationId, campaignId);
  }
}
