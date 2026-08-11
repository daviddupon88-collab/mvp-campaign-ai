import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Calendrier éditorial : planifie QUAND un contenu doit être diffusé sur un canal connecté.
// La publication réelle à l'heure dite est déclenchée par ScheduledPublishingService (cron),
// qui repasse par PublishingService — donc soumise aux mêmes garde-fous (campagne APPROVED,
// idempotence) qu'une publication manuelle. Planifier n'est jamais un raccourci qui contourne
// la validation humaine : une entrée dont la campagne n'est pas encore APPROVED au moment
// prévu est marquée MISSED plutôt que publiée sans validation.
@Injectable()
export class EditorialCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async schedule(organizationId: string, params: { contentPieceId: string; socialConnectionId: string; scheduledAt: Date }) {
    const piece = await this.prisma.contentPiece.findFirst({
      where: { id: params.contentPieceId, organizationId },
    });
    if (!piece) throw new NotFoundException('Contenu introuvable');

    const connection = await this.prisma.socialConnection.findFirst({
      where: { id: params.socialConnectionId, organizationId, status: 'ACTIVE' },
    });
    if (!connection) throw new NotFoundException('Connexion réseau social introuvable ou inactive');

    if (params.scheduledAt < new Date()) {
      throw new BadRequestException('La date de planification doit être dans le futur');
    }

    return this.prisma.calendarEntry.create({
      data: {
        organizationId,
        campaignId: piece.campaignId,
        contentPieceId: piece.id,
        socialConnectionId: connection.id,
        scheduledAt: params.scheduledAt,
        status: 'SCHEDULED',
      },
    });
  }

  // Vue calendrier (mois/semaine) — bornée par une plage de dates, avec le contenu et le
  // canal associés pour un affichage direct sans appel supplémentaire côté frontend.
  async listByRange(organizationId: string, from: Date, to: Date) {
    return this.prisma.calendarEntry.findMany({
      where: { organizationId, scheduledAt: { gte: from, lte: to } },
      include: {
        contentPiece: { include: { currentVersion: { include: { asset: true } } } },
        socialConnection: { select: { platform: true, externalAccountName: true } },
        campaign: { select: { name: true, status: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async cancel(organizationId: string, entryId: string) {
    const entry = await this.prisma.calendarEntry.findFirst({ where: { id: entryId, organizationId } });
    if (!entry) throw new NotFoundException('Entrée de calendrier introuvable');
    if (entry.status !== 'SCHEDULED') {
      throw new BadRequestException(`Impossible d'annuler une entrée au statut "${entry.status}"`);
    }
    return this.prisma.calendarEntry.update({ where: { id: entryId }, data: { status: 'CANCELED' } });
  }

  async reschedule(organizationId: string, entryId: string, scheduledAt: Date) {
    const entry = await this.prisma.calendarEntry.findFirst({ where: { id: entryId, organizationId } });
    if (!entry) throw new NotFoundException('Entrée de calendrier introuvable');
    if (entry.status !== 'SCHEDULED') {
      throw new BadRequestException(`Impossible de replanifier une entrée au statut "${entry.status}"`);
    }
    if (scheduledAt < new Date()) throw new BadRequestException('La nouvelle date doit être dans le futur');

    return this.prisma.calendarEntry.update({ where: { id: entryId }, data: { scheduledAt } });
  }

  // Utilisé par le cron — toutes les entrées dont l'heure est passée et toujours SCHEDULED.
  async listDue() {
    return this.prisma.calendarEntry.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
    });
  }

  async markPublished(entryId: string) {
    await this.prisma.calendarEntry.update({ where: { id: entryId }, data: { status: 'PUBLISHED' } });
  }

  async markMissed(entryId: string, errorMessage: string) {
    await this.prisma.calendarEntry.update({ where: { id: entryId }, data: { status: 'MISSED', errorMessage } });
  }
}
