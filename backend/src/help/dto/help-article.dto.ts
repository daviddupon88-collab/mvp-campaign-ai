import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class CreateHelpArticleDto {
  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug doit être en minuscules, chiffres et tirets uniquement' })
  slug: string;

  @IsString()
  title: string;

  @IsString()
  body: string;

  @IsOptional()
  @IsString()
  category?: string;
}

export class UpdateHelpArticleDto {
  @IsOptional() @IsString()
  title?: string;

  @IsOptional() @IsString()
  body?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsBoolean()
  published?: boolean;
}
