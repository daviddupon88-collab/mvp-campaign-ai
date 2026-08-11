import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestMeta } from '../common/decorators/request-meta.decorator';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';

interface AuthUser {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
  isPlatformAdmin: boolean;
}

interface Meta {
  ipAddress?: string;
  userAgent?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  @Post('register')
  // Limite dédiée, plus stricte que la limite globale (100/min) : un flux d'inscription
  // n'a aucune raison légitime d'être tenté 10 fois par minute depuis la même IP.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async register(@Body() dto: RegisterDto, @RequestMeta() meta: Meta) {
    const result = await this.authService.register(dto);
    await this.auditService.record('auth.registered', 'User', result.user.id, { organizationId: result.user.organizationId, actorUserId: result.user.id, actorEmail: dto.email, ...meta });
    return result;
  }

  // Connexions journalisées, réussies ET échouées — surveillance de sécurité de base
  // (détection de bruteforce, alerte sur activité anormale). L'échec ne révèle jamais si
  // c'est l'email ou le mot de passe qui est incorrect (cf. AuthService), seule la piste
  // d'audit distingue les deux côté investigation.
  @Post('login')
  // Limite stricte dédiée : une tentative de connexion légitime n'a jamais besoin de plus
  // de quelques essais par minute — au-delà, c'est un signal de bruteforce à ralentir,
  // pas un cas d'usage réel à accommoder.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() dto: LoginDto, @RequestMeta() meta: Meta) {
    try {
      const result = await this.authService.login(dto);
      await this.auditService.record('auth.login_succeeded', 'User', result.user.id, { organizationId: result.user.organizationId, actorUserId: result.user.id, actorEmail: dto.email, ...meta });
      return result;
    } catch (error) {
      await this.auditService.record('auth.login_failed', 'User', undefined, { actorEmail: dto.email, ...meta });
      throw error;
    }
  }

  // Toutes les organisations de l'utilisateur courant + son rôle dans chacune —
  // alimente le sélecteur d'organisation côté frontend.
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    const organizations = await this.authService.getMyOrganizations(user.userId);
    return {
      user: { id: user.userId, email: user.email, isPlatformAdmin: user.isPlatformAdmin },
      currentOrganizationId: user.organizationId,
      role: user.role, // rôle DANS l'organisation courante — cf. organizations[].role pour les autres
      organizations,
    };
  }

  @Post('switch-organization')
  @UseGuards(JwtAuthGuard)
  switchOrganization(@CurrentUser() user: AuthUser, @Body() dto: SwitchOrganizationDto) {
    return this.authService.switchOrganization(user.userId, user.email, dto.organizationId);
  }
}
