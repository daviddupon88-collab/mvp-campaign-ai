import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SocialConnectionsService } from './social-connections.service';
import { PublishingService } from './publishing.service';
import { PublishCampaignDto } from './dto/publish.dto';

@Controller('social')
export class SocialController {
  constructor(
    private readonly connectionsService: SocialConnectionsService,
    private readonly publishingService: PublishingService,
  ) {}

  // Liste les connexions actives de l'organisation courante.
  @Get('connections')
  @UseGuards(JwtAuthGuard)
  listConnections(@CurrentUser() user: { organizationId: string }) {
    return this.connectionsService.listForOrganization(user.organizationId);
  }

  // Démarre le flux OAuth : authentifié, car il faut savoir pour quelle organisation
  // on connecte le compte. Le state transmis au fournisseur est désormais un jeton SIGNÉ
  // (cf. OAuthStateService) — jamais l'organizationId en clair, pour empêcher qu'un state
  // forgé ne lie un compte tiers à une organisation qui n'est pas la sienne.
  @Get(':platform/authorize')
  @UseGuards(JwtAuthGuard)
  authorize(
    @CurrentUser() user: { organizationId: string },
    @Param('platform') platform: string,
    @Res() res: Response,
  ) {
    const url = this.connectionsService.getAuthorizeUrl(user.organizationId, platform.toUpperCase());
    return res.redirect(url);
  }

  // Callback public : appelé directement par le navigateur après consentement sur la
  // plateforme tierce (pas de header Authorization possible ici). La signature du state
  // est vérifiée dans handleCallback AVANT tout autre traitement — un state invalide,
  // expiré ou falsifié lève une exception et n'atteint jamais l'échange de code.
  @Get(':platform/callback')
  async callback(
    @Param('platform') platform: string,
    @Query('code') code: string,
    @Query('state') signedState: string,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    try {
      await this.connectionsService.handleCallback(platform.toUpperCase(), code, signedState);
      return res.redirect(`${frontendUrl}/settings/connections?status=success&platform=${platform}`);
    } catch (error) {
      return res.redirect(`${frontendUrl}/settings/connections?status=error&platform=${platform}`);
    }
  }

  @Delete('connections/:id')
  @UseGuards(JwtAuthGuard)
  disconnect(@CurrentUser() user: { organizationId: string }, @Param('id') id: string) {
    return this.connectionsService.disconnect(user.organizationId, id);
  }

  // Publie une campagne sur un ou plusieurs canaux connectés.
  @Post('campaigns/:campaignId/publish')
  @UseGuards(JwtAuthGuard)
  publish(
    @CurrentUser() user: { organizationId: string },
    @Param('campaignId') campaignId: string,
    @Body() dto: PublishCampaignDto,
  ) {
    const requests = dto.targets.map((t) => ({
      organizationId: user.organizationId,
      campaignId,
      socialConnectionId: t.socialConnectionId,
      caption: t.caption,
      mediaUrl: t.mediaUrl,
      linkUrl: t.linkUrl,
      contentVersionId: t.contentVersionId,
    }));
    return this.publishingService.publishToMultipleChannels(requests);
  }

  @Get('campaigns/:campaignId/publications')
  @UseGuards(JwtAuthGuard)
  listPublications(@CurrentUser() user: { organizationId: string }, @Param('campaignId') campaignId: string) {
    return this.publishingService.listPublicationsForCampaign(user.organizationId, campaignId);
  }
}
