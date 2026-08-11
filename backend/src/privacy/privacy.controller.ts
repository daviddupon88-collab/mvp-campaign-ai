import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestMeta } from '../common/decorators/request-meta.decorator';
import { AuditService } from '../audit/audit.service';
import { PrivacyService } from './privacy.service';
import { AcceptPolicyDto } from './dto/accept-policy.dto';

interface AuthUser {
  userId: string;
  email: string;
  organizationId: string;
}

interface Meta {
  ipAddress?: string;
  userAgent?: string;
}

@Controller('privacy')
export class PrivacyController {
  constructor(
    private readonly privacyService: PrivacyService,
    private readonly auditService: AuditService,
  ) {}

  // Textes légaux publics — consultables avant même la création d'un compte.
  @Get('policies')
  listPolicies() {
    return this.privacyService.listPolicies();
  }

  @Get('policies/:type')
  getPolicy(@Param('type') type: string) {
    return this.privacyService.getPolicy(type);
  }

  @Get('policies/status/mine')
  @UseGuards(JwtAuthGuard)
  getAcceptanceStatus(@CurrentUser() user: AuthUser) {
    return this.privacyService.getAcceptanceStatus(user.userId);
  }

  @Post('policies/accept')
  @UseGuards(JwtAuthGuard)
  acceptPolicy(@CurrentUser() user: AuthUser, @Body() dto: AcceptPolicyDto, @RequestMeta() meta: Meta) {
    return this.privacyService.acceptPolicy(user.userId, dto.policyType, meta.ipAddress);
  }

  // Portabilité (RGPD Article 20) — limité en débit : un export complet est une opération
  // coûteuse (plusieurs requêtes agrégées), pas un endpoint à appeler en boucle.
  @Get('export')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async exportMyData(@CurrentUser() user: AuthUser, @RequestMeta() meta: Meta) {
    const data = await this.privacyService.exportUserData(user.userId);
    await this.auditService.record('privacy.data_exported', 'User', user.userId, { actorUserId: user.userId, actorEmail: user.email, ...meta });
    return data;
  }

  // Effacement (RGPD Article 17) — action irréversible, toujours tracée dans la piste
  // d'audit AVANT anonymisation (sinon actorEmail serait déjà anonymisé au moment d'écrire l'audit).
  @Post('delete-account')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  async deleteAccount(@CurrentUser() user: AuthUser, @RequestMeta() meta: Meta) {
    await this.auditService.record('privacy.account_deletion_requested', 'User', user.userId, { actorUserId: user.userId, actorEmail: user.email, ...meta });
    return this.privacyService.requestAccountDeletion(user.userId);
  }

  // AI Act : information sur l'usage de systèmes d'IA pour une campagne donnée.
  @Get('ai-disclosure/:campaignId')
  @UseGuards(JwtAuthGuard)
  getAiDisclosure(@CurrentUser() user: AuthUser, @Param('campaignId') campaignId: string) {
    return this.privacyService.getAiDisclosureForCampaign(user.organizationId, campaignId);
  }
}
