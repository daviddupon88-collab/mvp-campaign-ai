import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BrandConsistencyService } from './brand-consistency.service';

@Controller('campaigns/:campaignId/brand-consistency')
@UseGuards(JwtAuthGuard)
export class BrandConsistencyController {
  constructor(private readonly brandConsistencyService: BrandConsistencyService) {}

  @Get()
  list(@CurrentUser() user: { organizationId: string }, @Param('campaignId') campaignId: string) {
    return this.brandConsistencyService.listChecksForCampaign(user.organizationId, campaignId);
  }
}
