import { IsDateString, IsString } from 'class-validator';

export class ScheduleContentDto {
  @IsString()
  contentPieceId: string;

  @IsString()
  socialConnectionId: string;

  @IsDateString()
  scheduledAt: string;
}
