import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class EditContentDto {
  @IsOptional() @IsString()
  body?: string;

  @IsOptional() @IsString()
  assetId?: string;

  @IsOptional() @IsString()
  changeNote?: string;
}

export class VariationInputDto {
  @IsString()
  label: string;

  @IsOptional() @IsString()
  body?: string;

  @IsOptional() @IsString()
  assetId?: string;
}

export class CreateVariationsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariationInputDto)
  variations: VariationInputDto[];
}

export class SelectVersionDto {
  @IsString()
  versionId: string;
}

export class RegisterAssetDto {
  @IsIn(['IMAGE', 'VIDEO', 'DOCUMENT'])
  type: string;

  @IsString()
  url: string;

  @IsOptional() @IsString()
  fileName?: string;

  @IsOptional() @IsString()
  mimeType?: string;

  @IsOptional() @IsString()
  altText?: string;

  @IsOptional() @IsArray()
  tags?: string[];
}
