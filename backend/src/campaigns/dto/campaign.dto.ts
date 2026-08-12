import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  name: string;

  // Optionnel désormais : une photo produit (productImageAssetId) peut suffire à elle seule
  // ("une photo suffit", cf. page d'accueil) — CampaignsService.create() exige qu'au moins
  // l'un des deux (description ou photo) soit fourni.
  @IsOptional() @IsString()
  productDescription?: string;

  // Référence vers un Asset déjà téléversé via POST /assets/upload (jamais une URL externe
  // arbitraire — CampaignsService résout et vérifie l'appartenance à l'organisation avant
  // de transmettre l'URL réelle à l'analyse IA).
  @IsOptional() @IsString()
  productImageAssetId?: string;

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
