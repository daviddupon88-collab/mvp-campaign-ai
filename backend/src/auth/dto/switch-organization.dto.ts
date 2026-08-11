import { IsString } from 'class-validator';

export class SwitchOrganizationDto {
  @IsString()
  organizationId: string;
}
