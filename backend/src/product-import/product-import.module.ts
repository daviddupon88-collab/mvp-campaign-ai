import { Module } from '@nestjs/common';
import { ProductImportService } from './product-import.service';
import { ProductImportController } from './product-import.controller';
import { ShopifyAdapter } from './adapters/shopify.adapter';
import { WooCommerceAdapter } from './adapters/woocommerce.adapter';
import { PrestashopAdapter } from './adapters/prestashop.adapter';

@Module({
  controllers: [ProductImportController],
  providers: [ProductImportService, ShopifyAdapter, WooCommerceAdapter, PrestashopAdapter],
  exports: [ProductImportService],
})
export class ProductImportModule {}
