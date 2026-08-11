import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { TeamsService } from './teams.service';
import { TeamController } from './team.controller';
import { InvitationsController } from './invitations.controller';

@Module({
  imports: [PlansModule],
  providers: [TeamsService],
  controllers: [TeamController, InvitationsController],
  exports: [TeamsService],
})
export class TeamsModule {}
