import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  name: string;

  @IsString()
  productDescription: string;

  @IsString()
  objective: string;

  @IsNumber()
  @IsOptional()
  budget?: number;

  @IsArray()
  @IsOptional()
  channels?: string[]; // ex: ['facebook','instagram','tiktok'] — cf. SocialPlatform

  @IsString()
  @IsOptional()
  templateId?: string; // cf. CampaignTemplate — préremplit objectif/canaux et guide l'Orchestrator
}
