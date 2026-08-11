import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditService } from './audit.service';

interface AuthUser {
  organizationId: string;
}

// Réservé ADMIN/OWNER : la piste d'audit expose qui a fait quoi, information sensible
// (identité, adresses IP) qui ne doit pas être visible par tous les membres de l'organisation.
@Controller('audit-log')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Roles('ADMIN', 'OWNER')
  list(
    @CurrentUser() user: AuthUser,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditService.listForOrganization(user.organizationId, {
      action,
      resourceType,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
