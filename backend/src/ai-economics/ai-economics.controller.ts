import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiEconomicsService } from './ai-economics.service';

interface AuthUser {
  organizationId: string;
}

@Controller('ai-usage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AiEconomicsController {
  constructor(private readonly aiEconomicsService: AiEconomicsService) {}

  @Get('summary')
  getSummary(@CurrentUser() user: AuthUser) {
    return this.aiEconomicsService.getUsageSummary(user.organizationId);
  }

  // Donnée sensible (rapproche revenu et coût réel) — réservée aux rôles d'administration.
  @Get('margin')
  @Roles('ADMIN', 'OWNER')
  getMargin(@CurrentUser() user: AuthUser) {
    return this.aiEconomicsService.getMarginSummary(user.organizationId);
  }

  @Get('generations')
  listGenerations(
    @CurrentUser() user: AuthUser,
    @Query('campaignId') campaignId?: string,
    @Query('purpose') purpose?: string,
    @Query('limit') limit?: string,
  ) {
    return this.aiEconomicsService.listGenerations(user.organizationId, {
      campaignId,
      purpose,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
