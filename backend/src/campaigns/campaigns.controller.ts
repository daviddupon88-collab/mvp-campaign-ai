import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestMeta } from '../common/decorators/request-meta.decorator';
import { AuditService } from '../audit/audit.service';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/campaign.dto';
import { RejectCampaignDto } from './dto/approval.dto';

interface AuthUser {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
}

interface Meta {
  ipAddress?: string;
  userAgent?: string;
}

@Controller('campaigns')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.campaignsService.list(user.organizationId);
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaignsService.getById(user.organizationId, id);
  }

  // Editor (et au-dessus) peut proposer une campagne — elle part en génération,
  // puis attend une validation humaine avant tout accès à la publication.
  @Post()
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  // Chaque création déclenche une génération IA complète (analyse, stratégie, copywriting,
  // visuel, parfois vidéo) — coûteuse en crédits et en appels fournisseurs. La limite
  // d'entitlements (EntitlementsService) protège déjà le quota, mais cette limite de débit
  // évite en plus qu'un script mal écrit ne sature la queue de génération en quelques secondes.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateCampaignDto, @RequestMeta() meta: Meta) {
    const campaign = await this.campaignsService.create(user.organizationId, dto);
    await this.auditService.record('campaign.created', 'Campaign', campaign.id, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta }, { name: dto.name });
    return campaign;
  }

  // Garde-fou n°1 : seul un Marketing Manager (ou rôle supérieur) peut approuver —
  // un Editor peut proposer une campagne mais jamais l'auto-valider. Décision sensible :
  // toujours tracée dans la piste d'audit (qui a approuvé, quand, depuis quelle IP).
  @Post(':id/approve')
  @Roles('MARKETING_MANAGER', 'ADMIN', 'OWNER')
  async approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @RequestMeta() meta: Meta) {
    const campaign = await this.campaignsService.approve(user.organizationId, id, { userId: user.userId, email: user.email });
    await this.auditService.record('campaign.approved', 'Campaign', id, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta });
    return campaign;
  }

  @Post(':id/reject')
  @Roles('MARKETING_MANAGER', 'ADMIN', 'OWNER')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectCampaignDto, @RequestMeta() meta: Meta) {
    const campaign = await this.campaignsService.reject(user.organizationId, id, { userId: user.userId, email: user.email }, dto);
    await this.auditService.record('campaign.rejected', 'Campaign', id, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta }, { reason: dto.reason });
    return campaign;
  }

  // Relance la génération après un rejet (ex: produit ou objectif corrigé), sans
  // recréer une nouvelle campagne — repasse par génération puis modération.
  @Post(':id/regenerate')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  regenerate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateCampaignDto) {
    return this.campaignsService.regenerate(user.organizationId, id, dto);
  }

  // P0.12 (chantier "Creative Intelligence Engine & Video Quality Loop", 2026-08-18) — opt-in,
  // uniquement sur une campagne déjà APPROVED, résultat éphémère (jamais persisté).
  @Post(':id/creative-variations')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  generateCreativeVariations(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaignsService.generateCreativeVariations(user.organizationId, id);
  }
}
