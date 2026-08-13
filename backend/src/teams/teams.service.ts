import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../plans/entitlements.service';
import { EmailService } from '../notifications/email/email.service';
import { emailTemplates } from '../notifications/email/email-templates';
import { NotificationsService } from '../notifications/notifications.service';
import { roleLevel } from '../common/role-hierarchy';

export interface TeamActor {
  userId: string;
  email: string;
  role: string;
}

const INVITATION_EXPIRY_DAYS = 7;

// Gère le cycle de vie complet d'une équipe : invitations, acceptation, changement de rôle,
// retrait de membre — avec les garde-fous indispensables à un vrai socle multi-tenant :
// on ne peut jamais laisser une organisation sans OWNER, et personne ne peut s'octroyer
// ou octroyer à un tiers un rôle supérieur au sien.
@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async listMembers(organizationId: string) {
    return this.prisma.membership.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, email: true, fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listInvitations(organizationId: string) {
    return this.prisma.invitation.findMany({
      where: { organizationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Invite un nouveau membre par email. Contrôles, dans l'ordre : le siège doit être
  // disponible (entitlement du plan), l'invitant ne peut pas octroyer un rôle supérieur
  // au sien, la personne ne doit pas déjà être membre ni avoir une invitation en attente.
  async invite(organizationId: string, actor: TeamActor, email: string, role: string) {
    if (roleLevel(role) > roleLevel(actor.role)) {
      throw new ForbiddenException("Vous ne pouvez pas inviter quelqu'un à un rôle supérieur au vôtre");
    }

    await this.entitlements.assertActiveSubscription(organizationId);
    await this.entitlements.assertSeatAvailable(organizationId);

    const normalizedEmail = email.toLowerCase().trim();

    const existingMembership = await this.prisma.membership.findFirst({
      where: { organizationId, user: { email: normalizedEmail } },
    });
    if (existingMembership) throw new ConflictException('Cette personne est déjà membre de l\'organisation');

    const existingInvitation = await this.prisma.invitation.findFirst({
      where: { organizationId, email: normalizedEmail, status: 'PENDING' },
    });
    if (existingInvitation) throw new ConflictException('Une invitation est déjà en attente pour cet email');

    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId,
        email: normalizedEmail,
        role: role as any,
        invitedByUserId: actor.userId,
        invitedByEmail: actor.email,
        expiresAt: new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    // Envoi effectif de l'email d'invitation — auparavant, le token n'était retourné que
    // dans la réponse API. best-effort : un échec d'envoi ne doit pas empêcher la création
    // de l'invitation, qui reste valide et peut être renvoyée via resendInvitation().
    const organization = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    await this.emailService.send({
      to: normalizedEmail,
      subject: `${actor.email} vous invite à rejoindre ${organization?.name ?? 'une organisation'} sur Campaign-ai`,
      html: emailTemplates.invitation({
        organizationName: organization?.name ?? 'une organisation',
        inviterName: actor.email,
        acceptUrl: `${frontendUrl}/invitations/${invitation.token}`,
      }),
    });

    return invitation;
  }

  async revokeInvitation(organizationId: string, invitationId: string) {
    const invitation = await this.prisma.invitation.findFirst({ where: { id: invitationId, organizationId } });
    if (!invitation) throw new NotFoundException('Invitation introuvable');
    if (invitation.status !== 'PENDING') throw new BadRequestException('Cette invitation a déjà été traitée');

    return this.prisma.invitation.update({ where: { id: invitationId }, data: { status: 'REVOKED' } });
  }

  async resendInvitation(organizationId: string, invitationId: string) {
    const invitation = await this.prisma.invitation.findFirst({ where: { id: invitationId, organizationId } });
    if (!invitation) throw new NotFoundException('Invitation introuvable');
    if (invitation.status !== 'PENDING') throw new BadRequestException('Cette invitation a déjà été traitée');

    const updated = await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { expiresAt: new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000) },
    });

    const organization = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    await this.emailService.send({
      to: invitation.email,
      subject: `Rappel : invitation à rejoindre ${organization?.name ?? 'une organisation'} sur Campaign-ai`,
      html: emailTemplates.invitation({
        organizationName: organization?.name ?? 'une organisation',
        inviterName: invitation.invitedByEmail,
        acceptUrl: `${frontendUrl}/invitations/${invitation.token}`,
      }),
    });

    return updated;
  }

  // Aperçu public (pas d'auth) pour la page d'acceptation — ne révèle que le strict
  // nécessaire (nom d'organisation, rôle proposé), jamais de données sensibles.
  async getInvitationPreview(token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token },
      include: { organization: { select: { name: true } } },
    });
    if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) {
      throw new NotFoundException('Invitation introuvable ou expirée');
    }
    return {
      organizationName: invitation.organization.name,
      role: invitation.role,
      email: invitation.email,
      invitedByEmail: invitation.invitedByEmail,
    };
  }

  // L'utilisateur doit être authentifié (donc déjà inscrit) avec l'email exact de
  // l'invitation — empêche qu'un lien intercepté soit accepté par un tiers.
  async acceptInvitation(token: string, currentUser: { userId: string; email: string }) {
    const invitation = await this.prisma.invitation.findUnique({ where: { token } });
    if (!invitation || invitation.status !== 'PENDING') {
      throw new NotFoundException('Invitation introuvable ou déjà traitée');
    }
    if (invitation.expiresAt < new Date()) {
      await this.prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'EXPIRED' } });
      throw new BadRequestException('Cette invitation a expiré');
    }
    if (invitation.email.toLowerCase() !== currentUser.email.toLowerCase()) {
      throw new ForbiddenException("Cette invitation a été envoyée à une autre adresse email");
    }

    const existingMembership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: currentUser.userId, organizationId: invitation.organizationId } },
    });
    if (existingMembership) throw new ConflictException('Vous êtes déjà membre de cette organisation');

    // Re-vérifie le siège au moment de l'acceptation (il a pu se libérer/saturer entre-temps).
    await this.entitlements.assertSeatAvailable(invitation.organizationId);

    const [membership] = await this.prisma.$transaction([
      this.prisma.membership.create({
        data: { userId: currentUser.userId, organizationId: invitation.organizationId, role: invitation.role },
      }),
      this.prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } }),
    ]);

    // Best-effort : visible dans le centre de notifications des OWNER/ADMIN existants,
    // en plus de l'email d'invitation déjà envoyé par invite() — jusqu'ici, un nouveau
    // membre n'apparaissait que si quelqu'un consultait /settings/team.
    await this.notifications.notifyOrganization(invitation.organizationId, ['OWNER', 'ADMIN'], {
      organizationId: invitation.organizationId,
      type: 'TEAM_MEMBER_JOINED',
      title: "Nouveau membre dans l'équipe",
      body: `${currentUser.email} a rejoint l'équipe en tant que ${invitation.role}.`,
      link: '/settings/team',
    });

    return membership;
  }

  // Empêche de démoter le dernier OWNER — une organisation sans OWNER ne peut plus
  // être administrée (personne ne pourrait plus changer les rôles ni résilier l'abonnement).
  private async assertNotLastOwner(organizationId: string, membershipId: string) {
    const membership = await this.prisma.membership.findFirst({ where: { id: membershipId, organizationId } });
    if (!membership) throw new NotFoundException('Membre introuvable');
    if (membership.role !== 'OWNER') return membership;

    const ownerCount = await this.prisma.membership.count({ where: { organizationId, role: 'OWNER' } });
    if (ownerCount <= 1) {
      throw new ForbiddenException(
        "Impossible : cette organisation n'aurait plus aucun propriétaire. Promouvez d'abord un autre membre au rôle Owner.",
      );
    }
    return membership;
  }

  async changeRole(organizationId: string, actor: TeamActor, membershipId: string, newRole: string) {
    if (roleLevel(newRole) > roleLevel(actor.role)) {
      throw new ForbiddenException('Vous ne pouvez pas accorder un rôle supérieur au vôtre');
    }
    const membership = await this.assertNotLastOwner(organizationId, membershipId);
    if (roleLevel(membership.role) > roleLevel(actor.role)) {
      throw new ForbiddenException("Vous ne pouvez pas modifier le rôle d'un membre de rang supérieur au vôtre");
    }

    const updated = await this.prisma.membership.update({ where: { id: membershipId }, data: { role: newRole as any } });

    const targetUser = await this.prisma.user.findUnique({ where: { id: membership.userId }, select: { email: true } });
    await this.notifications.notifyOrganization(organizationId, ['OWNER', 'ADMIN'], {
      organizationId,
      type: 'TEAM_ROLE_CHANGED',
      title: "Changement de rôle dans l'équipe",
      body: `${actor.email} a changé le rôle de ${targetUser?.email ?? 'un membre'} : ${membership.role} → ${newRole}.`,
      link: '/settings/team',
    });

    return updated;
  }

  async removeMember(organizationId: string, actor: TeamActor, membershipId: string) {
    const membership = await this.assertNotLastOwner(organizationId, membershipId);
    if (roleLevel(membership.role) > roleLevel(actor.role)) {
      throw new ForbiddenException("Vous ne pouvez pas retirer un membre de rang supérieur au vôtre");
    }

    const targetUser = await this.prisma.user.findUnique({ where: { id: membership.userId }, select: { email: true } });
    const deleted = await this.prisma.membership.delete({ where: { id: membershipId } });

    await this.notifications.notifyOrganization(organizationId, ['OWNER', 'ADMIN'], {
      organizationId,
      type: 'TEAM_MEMBER_REMOVED',
      title: "Membre retiré de l'équipe",
      body: `${actor.email} a retiré ${targetUser?.email ?? 'un membre'} de l'équipe.`,
      link: '/settings/team',
    });

    return deleted;
  }
}
