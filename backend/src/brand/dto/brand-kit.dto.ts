import { IsOptional, IsString } from 'class-validator';

export class UpsertBrandKitDto {
  @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() colorPalette?: Record<string, string>;
  @IsOptional() typography?: Record<string, string>;
  @IsOptional() @IsString() toneOfVoice?: string;
  @IsOptional() valueProps?: string[];
  @IsOptional() @IsString() mission?: string;
  @IsOptional() @IsString() vision?: string;
  @IsOptional() slogans?: string[];
  @IsOptional() competitors?: Array<{ name: string; notes?: string }>;
  @IsOptional() personaNotes?: Array<{ name: string; description?: string }>;
}
