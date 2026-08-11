import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TeamsService } from './teams.service';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly teamsService: TeamsService) {}

  // Public (pas de JWT) : la page d'acceptation doit pouvoir afficher "Vous êtes invité(e)
  // à rejoindre {organisation}" avant même que la personne se connecte ou s'inscrive.
  @Get(':token')
  preview(@Param('token') token: string) {
    return this.teamsService.getInvitationPreview(token);
  }

  // Authentifié : la personne doit s'être inscrite/connectée avec l'email invité au préalable.
  @Post(':token/accept')
  @UseGuards(JwtAuthGuard)
  accept(@CurrentUser() user: { userId: string; email: string }, @Param('token') token: string) {
    return this.teamsService.acceptInvitation(token, user);
  }
}
