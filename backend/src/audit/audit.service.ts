import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditContext {
  organizationId?: string;
  actorUserId?: string;
  actorEmail?: string;
  ipAddress?: string;
  userAgent?: string;
}

// Service d'écriture de la piste d'audit — volontairement best-effort : une panne
// d'écriture d'audit (base indisponible, contrainte violée) ne doit JAMAIS faire échouer
// l'action métier elle-même. Un audit manqué est regrettable ; une approbation de campagne
// bloquée à cause d'un problème d'écriture d'audit serait pire.
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    action: string,
    resourceType: string,
    resourceId: string | undefined,
    ctx: AuditContext,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          resourceType,
          resourceId,
          organizationId: ctx.organizationId,
          actorUserId: ctx.actorUserId,
          actorEmail: ctx.actorEmail,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          metadata: (metadata as any) ?? undefined,
        },
      });
    } catch (error) {
      // Ne relance jamais — cf. commentaire de classe.
      this.logger.error(`Échec d'écriture de l'audit (${action}): ${error}`);
    }
  }

  async listForOrganization(
    organizationId: string,
    filters: { action?: string; resourceType?: string; limit?: number },
  ) {
    return this.prisma.auditLog.findMany({
      where: {
        organizationId,
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 50, 500),
    });
  }
}
