import { IsIn, IsOptional, IsString, IsUrl } from 'class-validator';

export class ConnectStoreDto {
  @IsIn(['SHOPIFY', 'WOOCOMMERCE', 'PRESTASHOP'])
  platform: 'SHOPIFY' | 'WOOCOMMERCE' | 'PRESTASHOP';

  // Rejet de format immédiat (defense in depth) ; la vraie protection SSRF — résolution DNS
  // et blocage des plages privées/internes, revérifiée à chaque appel sortant — vit dans
  // store-url-guard.ts (cf. ProductImportService.connectStore/syncCatalog).
  @IsUrl({ protocols: ['https'], require_protocol: true })
  storeUrl: string;

  @IsOptional() @IsString()
  accessToken?: string; // Shopify

  @IsOptional() @IsString()
  apiKey?: string; // WooCommerce (consumer key) / Prestashop

  @IsOptional() @IsString()
  apiSecret?: string; // WooCommerce (consumer secret)
}
