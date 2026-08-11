import { Injectable, Logger } from '@nestjs/common';
import { EcommerceAdapter, StoreCredentials, NormalizedProduct } from './ecommerce-adapter.interface';

// Adaptateur WooCommerce : authentification par clé/secret API (Consumer Key / Consumer Secret),
// générés dans WooCommerce > Réglages > Avancé > REST API. Auth via Basic Auth sur HTTPS.
@Injectable()
export class WooCommerceAdapter implements EcommerceAdapter {
  readonly platform = 'WOOCOMMERCE';
  private readonly logger = new Logger(WooCommerceAdapter.name);

  private buildUrl(storeUrl: string, path: string, credentials: StoreCredentials): string {
    const cleanDomain = storeUrl.replace(/\/$/, '');
    const params = new URLSearchParams({
      consumer_key: credentials.apiKey ?? '',
      consumer_secret: credentials.apiSecret ?? '',
    });
    return `${cleanDomain}/wp-json/wc/v3/${path}?${params.toString()}`;
  }

  async testConnection(credentials: StoreCredentials): Promise<boolean> {
    const res = await fetch(this.buildUrl(credentials.storeUrl, 'products', credentials) + '&per_page=1');
    return res.ok;
  }

  async fetchProducts(credentials: StoreCredentials, limit = 50): Promise<NormalizedProduct[]> {
    const url = this.buildUrl(credentials.storeUrl, 'products', credentials) + `&per_page=${limit}`;
    const res = await fetch(url);

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error(`Échec de récupération du catalogue WooCommerce: ${errText}`);
      throw new Error(`WooCommerce API error: ${res.status} ${errText}`);
    }

    const products = await res.json();
    return products.map((p: any) => ({
      externalId: String(p.id),
      name: p.name,
      description: this.stripHtml(p.short_description || p.description),
      priceAmount: p.price ? parseFloat(p.price) : undefined,
      currency: undefined, // à récupérer via /wp-json/wc/v3/settings/general si besoin précis
      imageUrl: p.images?.[0]?.src,
      raw: p,
    }));
  }

  private stripHtml(html?: string): string | undefined {
    if (!html) return undefined;
    return html.replace(/<[^>]*>/g, '').trim();
  }
}
