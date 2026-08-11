import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class PublishTargetDto {
  @IsString()
  socialConnectionId: string;

  @IsOptional() @IsString()
  caption?: string;

  @IsOptional() @IsString()
  mediaUrl?: string;

  @IsOptional() @IsString()
  linkUrl?: string;

  @IsOptional() @IsString()
  contentVersionId?: string;
}

export class PublishCampaignDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublishTargetDto)
  targets: PublishTargetDto[];
}
