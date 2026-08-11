import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ReviewActor {
  userId: string;
  email: string;
}

// Gère le cycle de vie humain des recommandations générées par l'AI Optimizer :
// PENDING -> APPLIED (le marketeur a mis en œuvre la suggestion, manuellement sur la
// plateforme publicitaire concernée) ou DISMISSED (écartée). Campaign-ai ne modifie jamais
// automatiquement une campagne ou un budget réel à partir d'une recommandation.
@Injectable()
export class OptimizerService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCampaign(organizationId: string, campaignId: string) {
    return this.prisma.optimizationRecommendation.findMany({
      where: { organizationId, campaignId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listPendingForOrganization(organizationId: string) {
    return this.prisma.optimizationRecommendation.findMany({
      where: { organizationId, status: 'PENDING' },
      include: { campaign: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getOwnedRecommendation(organizationId: string, id: string) {
    const rec = await this.prisma.optimizationRecommendation.findFirst({ where: { id, organizationId } });
    if (!rec) throw new NotFoundException('Recommandation introuvable');
    return rec;
  }

  async apply(organizationId: string, id: string, actor: ReviewActor) {
    const rec = await this.getOwnedRecommendation(organizationId, id);
    if (rec.status !== 'PENDING') {
      throw new BadRequestException(`Cette recommandation a déjà été traitée (statut: ${rec.status})`);
    }
    return this.prisma.optimizationRecommendation.update({
      where: { id },
      data: { status: 'APPLIED', reviewedByUserId: actor.userId, reviewedByEmail: actor.email, reviewedAt: new Date() },
    });
  }

  async dismiss(organizationId: string, id: string, actor: ReviewActor) {
    const rec = await this.getOwnedRecommendation(organizationId, id);
    if (rec.status !== 'PENDING') {
      throw new BadRequestException(`Cette recommandation a déjà été traitée (statut: ${rec.status})`);
    }
    return this.prisma.optimizationRecommendation.update({
      where: { id },
      data: { status: 'DISMISSED', reviewedByUserId: actor.userId, reviewedByEmail: actor.email, reviewedAt: new Date() },
    });
  }
}
