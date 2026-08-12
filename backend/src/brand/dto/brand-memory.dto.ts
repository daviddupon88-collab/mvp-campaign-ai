import { IsArray, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { BrandMemoryCategory, BrandMemoryScope } from '@prisma/client';

export class PromoteToRuleDto {
  // Termes explicitement interdits (cf. BrandRuleGuardService, Lot D) — sans ça, la RULE
  // reste appliquée uniquement au niveau du prompt de génération, jamais bloquée par du code.
  @IsOptional() @IsArray() @IsString({ each: true }) forbiddenTerms?: string[];
}

export class CorrectMemoryEntryDto {
  @IsOptional() @IsString() content?: string;
  @IsOptional() @IsEnum(BrandMemoryCategory) category?: BrandMemoryCategory;
  @IsOptional() @IsEnum(BrandMemoryScope) scope?: BrandMemoryScope;
  @IsOptional() @IsString() channel?: string;
  @IsOptional() @IsString() persona?: string;
  @IsOptional() @IsString() contentType?: string;
}

export class ResolveContradictionDto {
  @IsIn(['RESOLVED_A', 'RESOLVED_B', 'CONTEXT_DEPENDENT'])
  resolution!: 'RESOLVED_A' | 'RESOLVED_B' | 'CONTEXT_DEPENDENT';
}
