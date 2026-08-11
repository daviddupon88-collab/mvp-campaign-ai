import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { HelpService } from './help.service';
import { CreateHelpArticleDto, UpdateHelpArticleDto } from './dto/help-article.dto';

@Controller('help')
export class HelpController {
  constructor(private readonly helpService: HelpService) {}

  // Public — un centre d'aide non consultable sans compte serait de peu d'utilité pour
  // un prospect qui évalue le produit avant de s'inscrire.
  @Get('articles')
  list(@Query('category') category?: string) {
    return this.helpService.listPublished(category);
  }

  @Get('articles/search')
  search(@Query('q') query: string) {
    return this.helpService.search(query ?? '');
  }

  @Get('articles/:slug')
  getOne(@Param('slug') slug: string) {
    return this.helpService.getBySlug(slug);
  }

  // --- Administration du contenu (équipe Campaign-ai) ---

  @Get('staff/articles')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  listAllForStaff() {
    return this.helpService.listAllForStaff();
  }

  @Post('staff/articles')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  create(@Body() dto: CreateHelpArticleDto) {
    return this.helpService.create(dto);
  }

  @Patch('staff/articles/:id')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  update(@Param('id') id: string, @Body() dto: UpdateHelpArticleDto) {
    return this.helpService.update(id, dto);
  }

  @Delete('staff/articles/:id')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  delete(@Param('id') id: string) {
    return this.helpService.delete(id);
  }
}
