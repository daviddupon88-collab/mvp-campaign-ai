import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { CAMPAIGN_GENERATION_QUEUE } from './queue.module';
import { AiOrchestratorService, GenerateCampaignParams } from '../ai/ai-orchestrator/ai-orchestrator.service';
import { ModerationService, ModerationInputText, ModerationInputImage } from '../moderation/moderation.service';
import { BrandConsistencyService } from '../brand-consistency/brand-consistency.service';
import { ContentStudioService } from '../content-studio/content-studio.service';
import { AssetsService } from '../content-studio/assets.service';
import { StorageService } from '../storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

// Worker : génère le contenu de la campagne, le PERSISTE dans le Content Studio (auparavant,
// le contenu généré n'existait que le temps de la requête IA, jamais conservé au-delà —
// cf. persistGeneratedContent), puis le fait systématiquement passer par deux vérifications
// indépendantes avant de le rendre visible pour validation humaine :
//  - ModerationService (sécurité/légalité) : peut rejeter automatiquement (BLOCKED).
//  - BrandConsistencyService (qualité éditoriale) : ne bloque jamais, informe seulement.
// Ordre : génération -> persistance Content Studio -> modération + cohérence de marque
// (en parallèle) -> (BLOCKED => REJECTED) ou (sinon => READY_FOR_REVIEW). Le statut PUBLISHED
// n'est JAMAIS atteint depuis ce worker — uniquement via l'action explicite d'un humain
// habilité (cf. CampaignsController.approve + SocialController.publish).
@Processor(CAMPAIGN_GENERATION_QUEUE)
export class CampaignGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignGenerationProcessor.name);

  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly moderation: ModerationService,
    private readonly brandConsistency: BrandConsistencyService,
    private readonly contentStudio: ContentStudioService,
    private readonly assets: AssetsService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<GenerateCampaignParams>) {
    const { organizationId, campaignId } = job.data;
    this.logger.log(`Traitement du job ${job.id} — campagne ${campaignId}`);

    const results = await this.orchestrator.generateCampaign(job.data);

    await this.persistGeneratedContent(organizationId, campaignId, results);

    const texts: ModerationInputText[] = [
      { label: 'productAnalysis', text: results.productAnalysis.content },
      { label: 'strategy', text: results.strategy.content },
      // Un texte distinct par canal, désormais réellement différent d'un canal à l'autre —
      // chacun vérifié indépendamment plutôt qu'une seule vérification représentative de tous.
      ...Object.entries(results.channelContent).map(([channel, result]) => ({
        label: `copywriting_${channel}`,
        text: result.content,
      })),
    ];
    const images: ModerationInputImage[] = [{ label: 'visual', url: results.visual.content }];

    // Les deux vérifications sont indépendantes (sécurité vs qualité éditoriale) — exécutées
    // en parallèle pour ne pas doubler le temps d'attente de l'utilisateur.
    const [moderationResult, brandResult] = await Promise.all([
      this.moderation.runCampaignModeration(organizationId, campaignId, texts, images),
      this.brandConsistency.runCampaignBrandCheck(organizationId, campaignId, texts, images),
    ]);

    if (moderationResult.verdict === 'BLOCKED') {
      const blockedChecks = moderationResult.checks.filter((c) => c.status === 'BLOCKED');
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: 'REJECTED',
          moderationVerdict: 'BLOCKED',
          brandConsistencyScore: brandResult.overallScore,
          rejectionReason: `Rejet automatique (modération) : ${blockedChecks.map((c) => c.summary).join(' | ')}`,
        },
      });
      this.logger.warn(`Campagne ${campaignId} rejetée automatiquement par la modération`);
      return { ...results, moderationResult, brandResult, campaignStatus: 'REJECTED' };
    }

    // PASSED ou FLAGGED : la campagne est prête pour la validation humaine dans tous les cas —
    // le verdict de modération et le score de cohérence de marque sont simplement portés
    // à la connaissance du validateur, jamais utilisés pour approuver automatiquement.
    const campaign = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'READY_FOR_REVIEW',
        moderationVerdict: moderationResult.verdict,
        brandConsistencyScore: brandResult.overallScore,
      },
    });

    // Notifie tous les Marketing Manager+ — auparavant silencieux, il fallait consulter
    // le dashboard pour découvrir qu'une campagne attendait une validation.
    await this.notifications.notifyOrganization(organizationId, ['MARKETING_MANAGER', 'ADMIN', 'OWNER'], {
      organizationId,
      type: 'CAMPAIGN_READY_FOR_REVIEW',
      title: 'Campagne prête pour validation',
      body: `La campagne "${campaign.name}" attend votre validation.`,
      link: `/campaigns/${campaignId}`,
    });

    return { ...results, moderationResult, brandResult, campaignStatus: 'READY_FOR_REVIEW' };
  }

  // Transforme le résultat transitoire de l'AI Orchestrator en pièces de contenu durables :
  // un ContentPiece TEXT par canal sélectionné, avec le texte SPÉCIFIQUE généré pour ce canal
  // (plus un texte générique dupliqué — cf. AiOrchestratorService.generateChannelCopy), un
  // ContentPiece IMAGE pour le visuel, et un ContentPiece VIDEO si une vidéo a été générée.
  // Chaque asset généré est enregistré dans la bibliothèque de médias avec sa traçabilité
  // de génération (coût, fournisseur). targetChannels dérive directement des clés de
  // channelContent — jamais recalculée indépendamment ici, pour rester en phase avec ce que
  // l'Orchestrator a réellement généré (cf. commentaire dans AiOrchestratorService).
  private async persistGeneratedContent(
    organizationId: string,
    campaignId: string,
    results: Awaited<ReturnType<AiOrchestratorService['generateCampaign']>>,
  ) {
    const targetChannels = Object.keys(results.channelContent);

    for (const [channel, channelResult] of Object.entries(results.channelContent)) {
      await this.contentStudio.createPiece({
        organizationId,
        campaignId,
        channel,
        type: 'TEXT',
        body: channelResult.content,
      });
    }

    const visualAsset = await this.registerGeneratedVisual(organizationId, 'IMAGE', results.visual.content, results.visual.generationId, 'visual');
    await this.contentStudio.createPiece({
      organizationId,
      campaignId,
      channel: targetChannels[0],
      type: 'IMAGE',
      assetId: visualAsset.id,
    });

    if (results.video) {
      const videoAsset = await this.registerGeneratedVisual(organizationId, 'VIDEO', results.video.content, results.video.generationId, 'video');
      await this.contentStudio.createPiece({
        organizationId,
        campaignId,
        channel: targetChannels.find((c) => ['tiktok', 'instagram'].includes(c)) ?? targetChannels[0],
        type: 'VIDEO',
        assetId: videoAsset.id,
      });
    }
  }

  // Les fournisseurs d'IA (OpenAI, Flux, Ideogram, Google Veo) renvoient tous des URLs
  // TEMPORAIRES pour les images/vidéos générées (généralement quelques heures) — sans
  // re-hébergement, un visuel de campagne casserait silencieusement une fois cette fenêtre
  // passée. On tente donc systématiquement de rapatrier le fichier vers notre propre
  // stockage permanent ; en cas d'échec (timeout, contenu déjà expiré), on se rabat sur
  // l'URL d'origine plutôt que de faire échouer toute la génération de campagne pour un
  // problème de re-hébergement — mieux vaut un visuel qui expirera dans quelques heures
  // qu'une campagne entièrement bloquée.
  private async registerGeneratedVisual(
    organizationId: string,
    type: 'IMAGE' | 'VIDEO',
    providerUrl: string,
    generationId: string | undefined,
    fileNameHint: string,
  ) {
    const rehosted = await this.storage.uploadFromUrl(organizationId, providerUrl, fileNameHint);

    return this.assets.register({
      organizationId,
      type,
      source: 'GENERATED',
      url: rehosted?.url ?? providerUrl,
      storageKey: rehosted?.key,
      generationId,
    });
  }
}
