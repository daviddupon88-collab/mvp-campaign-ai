import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email/email.service';

export interface NotifyParams {
  userId: string;
  organizationId?: string;
  type:
    | 'CAMPAIGN_READY_FOR_REVIEW'
    | 'CAMPAIGN_PUBLISHED'
    | 'CAMPAIGN_REJECTED'
    | 'OPTIMIZER_RECOMMENDATION'
    | 'TRIAL_ENDING_SOON'
    | 'TRIAL_EXPIRED'
    | 'PAYMENT_FAILED'
    | 'TEAM_INVITATION'
    | 'SUPPORT_REPLY'
    | 'CAMPAIGN_GENERATION_FAILED'
    | 'TEAM_MEMBER_JOINED'
    | 'TEAM_MEMBER_REMOVED'
    | 'TEAM_ROLE_CHANGED';
  title: string;
  body: string;
  link?: string;
  email?: { to: string; subject: string; html: string }; // omis = notification in-app uniquement
}

// Point d'entrée unique pour toute notification — crée systématiquement la notification
// in-app (persistée, consultable dans le centre de notifications) et envoie l'email associé
// si fourni. Comme AuditService, écriture best-effort : un échec de notification ne doit
// jamais faire échouer l'action métier qui l'a déclenchée (une campagne reste APPROVED
// même si la notification de publication échoue à être créée).
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async notify(params: NotifyParams): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: params.userId,
          organizationId: params.organizationId,
          type: params.type as any,
          title: params.title,
          body: params.body,
          link: params.link,
        },
      });
    } catch (error) {
      this.logger.error(`Échec de création de la notification in-app (${params.type}): ${error}`);
    }

    if (params.email) {
      await this.emailService.send(params.email);
    }
  }

  // Notifie tous les membres d'une organisation ayant au moins le rôle minimum requis —
  // utilisé pour les événements qui concernent l'équipe entière plutôt qu'un seul utilisateur
  // (ex: "campagne prête pour revue" doit atteindre tous les Marketing Manager+, pas
  // seulement celui qui l'a créée).
  async notifyOrganization(
    organizationId: string,
    minRole: string[],
    params: Omit<NotifyParams, 'userId'>,
  ): Promise<void> {
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId, role: { in: minRole as any } },
      include: { user: { select: { id: true, email: true } } },
    });

    await Promise.all(
      memberships.map((m) =>
        this.notify({
          ...params,
          userId: m.user.id,
          email: params.email ? { ...params.email, to: m.user.email } : undefined,
        }),
      ),
    );
  }

  async listForUser(userId: string, filters: { unreadOnly?: boolean; limit?: number }) {
    return this.prisma.notification.findMany({
      where: { userId, ...(filters.unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 30, 100),
    });
  }

  async markAsRead(userId: string, notificationId: string) {
    // where inclut userId : empêche un utilisateur de marquer comme lue la notification
    // d'un autre — updateMany plutôt qu'update pour ne pas lever d'exception si l'ID
    // n'appartient pas à l'appelant, simplement ne rien affecter.
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  }
}
