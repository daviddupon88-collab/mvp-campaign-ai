import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { getPlan } from '../plans/plan-catalog';

// Panneau d'administration plateforme : la SEULE zone du backend qui lit délibérément
// À TRAVERS les organisations plutôt qu'à l'intérieur d'une seule (cf. principe d'isolation
// multi-tenant rappelé dans tout le reste du code). Chaque endpoint de ce module est
// protégé par PlatformAdminGuard, jamais par RolesGuard — un OWNER, même sur son
// organisation, n'a aucun droit ici.
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private currentPeriodStart(): Date {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  }

  // ---------------------------------------------------------------------
  // Organisations
  // ---------------------------------------------------------------------

  async listOrganizations(filters: { search?: string; plan?: string; status?: string; limit?: number; offset?: number }) {
    const where = {
      ...(filters.search ? { name: { contains: filters.search, mode: 'insensitive' as const } } : {}),
      ...(filters.plan || filters.status
        ? {
            subscription: {
              ...(filters.plan ? { plan: filters.plan } : {}),
              ...(filters.status ? { status: filters.status } : {}),
            },
          }
        : {}),
    };

    const [organizations, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        include: {
          subscription: true,
          _count: { select: { users: true, campaigns: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(filters.limit ?? 50, 200),
        skip: filters.offset ?? 0,
      }),
      this.prisma.organization.count({ where }),
    ]);

    return {
      total,
      organizations: organizations.map((org) => ({
        id: org.id,
        name: org.name,
        createdAt: org.createdAt,
        plan: org.subscription?.plan ?? null,
        subscriptionStatus: org.subscription?.status ?? null,
        aiCreditsUsed: org.subscription?.aiCreditsUsed ?? 0,
        aiCreditsIncluded: org.subscription?.aiCreditsIncluded ?? 0,
        extraCredits: org.subscription?.extraCredits ?? 0,
        memberCount: org._count.users,
        campaignCount: org._count.campaigns,
      })),
    };
  }

  async getOrganizationDetail(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscription: true,
        users: { include: { user: { select: { id: true, email: true, fullName: true, createdAt: true } } } },
        brandKit: { select: { id: true } },
      },
    });
    if (!org) throw new NotFoundException('Organisation introuvable');

    const periodStart = this.currentPeriodStart();
    const [campaignCount, aiCostAgg, recentAuditLog] = await Promise.all([
      this.prisma.campaign.count({ where: { organizationId } }),
      this.prisma.aiGeneration.aggregate({
        where: { organizationId, createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
        _sum: { costEstimate: true },
      }),
      this.prisma.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);

    return {
      id: org.id,
      name: org.name,
      createdAt: org.createdAt,
      subscription: org.subscription,
      hasBrandKit: !!org.brandKit,
      members: org.users.map((m) => ({ ...m.user, role: m.role, joinedAt: m.createdAt })),
      campaignCount,
      aiCostThisMonthUsd: aiCostAgg._sum.costEstimate ?? 0,
      recentActivity: recentAuditLog,
    };
  }

  // Action d'administration réelle, pas seulement une vue en lecture — d'où la journalisation
  // d'audit systématique et le fait qu'elle passe par le même EntitlementsService que le
  // reste de la plateforme (cf. assertActiveSubscription, qui bloque désormais 'suspended').
  async suspendOrganization(organizationId: string, reason: string, actorEmail: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, include: { subscription: true } });
    if (!org?.subscription) throw new NotFoundException('Organisation ou abonnement introuvable');

    await this.prisma.subscription.update({ where: { organizationId }, data: { status: 'suspended' } });
    await this.auditService.record('admin.organization_suspended', 'Organization', organizationId, { organizationId, actorEmail }, { reason });

    return { status: 'suspended' };
  }

  async reactivateOrganization(organizationId: string, actorEmail: string) {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, include: { subscription: true } });
    if (!org?.subscription) throw new NotFoundException('Organisation ou abonnement introuvable');

    // Simplification assumée : réactive toujours vers 'active', sans mémoriser le statut
    // antérieur exact (trialing vs active) — une organisation réactivée après investigation
    // repasse par un statut standard plutôt que de deviner son état précédent.
    await this.prisma.subscription.update({ where: { organizationId }, data: { status: 'active' } });
    await this.auditService.record('admin.organization_reactivated', 'Organization', organizationId, { organizationId, actorEmail });

    return { status: 'active' };
  }

  // ---------------------------------------------------------------------
  // Utilisateurs
  // ---------------------------------------------------------------------

  async listUsers(filters: { search?: string; limit?: number; offset?: number }) {
    const where = filters.search
      ? { OR: [{ email: { contains: filters.search, mode: 'insensitive' as const } }, { fullName: { contains: filters.search, mode: 'insensitive' as const } }] }
      : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { memberships: { include: { organization: { select: { id: true, name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: Math.min(filters.limit ?? 50, 200),
        skip: filters.offset ?? 0,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      total,
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        createdAt: u.createdAt,
        deletedAt: u.deletedAt,
        isPlatformAdmin: u.isPlatformAdmin,
        organizations: u.memberships.map((m) => ({ id: m.organization.id, name: m.organization.name, role: m.role })),
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Abonnements (vue plateforme)
  // ---------------------------------------------------------------------

  async getSubscriptionsOverview() {
    const subscriptions = await this.prisma.subscription.findMany();

    const byStatus: Record<string, number> = {};
    const byPlan: Record<string, number> = {};
    let estimatedMrr = 0;

    for (const sub of subscriptions) {
      byStatus[sub.status] = (byStatus[sub.status] ?? 0) + 1;
      byPlan[sub.plan] = (byPlan[sub.plan] ?? 0) + 1;

      if (sub.status === 'active') {
        try {
          estimatedMrr += getPlan(sub.plan).priceMonthly ?? 0;
        } catch {
          // plan inconnu (donnée historique/test) — ignoré du calcul plutôt que de faire
          // échouer toute la vue d'ensemble pour une seule ligne mal formée.
        }
      }
    }

    return { totalSubscriptions: subscriptions.length, byStatus, byPlan, estimatedMrrUsd: estimatedMrr };
  }

  // ---------------------------------------------------------------------
  // Coûts IA (vue plateforme — cf. AiEconomicsService pour l'équivalent par organisation)
  // ---------------------------------------------------------------------

  async getAiCostsOverview() {
    const periodStart = this.currentPeriodStart();

    const [totalAgg, byProvider, topOrganizations] = await Promise.all([
      this.prisma.aiGeneration.aggregate({
        where: { createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
        _sum: { costEstimate: true },
        _count: { _all: true },
      }),
      this.prisma.aiGeneration.groupBy({
        by: ['provider'],
        where: { createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
        _sum: { costEstimate: true },
      }),
      this.prisma.aiGeneration.groupBy({
        by: ['organizationId'],
        where: { createdAt: { gte: periodStart }, status: 'SUCCEEDED' },
        _sum: { costEstimate: true },
        orderBy: { _sum: { costEstimate: 'desc' } },
        take: 10,
      }),
    ]);

    const orgNames = await this.prisma.organization.findMany({
      where: { id: { in: topOrganizations.map((o) => o.organizationId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(orgNames.map((o) => [o.id, o.name]));

    return {
      periodStart,
      totalCostUsd: totalAgg._sum.costEstimate ?? 0,
      totalCalls: totalAgg._count._all,
      byProvider: byProvider.map((r) => ({ provider: r.provider, costUsd: r._sum.costEstimate ?? 0 })),
      topOrganizationsBySpend: topOrganizations.map((o) => ({
        organizationId: o.organizationId,
        organizationName: nameById.get(o.organizationId) ?? 'inconnue',
        costUsd: o._sum.costEstimate ?? 0,
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Erreurs (vue d'exploitation)
  // ---------------------------------------------------------------------

  // Construite à partir des données déjà tracées (générations IA échouées, publications
  // échouées) plutôt qu'un journal d'erreurs HTTP dédié — les erreurs 5xx transitent déjà
  // vers Sentry (cf. GlobalExceptionFilter) pour l'analyse approfondie ; cette vue sert de
  // tableau de bord rapide sans avoir à ouvrir un outil externe pour un premier coup d'œil.
  async getRecentErrors(limit = 50) {
    const [failedGenerations, failedPublications, httpErrors] = await Promise.all([
      this.prisma.aiGeneration.findMany({
        where: { status: 'FAILED' },
        select: { id: true, organizationId: true, taskType: true, provider: true, errorMessage: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.publishedPost.findMany({
        where: { status: 'FAILED' },
        select: { id: true, organizationId: true, platform: true, errorMessage: true, attemptCount: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      // Vraies erreurs serveur HTTP (5xx), distinctes des deux ci-dessus qui restent des
      // succès HTTP avec un statut métier FAILED — cf. GlobalExceptionFilter, HttpErrorLog.
      this.prisma.httpErrorLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);

    return {
      failedAiGenerations: failedGenerations,
      failedPublications,
      httpErrors,
    };
  }

  // ---------------------------------------------------------------------
  // Activité (piste d'audit transverse — sensible, PlatformAdminGuard uniquement)
  // ---------------------------------------------------------------------

  async getActivityFeed(filters: { organizationId?: string; action?: string; limit?: number }) {
    return this.prisma.auditLog.findMany({
      where: {
        ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
        ...(filters.action ? { action: filters.action } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
    });
  }
}
