import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CampaignTemplatesService } from './campaign-templates.service';
import { CreateTemplateDto, CreateTemplateFromCampaignDto } from './dto/create-template.dto';

@Controller('templates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CampaignTemplatesController {
  constructor(private readonly templatesService: CampaignTemplatesService) {}

  @Get()
  list(@CurrentUser() user: { organizationId: string }, @Query('sector') sector?: string) {
    return this.templatesService.list(user.organizationId, sector);
  }

  @Get(':id')
  getOne(@CurrentUser() user: { organizationId: string }, @Param('id') id: string) {
    return this.templatesService.getById(user.organizationId, id);
  }

  @Post()
  @Roles('MARKETING_MANAGER', 'ADMIN', 'OWNER')
  create(@CurrentUser() user: { organizationId: string }, @Body() dto: CreateTemplateDto) {
    return this.templatesService.create(user.organizationId, dto);
  }

  @Post('from-campaign/:campaignId')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  createFromCampaign(
    @CurrentUser() user: { organizationId: string },
    @Param('campaignId') campaignId: string,
    @Body() dto: CreateTemplateFromCampaignDto,
  ) {
    return this.templatesService.createFromCampaign(user.organizationId, campaignId, dto.name);
  }
}
