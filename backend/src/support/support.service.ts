import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { escapeHtml } from '../notifications/email/email-templates';

// Système de tickets minimal mais fonctionnel — pas de file d'attente d'équipe ni de SLA
// (cf. roadmap), mais un vrai fil de conversation avec notification bidirectionnelle :
// le client est notifié (in-app + email) à chaque réponse de l'équipe, symétrique à ce que
// NotificationsService fait déjà pour les autres événements du cycle de vie d'une campagne.
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async createTicket(userId: string, organizationId: string | undefined, subject: string, message: string, priority?: string) {
    return this.prisma.supportTicket.create({
      data: {
        userId,
        organizationId,
        subject,
        message,
        priority: (priority as any) ?? 'NORMAL',
      },
    });
  }

  async listForUser(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      include: { replies: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getById(userId: string, ticketId: string, isPlatformAdmin: boolean) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { replies: { orderBy: { createdAt: 'asc' } }, user: { select: { email: true } } },
    });
    if (!ticket) throw new NotFoundException('Ticket introuvable');
    // Un utilisateur ne peut voir que ses propres tickets — sauf l'équipe Campaign-ai
    // (isPlatformAdmin), qui doit pouvoir répondre à n'importe quel ticket.
    if (ticket.userId !== userId && !isPlatformAdmin) throw new ForbiddenException('Accès refusé à ce ticket');
    return ticket;
  }

  // Réponse du CLIENT sur son propre ticket — repasse le statut à OPEN si l'équipe l'avait
  // marqué RESOLVED, pour signaler qu'un suivi est de nouveau nécessaire.
  async replyAsCustomer(userId: string, ticketId: string, message: string) {
    const ticket = await this.getById(userId, ticketId, false);
    const reply = await this.prisma.supportTicketReply.create({
      data: { ticketId: ticket.id, message, isStaff: false },
    });
    await this.prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: 'OPEN' } });
    return reply;
  }

  // Réponse de l'ÉQUIPE Campaign-ai — notifie systématiquement le client (in-app + email),
  // car c'est l'événement qu'il attend activement après avoir ouvert un ticket.
  async replyAsStaff(staffEmail: string, ticketId: string, message: string, newStatus?: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId }, include: { user: true } });
    if (!ticket) throw new NotFoundException('Ticket introuvable');

    const reply = await this.prisma.supportTicketReply.create({
      data: { ticketId, message, isStaff: true, authorEmail: staffEmail },
    });

    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: (newStatus as any) ?? 'IN_PROGRESS' },
    });

    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    await this.notifications.notify({
      userId: ticket.userId,
      type: 'SUPPORT_REPLY',
      title: `Nouvelle réponse à votre ticket "${ticket.subject}"`,
      body: message.slice(0, 200),
      link: `/support/${ticketId}`,
      email: {
        to: ticket.user.email,
        subject: `Re: ${ticket.subject}`,
        html: `<p>${escapeHtml(message)}</p><p><a href="${frontendUrl}/support/${ticketId}">Voir la conversation</a></p>`,
      },
    });

    return reply;
  }

  // Vue plateforme (équipe Campaign-ai) — tous les tickets, tous clients confondus,
  // triés pour traiter les plus urgents/anciens en premier.
  async listAllForStaff(filters: { status?: string }) {
    return this.prisma.supportTicket.findMany({
      where: filters.status ? { status: filters.status as any } : {},
      include: { user: { select: { email: true } } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }
}
