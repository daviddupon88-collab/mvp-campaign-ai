import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ContentStudioService } from './content-studio.service';
import { EditContentDto, CreateVariationsDto, SelectVersionDto } from './dto/content-studio.dto';

interface AuthUser {
  userId: string;
  organizationId: string;
}

@Controller('campaigns/:campaignId/content')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContentStudioController {
  constructor(private readonly contentStudioService: ContentStudioService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('campaignId') campaignId: string) {
    return this.contentStudioService.listForCampaign(user.organizationId, campaignId);
  }

  @Get(':pieceId')
  getOne(@CurrentUser() user: AuthUser, @Param('pieceId') pieceId: string) {
    return this.contentStudioService.getById(user.organizationId, pieceId);
  }

  @Post(':pieceId/edit')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  edit(@CurrentUser() user: AuthUser, @Param('pieceId') pieceId: string, @Body() dto: EditContentDto) {
    return this.contentStudioService.editContent(user.organizationId, pieceId, { ...dto, createdByUserId: user.userId });
  }

  @Post(':pieceId/variations')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  createVariations(@CurrentUser() user: AuthUser, @Param('pieceId') pieceId: string, @Body() dto: CreateVariationsDto) {
    const variations = dto.variations.map((v) => ({ ...v, createdByUserId: user.userId }));
    return this.contentStudioService.createVariations(user.organizationId, pieceId, variations);
  }

  @Post(':pieceId/select-version')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  selectVersion(@CurrentUser() user: AuthUser, @Param('pieceId') pieceId: string, @Body() dto: SelectVersionDto) {
    return this.contentStudioService.selectVariationAsCurrent(user.organizationId, pieceId, dto.versionId);
  }

  @Post(':pieceId/archive')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  archive(@CurrentUser() user: AuthUser, @Param('pieceId') pieceId: string) {
    return this.contentStudioService.archive(user.organizationId, pieceId);
  }
}
