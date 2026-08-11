import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { SuspendOrganizationDto } from './dto/suspend-organization.dto';

interface AuthUser {
  email: string;
}

// Chaque route est protégée par PlatformAdminGuard, jamais RolesGuard — c'est le seul
// controller de toute l'API dont l'accès ne dépend d'aucune appartenance à une organisation.
@Controller('admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('organizations')
  listOrganizations(
    @Query('search') search?: string,
    @Query('plan') plan?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.adminService.listOrganizations({
      search,
      plan,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('organizations/:id')
  getOrganization(@Param('id') id: string) {
    return this.adminService.getOrganizationDetail(id);
  }

  @Post('organizations/:id/suspend')
  suspendOrganization(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SuspendOrganizationDto) {
    return this.adminService.suspendOrganization(id, dto.reason, user.email);
  }

  @Post('organizations/:id/reactivate')
  reactivateOrganization(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.adminService.reactivateOrganization(id, user.email);
  }

  @Get('users')
  listUsers(@Query('search') search?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.adminService.listUsers({
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('subscriptions/overview')
  getSubscriptionsOverview() {
    return this.adminService.getSubscriptionsOverview();
  }

  @Get('ai-costs/overview')
  getAiCostsOverview() {
    return this.adminService.getAiCostsOverview();
  }

  @Get('errors')
  getRecentErrors(@Query('limit') limit?: string) {
    return this.adminService.getRecentErrors(limit ? parseInt(limit, 10) : undefined);
  }

  @Get('activity')
  getActivityFeed(@Query('organizationId') organizationId?: string, @Query('action') action?: string, @Query('limit') limit?: string) {
    return this.adminService.getActivityFeed({
      organizationId,
      action,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
