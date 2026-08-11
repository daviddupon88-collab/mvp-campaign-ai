import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import { RecordConversionDto } from './dto/record-conversion.dto';

interface AuthUser {
  organizationId: string;
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('analytics/overview')
  overview(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.analyticsService.getOrganizationOverview(user.organizationId, limit ? parseInt(limit, 10) : undefined);
  }

  @Get('campaigns/:campaignId/analytics/summary')
  summary(@CurrentUser() user: AuthUser, @Param('campaignId') campaignId: string) {
    return this.analyticsService.getCampaignSummary(user.organizationId, campaignId);
  }

  @Get('campaigns/:campaignId/analytics/channels')
  channels(@CurrentUser() user: AuthUser, @Param('campaignId') campaignId: string) {
    return this.analyticsService.getChannelBreakdown(user.organizationId, campaignId);
  }

  @Get('campaigns/:campaignId/analytics/content')
  content(@CurrentUser() user: AuthUser, @Param('campaignId') campaignId: string) {
    return this.analyticsService.getContentBreakdown(user.organizationId, campaignId);
  }

  // Enregistrement manuel de conversion — cf. note dans AnalyticsIngestionService sur
  // l'absence d'intégration Conversions API dédiée par plateforme.
  @Post('campaigns/:campaignId/analytics/conversions')
  @Roles('MARKETING_MANAGER', 'ADMIN', 'OWNER')
  recordConversion(@CurrentUser() user: AuthUser, @Param('campaignId') campaignId: string, @Body() dto: RecordConversionDto) {
    return this.analyticsService.recordManualConversion(user.organizationId, campaignId, dto);
  }
}
