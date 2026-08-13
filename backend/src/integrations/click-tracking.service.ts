import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Fenêtre d'attribution du clic le plus récent utilisé pour rattacher une conversion —
// aligné sur la fenêtre par défaut de Meta (7 jours). Non configurable dans cette version.
const ATTRIBUTION_WINDOW_DAYS = 7;

@Injectable()
export class ClickTrackingService {
  private readonly logger = new Logger(ClickTrackingService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Best-effort, comme AuditService : un incident DB au moment d'un clic publicitaire réel
  // ne doit jamais empêcher la redirection vers la destination — perdre un clic à tracer est
  // regrettable, perdre le clic lui-même (l'utilisateur bloqué sur une erreur) est pire.
  async recordClick(params: { publishedPostId: string; campaignId: string; organizationId: string; fbclid?: string; gclid?: string }): Promise<void> {
    try {
      await this.prisma.trackedClick.create({
        data: {
          publishedPostId: params.publishedPostId,
          campaignId: params.campaignId,
          organizationId: params.organizationId,
          fbclid: params.fbclid,
          gclid: params.gclid,
        },
      });
    } catch (error) {
      this.logger.error(`Échec d'enregistrement du clic (post ${params.publishedPostId}): ${error}`);
    }
  }

  async findMostRecentClickWithFbclid(campaignId: string) {
    const since = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return this.prisma.trackedClick.findFirst({
      where: { campaignId, fbclid: { not: null }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
