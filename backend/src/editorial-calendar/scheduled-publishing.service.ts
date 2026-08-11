import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EditorialCalendarService } from './editorial-calendar.service';
import { PublishingService } from '../social/publishing.service';

// Referme la boucle du calendrier éditorial : une entrée planifiée ne publie jamais
// "toute seule" en contournant les garde-fous — elle appelle PublishingService comme le
// ferait un humain cliquant sur "Publier", donc soumise à la même vérification du statut
// APPROVED de la campagne et à la même idempotence.
@Injectable()
export class ScheduledPublishingService {
  private readonly logger = new Logger(ScheduledPublishingService.name);

  constructor(
    private readonly calendarService: EditorialCalendarService,
    private readonly publishingService: PublishingService,
    private readonly prisma: PrismaService,
  ) {}

  // Toutes les 5 minutes : granularité suffisante pour un calendrier éditorial (pas un
  // système de trading), sans solliciter excessivement la base entre deux vérifications.
  @Cron(CronExpression.EVERY_5_MINUTES)
  async publishDueEntries() {
    const due = await this.calendarService.listDue();
    if (due.length === 0) return;

    this.logger.log(`${due.length} entrée(s) de calendrier à traiter`);

    for (const entry of due) {
      try {
        const piece = await this.prisma.contentPiece.findUnique({
          where: { id: entry.contentPieceId },
          include: { currentVersion: { include: { asset: true } } },
        });

        await this.publishingService.publishToChannel({
          organizationId: entry.organizationId,
          campaignId: entry.campaignId,
          socialConnectionId: entry.socialConnectionId,
          caption: piece?.currentVersion?.body ?? undefined,
          mediaUrl: piece?.currentVersion?.asset?.url,
          contentVersionId: piece?.currentVersion?.id,
        });

        await this.calendarService.markPublished(entry.id);
      } catch (error) {
        // Cas attendu : campagne pas encore APPROVED à l'heure prévue — l'entrée est
        // marquée MISSED plutôt que de bloquer indéfiniment ou de publier sans validation.
        this.logger.warn(`Entrée de calendrier ${entry.id} non publiée: ${error}`);
        await this.calendarService.markMissed(entry.id, String(error));
      }
    }
  }
}
