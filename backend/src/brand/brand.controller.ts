import { Body, Controller, Get, Param, Post, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BrandService } from './brand.service';
import { BrandLearningService } from './brand-learning.service';
import { ContradictionService } from './contradiction.service';
import { BrandBriefService } from './brand-brief.service';
import { UpsertBrandKitDto } from './dto/brand-kit.dto';
import { PromoteToRuleDto, CorrectMemoryEntryDto, ResolveContradictionDto } from './dto/brand-memory.dto';
import { BrandMemoryCategory, BrandMemoryStatus, BrandMemoryType } from '@prisma/client';

interface AuthUser {
  userId: string;
  organizationId: string;
}

// Toute mutation (confirm/dismiss/promote/correct/resolve) exige au moins EDITOR — mêmes
// rôles que les mutations de contenu dans ContentStudioController, cohérent avec le reste
// de la plateforme : une décision sur la mémoire de marque n'est pas un geste anodin.
const MUTATION_ROLES = ['EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER'] as const;

@Controller('brand-kit')
@UseGuards(JwtAuthGuard)
export class BrandController {
  constructor(
    private readonly brandService: BrandService,
    private readonly brandLearning: BrandLearningService,
    private readonly contradictions: ContradictionService,
    private readonly brief: BrandBriefService,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.brandService.get(user.organizationId);
  }

  @Put()
  upsert(@CurrentUser() user: AuthUser, @Body() dto: UpsertBrandKitDto) {
    return this.brandService.upsert(user.organizationId, dto);
  }

  // Résumé dynamique (Phase 12) — jamais codé en dur, généré à partir des données réelles.
  @Get('brief')
  getBrief(@CurrentUser() user: AuthUser) {
    return this.brief.buildSummary(user.organizationId);
  }

  // Journal de mémoire du Brand Brain — ce que la marque a appris au fil des campagnes,
  // consulté par les équipes marketing pour comprendre pourquoi une génération a pris
  // telle orientation, sans avoir à interroger directement la base de données.
  @Get('memory')
  getMemory(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
    @Query('type') type?: BrandMemoryType,
    @Query('category') category?: BrandMemoryCategory,
    @Query('channel') channel?: string,
    @Query('persona') persona?: string,
    @Query('status') status?: BrandMemoryStatus,
  ) {
    return this.brandService.listMemory(user.organizationId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      type,
      category,
      channel,
      persona,
      status,
    });
  }

  @Get('memory/rules')
  getRules(@CurrentUser() user: AuthUser) {
    return this.brandService.listRules(user.organizationId);
  }

  @Get('memory/contradictions')
  getContradictions(@CurrentUser() user: AuthUser, @Query('status') status?: 'UNRESOLVED' | 'RESOLVED_A' | 'RESOLVED_B' | 'CONTEXT_DEPENDENT') {
    return this.contradictions.listContradictions(user.organizationId, status);
  }

  @Post('memory/:id/confirm')
  @UseGuards(RolesGuard)
  @Roles(...MUTATION_ROLES)
  confirmMemory(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.brandLearning.confirmEntry(user.organizationId, id);
  }

  @Post('memory/:id/dismiss')
  @UseGuards(RolesGuard)
  @Roles(...MUTATION_ROLES)
  dismissMemory(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.brandLearning.dismissEntry(user.organizationId, id);
  }

  @Post('memory/:id/promote-to-rule')
  @UseGuards(RolesGuard)
  @Roles(...MUTATION_ROLES)
  promoteToRule(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PromoteToRuleDto) {
    return this.brandLearning.promoteToRule(user.organizationId, id, dto.forbiddenTerms);
  }

  @Patch('memory/:id')
  @UseGuards(RolesGuard)
  @Roles(...MUTATION_ROLES)
  correctMemory(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CorrectMemoryEntryDto) {
    return this.brandLearning.correctEntry(user.organizationId, id, dto);
  }

  @Post('contradictions/:id/resolve')
  @UseGuards(RolesGuard)
  @Roles(...MUTATION_ROLES)
  resolveContradiction(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ResolveContradictionDto) {
    return this.contradictions.resolve(user.organizationId, id, dto.resolution, user.userId);
  }
}
