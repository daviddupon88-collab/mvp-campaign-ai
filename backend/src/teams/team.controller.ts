import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestMeta } from '../common/decorators/request-meta.decorator';
import { AuditService } from '../audit/audit.service';
import { TeamsService } from './teams.service';
import { InviteMemberDto, ChangeRoleDto } from './dto/team.dto';

interface AuthUser {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
}

interface Meta {
  ipAddress?: string;
  userAgent?: string;
}

@Controller('team')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TeamController {
  constructor(
    private readonly teamsService: TeamsService,
    private readonly auditService: AuditService,
  ) {}

  @Get('members')
  listMembers(@CurrentUser() user: AuthUser) {
    return this.teamsService.listMembers(user.organizationId);
  }

  @Get('invitations')
  listInvitations(@CurrentUser() user: AuthUser) {
    return this.teamsService.listInvitations(user.organizationId);
  }

  @Post('invitations')
  @Roles('ADMIN', 'OWNER')
  async invite(@CurrentUser() user: AuthUser, @Body() dto: InviteMemberDto, @RequestMeta() meta: Meta) {
    const invitation = await this.teamsService.invite(user.organizationId, user, dto.email, dto.role);
    await this.auditService.record('team.member_invited', 'Invitation', invitation.id, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta }, { invitedEmail: dto.email, role: dto.role });
    return invitation;
  }

  @Post('invitations/:id/revoke')
  @Roles('ADMIN', 'OWNER')
  revokeInvitation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.teamsService.revokeInvitation(user.organizationId, id);
  }

  @Post('invitations/:id/resend')
  @Roles('ADMIN', 'OWNER')
  resendInvitation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.teamsService.resendInvitation(user.organizationId, id);
  }

  // Changement de rôle : action à privilège, toujours tracée (qui a promu/rétrogradé qui,
  // vers quel rôle) — nécessaire pour investiguer un abus de droits a posteriori.
  @Patch('members/:membershipId/role')
  @Roles('ADMIN', 'OWNER')
  async changeRole(@CurrentUser() user: AuthUser, @Param('membershipId') membershipId: string, @Body() dto: ChangeRoleDto, @RequestMeta() meta: Meta) {
    const result = await this.teamsService.changeRole(user.organizationId, user, membershipId, dto.role);
    await this.auditService.record('team.role_changed', 'Membership', membershipId, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta }, { newRole: dto.role });
    return result;
  }

  @Delete('members/:membershipId')
  @Roles('ADMIN', 'OWNER')
  async removeMember(@CurrentUser() user: AuthUser, @Param('membershipId') membershipId: string, @RequestMeta() meta: Meta) {
    const result = await this.teamsService.removeMember(user.organizationId, user, membershipId);
    await this.auditService.record('team.member_removed', 'Membership', membershipId, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta });
    return result;
  }
}
