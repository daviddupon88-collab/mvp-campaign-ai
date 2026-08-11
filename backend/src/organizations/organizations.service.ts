import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { TRIAL_PLAN_KEY, TRIAL_DURATION_DAYS, getPlan } from '../plans/plan-catalog';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async getById(organizationId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { subscription: true, brandKit: true },
    });
    if (!org) throw new NotFoundException('Organisation introuvable');
    return org;
  }

  // Crée une organisation supplémentaire pour un utilisateur déjà inscrit (cas typique :
  // une agence qui gère plusieurs clients, chacun dans son propre tenant isolé). L'essai
  // gratuit s'applique aussi à cette nouvelle organisation, indépendamment de celles
  // déjà possédées par l'utilisateur — chaque tenant a son propre cycle de facturation.
  async createAdditional(userId: string, email: string, name: string) {
    const trialPlan = getPlan(TRIAL_PLAN_KEY);

    const organization = await this.prisma.organization.create({
      data: {
        name,
        subscription: {
          create: {
            plan: TRIAL_PLAN_KEY,
            aiCreditsIncluded: trialPlan.aiCreditsIncluded,
            status: 'trialing',
            trialEndsAt: new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000),
            trialUsed: true,
          },
        },
        users: { create: { userId, role: 'OWNER' } },
      },
    });

    // Retourne directement un JWT scopé sur la nouvelle organisation, pour que le
    // frontend puisse y basculer sans appel supplémentaire à /auth/switch-organization.
    const payload = { sub: userId, email, organizationId: organization.id, role: 'OWNER' };
    return { organization, accessToken: this.jwtService.sign(payload) };
  }
}
