import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class RecordConversionDto {
  @IsInt()
  @Min(1)
  count: number;

  @IsNumber()
  @Min(0)
  value: number; // valeur totale attribuée (revenu), en devise de l'organisation

  @IsOptional()
  @IsString()
  note?: string;
}
