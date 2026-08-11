import { IsIn, IsOptional, IsString } from 'class-validator';

export class ConnectStoreDto {
  @IsIn(['SHOPIFY', 'WOOCOMMERCE', 'PRESTASHOP'])
  platform: 'SHOPIFY' | 'WOOCOMMERCE' | 'PRESTASHOP';

  @IsString()
  storeUrl: string;

  @IsOptional() @IsString()
  accessToken?: string; // Shopify

  @IsOptional() @IsString()
  apiKey?: string; // WooCommerce (consumer key) / Prestashop

  @IsOptional() @IsString()
  apiSecret?: string; // WooCommerce (consumer secret)
}
