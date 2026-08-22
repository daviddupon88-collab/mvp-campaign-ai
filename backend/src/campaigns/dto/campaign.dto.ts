import { IsString, IsOptional, IsNumber, IsArray, IsUrl, MaxLength } from 'class-validator';

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

  // Mission 4.4 (Product URL Intelligence) — contrairement à productImageAssetId, c'est bien une
  // URL EXTERNE arbitraire (page produit publique) : validation syntaxique ici, protection SSRF
  // complète (résolution DNS + blocage d'adresses privées) appliquée plus tard dans le pipeline
  // (product-page-url-validator.ts, avant tout fetch réel) — jamais au niveau du DTO, qui ne fait
  // aucun accès réseau. Optionnelle : une campagne reste constructible sans elle.
  @IsOptional() @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(2048)
  productUrl?: string;

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
