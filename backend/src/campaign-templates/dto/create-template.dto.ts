import { IsArray, IsIn, IsObject, IsOptional, IsString } from 'class-validator';

const SECTORS = ['ECOMMERCE', 'SAAS_B2B', 'RESTAURANT_LOCAL', 'FITNESS_WELLNESS', 'REAL_ESTATE', 'EVENT', 'GENERAL'];

export class CreateTemplateDto {
  @IsString()
  name: string;

  @IsIn(SECTORS)
  sector: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  defaultObjective?: string;

  @IsOptional() @IsArray()
  defaultChannels?: string[];

  @IsOptional() @IsString()
  toneHint?: string;

  @IsOptional() @IsObject()
  structureHint?: Record<string, string>;
}

export class CreateTemplateFromCampaignDto {
  @IsString()
  name: string;
}
