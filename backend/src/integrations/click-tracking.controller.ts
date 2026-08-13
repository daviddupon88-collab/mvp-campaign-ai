import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ClickTrackingService } from './click-tracking.service';

// Public (pas de JWT) : cette URL est celle qu'un vrai clic publicitaire atteint depuis Meta
// ou Google Ads — impossible d'exiger un header Authorization sur une redirection déclenchée
// par la plateforme publicitaire elle-même. Même mécanisme d'exemption que
// GET /invitations/:token et GET /social/:platform/callback (absence de @UseGuards).
@Controller('r')
export class ClickTrackingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clickTracking: ClickTrackingService,
  ) {}

  @Get(':publishedPostId')
  async redirect(
    @Param('publishedPostId') publishedPostId: string,
    @Query('fbclid') fbclid: string | undefined,
    @Query('gclid') gclid: string | undefined,
    @Res() res: Response,
  ) {
    const post = await this.prisma.publishedPost.findUnique({ where: { id: publishedPostId } });
    if (!post || !post.destinationUrl) {
      throw new NotFoundException('Lien de suivi introuvable ou expiré');
    }

    // Best-effort et hors du chemin critique : la redirection ne doit jamais attendre après
    // l'écriture du clic, ni échouer si elle échoue (cf. ClickTrackingService.recordClick).
    void this.clickTracking.recordClick({
      publishedPostId: post.id,
      campaignId: post.campaignId,
      organizationId: post.organizationId,
      fbclid,
      gclid,
    });

    return res.redirect(302, post.destinationUrl);
  }
}
