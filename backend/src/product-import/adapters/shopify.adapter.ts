import { Injectable, Logger } from '@nestjs/common';
import { EcommerceAdapter, StoreCredentials, NormalizedProduct } from './ecommerce-adapter.interface';

const API_VERSION = '2024-07';

// Adaptateur Shopify : utilise l'Admin API REST avec un token d'accès boutique
// (Custom App token, généré par le marchand dans son admin Shopify — pas d'OAuth
// applicatif complet nécessaire pour un usage single-store comme dans ce MVP;
// une app publique multi-marchands nécessiterait le flux OAuth complet Shopify).
@Injectable()
export class ShopifyAdapter implements EcommerceAdapter {
  readonly platform = 'SHOPIFY';
  private readonly logger = new Logger(ShopifyAdapter.name);

  private baseUrl(storeUrl: string): string {
    const cleanDomain = storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${cleanDomain}/admin/api/${API_VERSION}`;
  }

  async testConnection(credentials: StoreCredentials): Promise<boolean> {
    const res = await fetch(`${this.baseUrl(credentials.storeUrl)}/shop.json`, {
      headers: { 'X-Shopify-Access-Token': credentials.accessToken ?? '' },
    });
    return res.ok;
  }

  async fetchProducts(credentials: StoreCredentials, limit = 50): Promise<NormalizedProduct[]> {
    const res = await fetch(`${this.baseUrl(credentials.storeUrl)}/products.json?limit=${limit}`, {
      headers: { 'X-Shopify-Access-Token': credentials.accessToken ?? '' },
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`Échec de récupération du catalogue Shopify: ${errText}`);
      throw new Error(`Shopify API error: ${res.status} ${errText}`);
    }

    const data = await res.json();
    return (data.products ?? []).map((p: any) => this.normalize(p));
  }

  private normalize(product: any): NormalizedProduct {
    const firstVariant = product.variants?.[0];
    return {
      externalId: String(product.id),
      name: product.title,
      description: this.stripHtml(product.body_html),
      priceAmount: firstVariant ? parseFloat(firstVariant.price) : undefined,
      currency: 'EUR', // Shopify ne renvoie pas la devise sur /products.json — à récupérer via /shop.json et mettre en cache
      imageUrl: product.image?.src,
      raw: product,
    };
  }

  private stripHtml(html?: string): string | undefined {
    if (!html) return undefined;
    return html.replace(/<[^>]*>/g, '').trim();
  }
}
