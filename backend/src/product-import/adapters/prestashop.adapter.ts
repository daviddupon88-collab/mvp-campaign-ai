import { Injectable, Logger } from '@nestjs/common';
import { EcommerceAdapter, StoreCredentials, NormalizedProduct } from './ecommerce-adapter.interface';

// Adaptateur Prestashop : le Webservice Prestashop utilise une clé API en Basic Auth
// (username = clé API, password vide) et renvoie du XML par défaut — on force le JSON
// via le paramètre output_format pour rester cohérent avec les autres adaptateurs.
@Injectable()
export class PrestashopAdapter implements EcommerceAdapter {
  readonly platform = 'PRESTASHOP';
  private readonly logger = new Logger(PrestashopAdapter.name);

  private authHeader(credentials: StoreCredentials): string {
    return 'Basic ' + Buffer.from(`${credentials.apiKey}:`).toString('base64');
  }

  private buildUrl(storeUrl: string, path: string): string {
    const cleanDomain = storeUrl.replace(/\/$/, '');
    return `${cleanDomain}/api/${path}?output_format=JSON`;
  }

  async testConnection(credentials: StoreCredentials): Promise<boolean> {
    const res = await fetch(this.buildUrl(credentials.storeUrl, 'products') + '&limit=1', {
      headers: { Authorization: this.authHeader(credentials) },
    });
    return res.ok;
  }

  async fetchProducts(credentials: StoreCredentials, limit = 50): Promise<NormalizedProduct[]> {
    // Étape 1 : liste des IDs produits (l'API Prestashop liste puis détaille par ressource).
    const listRes = await fetch(
      this.buildUrl(credentials.storeUrl, 'products') + `&limit=${limit}&display=full`,
      { headers: { Authorization: this.authHeader(credentials) } },
    );

    if (!listRes.ok) {
      const errText = await listRes.text();
      this.logger.error(`Échec de récupération du catalogue Prestashop: ${errText}`);
      throw new Error(`Prestashop API error: ${listRes.status} ${errText}`);
    }

    const data = await listRes.json();
    const products = data.products ?? [];

    return products.map((p: any) => ({
      externalId: String(p.id),
      name: this.extractLangValue(p.name),
      description: this.stripHtml(this.extractLangValue(p.description_short)),
      priceAmount: p.price ? parseFloat(p.price) : undefined,
      currency: undefined,
      imageUrl: undefined, // l'image nécessite un appel séparé à /api/images/products/{id} — omis pour rester synchrone
      raw: p,
    }));
  }

  // Prestashop renvoie les champs multilingues sous forme de tableau {id, value} ou une simple string.
  private extractLangValue(field: any): string {
    if (typeof field === 'string') return field;
    if (Array.isArray(field)) return field[0]?.value ?? '';
    return field?.value ?? '';
  }

  private stripHtml(html?: string): string | undefined {
    if (!html) return undefined;
    return html.replace(/<[^>]*>/g, '').trim();
  }
}
