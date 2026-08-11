import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AssetsService } from './assets.service';
import { RegisterAssetDto } from './dto/content-studio.dto';

interface AuthUser {
  organizationId: string;
}

@Controller('assets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('type') type?: string, @Query('tag') tag?: string, @Query('limit') limit?: string) {
    return this.assetsService.list(user.organizationId, { type, tag, limit: limit ? parseInt(limit, 10) : undefined });
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assetsService.getById(user.organizationId, id);
  }

  // Upload réel — logo de marque, image produit, fichier de campagne. memoryStorage() garde
  // le fichier en RAM (buffer) plutôt que sur le disque local du conteneur, cohérent avec le
  // fait que StorageService peut aussi bien envoyer ce buffer vers S3/R2/GCS que vers le
  // disque local en mode dev — le controller ne connaît jamais la destination finale.
  @Post('upload')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }))
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('altText') altText?: string,
    @Body('tags') tags?: string,
  ) {
    return this.assetsService.uploadAndRegister(user.organizationId, file, {
      altText,
      tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
    });
  }

  // Enregistre un asset déjà hébergé ailleurs (URL externe) — distinct de POST /assets/upload,
  // qui reçoit les octets et les stocke réellement chez nous.
  @Post()
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  register(@CurrentUser() user: AuthUser, @Body() dto: RegisterAssetDto) {
    return this.assetsService.register({ organizationId: user.organizationId, source: 'UPLOADED', ...dto } as any);
  }

  @Patch(':id')
  @Roles('EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: { altText?: string; tags?: string[] }) {
    return this.assetsService.updateMetadata(user.organizationId, id, dto);
  }

  @Delete(':id')
  @Roles('MARKETING_MANAGER', 'ADMIN', 'OWNER')
  delete(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.assetsService.delete(user.organizationId, id);
  }
}
