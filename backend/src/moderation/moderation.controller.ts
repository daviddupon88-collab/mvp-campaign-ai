import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ModerationService } from './moderation.service';

@Controller('campaigns/:campaignId/moderation')
@UseGuards(JwtAuthGuard)
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  // Consulté par l'écran de validation humaine avant d'approuver ou rejeter une campagne.
  @Get()
  list(@CurrentUser() user: { organizationId: string }, @Param('campaignId') campaignId: string) {
    return this.moderationService.listChecksForCampaign(user.organizationId, campaignId);
  }
}
