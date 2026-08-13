import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateMetaCapiConfigDto {
  @IsString()
  @MinLength(1)
  pixelId: string;

  // Token d'accès CAPI généré manuellement dans Meta Events Manager — pas obtenable via le
  // flux OAuth existant (cf. meta-capi.service.ts). Jamais renvoyé en clair par GET.
  @IsString()
  @MinLength(1)
  accessToken: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
