import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptimizerService } from './optimizer.service';
import { AiOptimizerService } from './ai-optimizer.service';
import { AutomationService } from './automation.service';
import { ReviewRecommendationDto } from './dto/review-recommendation.dto';

interface AuthUser {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class OptimizerController {
  constructor(
    private readonly optimizerService: OptimizerService,
    private readonly aiOptimizerService: AiOptimizerService,
    private readonly automationService: AutomationService,
  ) {}

  @Get('campaigns/:campaignId/optimizations')
  listForCampaign(@CurrentUser() user: AuthUser, @Param('campaignId') campaignId: string) {
    return this.optimizerService.listForCampaign(user.organizationId, campaignId);
  }

  @Get('optimizations/pending')
  listPending(@CurrentUser() user: AuthUser) {
    return this.optimizerService.listPendingForOrganization(user.organizationId);
  }

  // Applique = le marketeur confirme avoir mis en œuvre la suggestion (manuellement,
  // sur la plateforme publicitaire concernée) — ne déclenche aucune action automatique.
  // reviewedAt (posé ici) sert de point de départ à OptimizerOutcomeService pour mesurer
  // l'impact réel 7 jours plus tard.
  @Post('optimizations/:id/apply')
  @Roles('MARKETING_MANAGER', 'ADMIN', 'OWNER')
  apply(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() _dto: ReviewRecommendationDto) {
    return this.optimizerService.apply(user.organizationId, id, { userId: user.userId, email: user.email });
  }

  @Post('optimizations/:id/dismiss')
  @Roles('MARKETING_MANAGER', 'ADMIN', 'OWNER')
  dismiss(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() _dto: ReviewRecommendationDto) {
    return this.optimizerService.dismiss(user.organizationId, id, { userId: user.userId, email: user.email });
  }

  // Déclenchement manuel de l'analyse, hors du cron nocturne — utile en test/démo pour ne
  // pas attendre 2h du matin. Restreint à ADMIN/OWNER car cela consomme des crédits IA.
  @Post('optimizer/run')
  @Roles('ADMIN', 'OWNER')
  // Consomme de vrais crédits IA à chaque appel (une analyse par campagne publiée) — une
  // limite dédiée évite qu'un script ou un clic répété n'épuise le quota de l'organisation.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async runNow(@CurrentUser() user: AuthUser) {
    const count = await this.aiOptimizerService.runForOrganization(user.organizationId);
    return { analyzedCampaigns: count };
  }

  // Fondation pour la phase ultérieure d'automatisation contrôlée — cf. AutomationService.
  // Renvoie un statut désactivé tant que ENABLE_CONTROLLED_AUTOMATION n'est pas activé.
  @Get('optimizer/automation-status')
  automationStatus() {
    return { enabled: this.automationService.isEnabled() };
  }

  @Get('optimizer/automation-eligible')
  automationEligible(@CurrentUser() user: AuthUser) {
    return this.automationService.listAutomationEligible(user.organizationId);
  }
}
