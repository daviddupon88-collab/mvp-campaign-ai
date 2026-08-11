import { IsEmail, IsIn, IsString } from 'class-validator';

const INVITABLE_ROLES = ['ADMIN', 'MARKETING_MANAGER', 'EDITOR', 'VIEWER']; // OWNER ne s'invite jamais, cf. TeamsService

export class InviteMemberDto {
  @IsEmail()
  email: string;

  @IsIn(INVITABLE_ROLES)
  role: string;
}

export class ChangeRoleDto {
  @IsIn(INVITABLE_ROLES)
  role: string;
}
