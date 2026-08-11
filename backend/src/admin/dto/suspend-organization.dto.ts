import { IsString, MinLength } from 'class-validator';

export class SuspendOrganizationDto {
  @IsString()
  @MinLength(5, { message: 'Merci de préciser un motif de suspension (5 caractères minimum) — action tracée dans la piste d\'audit' })
  reason: string;
}
