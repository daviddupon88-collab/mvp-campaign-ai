import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MetaCapiConfigService } from './meta-capi-config.service';
import { UpdateMetaCapiConfigDto } from './dto/update-meta-capi-config.dto';

interface AuthUser {
  organizationId: string;
}

@Controller('integrations/meta-capi')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MetaCapiConfigController {
  constructor(private readonly metaCapiConfig: MetaCapiConfigService) {}

  @Get()
  getStatus(@CurrentUser() user: AuthUser) {
    return this.metaCapiConfig.getStatus(user.organizationId);
  }

  @Put()
  @Roles('ADMIN', 'OWNER')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateMetaCapiConfigDto) {
    return this.metaCapiConfig.update(user.organizationId, dto);
  }
}
