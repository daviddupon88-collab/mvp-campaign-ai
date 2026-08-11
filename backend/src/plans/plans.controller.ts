import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EntitlementsService } from './entitlements.service';

@Controller('plans')
export class PlansController {
  constructor(private readonly entitlementsService: EntitlementsService) {}

  // Public : alimente la page de tarifs sans nécessiter d'authentification.
  @Get()
  listPlans() {
    return this.entitlementsService.listAvailablePlans();
  }

  @Get('usage')
  @UseGuards(JwtAuthGuard)
  getUsage(@CurrentUser() user: { organizationId: string }) {
    return this.entitlementsService.getUsageSummary(user.organizationId);
  }
}
