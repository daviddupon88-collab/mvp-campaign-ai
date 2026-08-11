import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('me')
  getMyOrganization(@CurrentUser() user: { organizationId: string }) {
    return this.organizationsService.getById(user.organizationId);
  }

  // Crée une organisation supplémentaire pour l'utilisateur courant (ex: une agence qui
  // ajoute un nouveau client) et retourne un JWT déjà scopé dessus.
  @Post()
  createAdditional(
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizationsService.createAdditional(user.userId, user.email, dto.name);
  }
}
