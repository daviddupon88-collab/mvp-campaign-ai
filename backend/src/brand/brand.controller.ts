import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BrandService } from './brand.service';
import { UpsertBrandKitDto } from './dto/brand-kit.dto';

@Controller('brand-kit')
@UseGuards(JwtAuthGuard)
export class BrandController {
  constructor(private readonly brandService: BrandService) {}

  @Get()
  get(@CurrentUser() user: { organizationId: string }) {
    return this.brandService.get(user.organizationId);
  }

  @Put()
  upsert(@CurrentUser() user: { organizationId: string }, @Body() dto: UpsertBrandKitDto) {
    return this.brandService.upsert(user.organizationId, dto);
  }

  // Journal de mémoire du Brand Brain — ce que la marque a appris au fil des campagnes,
  // consulté par les équipes marketing pour comprendre pourquoi une génération a pris
  // telle orientation, sans avoir à interroger directement la base de données.
  @Get('memory')
  getMemory(@CurrentUser() user: { organizationId: string }, @Query('limit') limit?: string) {
    return this.brandService.listMemory(user.organizationId, limit ? parseInt(limit, 10) : undefined);
  }
}
