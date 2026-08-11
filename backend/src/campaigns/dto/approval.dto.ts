import { IsString, MinLength } from 'class-validator';

export class RejectCampaignDto {
  @IsString()
  @MinLength(5, { message: 'Merci de préciser une raison de rejet (5 caractères minimum)' })
  reason: string;
}
