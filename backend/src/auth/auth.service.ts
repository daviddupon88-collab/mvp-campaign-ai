import { Injectable, UnauthorizedException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { TRIAL_PLAN_KEY, TRIAL_DURATION_DAYS, getPlan } from '../plans/plan-catalog';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  // Inscription : crée l'utilisateur, son organisation, et le rattache en tant qu'Owner.
  // C'est le point d'entrée du multi-tenant : chaque inscription crée un nouveau tenant.
  // Démarre un essai gratuit natif (pas de carte requise) au niveau du plan Growth pendant
  // 14 jours, pour montrer la pleine valeur du produit avant de demander un choix payant —
  // cf. plan-catalog.ts (TRIAL_PLAN_KEY). trialUsed=true dès le départ empêche de relancer
  // un essai en recréant une organisation avec le même compte.
  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Un compte existe déjà avec cet email');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const trialPlan = getPlan(TRIAL_PLAN_KEY);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        fullName: dto.fullName,
        memberships: {
          create: {
            role: 'OWNER',
            organization: {
              create: {
                name: dto.organizationName,
                subscription: {
                  create: {
                    plan: TRIAL_PLAN_KEY,
                    aiCreditsIncluded: trialPlan.aiCreditsIncluded,
                    status: 'trialing',
                    trialEndsAt: new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000),
                    trialUsed: true,
                  },
                },
              },
            },
          },
        },
      },
      include: { memberships: { include: { organization: true } } },
    });

    const organizationId = user.memberships[0].organizationId;
    return this.buildAuthResponse(user.id, user.email, organizationId, 'OWNER', user.isPlatformAdmin);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { memberships: true },
    });

    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Identifiants invalides');
    }
    if (user.memberships.length === 0) {
      throw new ForbiddenException("Ce compte n'appartient à aucune organisation");
    }

    // Choisit la première organisation par défaut ; le frontend peut ensuite appeler
    // switchOrganization() si l'utilisateur en a plusieurs (cf. getMyOrganizations()).
    const membership = user.memberships[0];
    return this.buildAuthResponse(user.id, user.email, membership.organizationId, membership.role, user.isPlatformAdmin);
  }

  // Vue multi-org : toutes les organisations auxquelles l'utilisateur appartient, avec
  // son rôle dans chacune — alimente un sélecteur d'organisation côté frontend.
  async getMyOrganizations(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { organization: { select: { id: true, name: true } } },
    });
    return memberships.map((m) => ({ id: m.organization.id, name: m.organization.name, role: m.role }));
  }

  // Ré-émet un JWT scopé sur une autre organisation dont l'utilisateur est membre —
  // c'est le mécanisme qui rend le multi-tenant réellement utilisable pour quelqu'un
  // qui gère plusieurs organisations (ex: une agence avec plusieurs clients).
  async switchOrganization(userId: string, email: string, organizationId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (!membership) throw new NotFoundException("Vous n'êtes pas membre de cette organisation");

    // Re-lu depuis la base plutôt que propagé depuis l'ancien token : évite qu'un accès
    // plateforme révoqué entre-temps ne survive artificiellement via un ancien JWT recyclé.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
    return this.buildAuthResponse(userId, email, organizationId, membership.role, user?.isPlatformAdmin ?? false);
  }

  // Préférence de langue de l'interface (i18n) — jamais lue ni utilisée par la génération
  // de campagne, qui reste un paramètre indépendant. cf. UpdateLanguageDto pour la validation
  // des valeurs autorisées.
  async updateLanguage(userId: string, preferredLanguage: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { preferredLanguage: preferredLanguage as any },
      select: { id: true, preferredLanguage: true },
    });
    return user;
  }

  private buildAuthResponse(userId: string, email: string, organizationId: string, role: string, isPlatformAdmin = false) {
    const payload = { sub: userId, email, organizationId, role, isPlatformAdmin };
    return {
      accessToken: this.jwtService.sign(payload),
      user: { id: userId, email, organizationId, role, isPlatformAdmin },
    };
  }
}
