import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';

// Miroir exact de SUPPORTED_LOCALES côté frontend (frontend/src/i18n/config.ts) — la
// préférence de langue de l'interface, indépendante de la langue de génération d'une campagne.
export const SUPPORTED_LOCALES = ['en', 'de', 'fr', 'ar'] as const;

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  fullName: string;

  @IsString()
  organizationName: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

export class UpdateLanguageDto {
  @IsIn(SUPPORTED_LOCALES)
  preferredLanguage: (typeof SUPPORTED_LOCALES)[number];
}
