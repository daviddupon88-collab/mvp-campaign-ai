import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCryptoService } from '../common/crypto/token-crypto.service';
import { ShopifyAdapter } from './adapters/shopify.adapter';
import { WooCommerceAdapter } from './adapters/woocommerce.adapter';
import { PrestashopAdapter } from './adapters/prestashop.adapter';
import { EcommerceAdapter } from './adapters/ecommerce-adapter.interface';
import { assertPublicStoreUrl } from './store-url-guard';

export interface ConnectStoreParams {
  organizationId: string;
  platform: 'SHOPIFY' | 'WOOCOMMERCE' | 'PRESTASHOP';
  storeUrl: string;
  accessToken?: string;
  apiKey?: string;
  apiSecret?: string;
}

// Module 3 — Product Intelligence : "L'utilisateur pourra envoyer... une boutique Shopify,
// Amazon, WooCommerce, Prestashop". Ce service gère la connexion et l'import du catalogue ;
// l'analyse IA de chaque produit importé reste déléguée à l'AI Orchestrator existant.
@Injectable()
export class ProductImportService {
  private readonly adapters: Record<string, EcommerceAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCrypto: TokenCryptoService,
    shopifyAdapter: ShopifyAdapter,
    wooCommerceAdapter: WooCommerceAdapter,
    prestashopAdapter: PrestashopAdapter,
  ) {
    this.adapters = {
      SHOPIFY: shopifyAdapter,
      WOOCOMMERCE: wooCommerceAdapter,
      PRESTASHOP: prestashopAdapter,
    };
  }

  private getAdapter(platform: string): EcommerceAdapter {
    const adapter = this.adapters[platform];
    if (!adapter) throw new BadRequestException(`Plateforme e-commerce non supportée: ${platform}`);
    return adapter;
  }

  // Teste les identifiants puis crée la connexion boutique si valides — évite de stocker
  // des identifiants invalides et d'échouer silencieusement plus tard lors d'un import.
  async connectStore(params: ConnectStoreParams) {
    await assertPublicStoreUrl(params.storeUrl);
    const adapter = this.getAdapter(params.platform);
    const credentials = {
      storeUrl: params.storeUrl,
      accessToken: params.accessToken,
      apiKey: params.apiKey,
      apiSecret: params.apiSecret,
    };

    const isValid = await adapter.testConnection(credentials);
    if (!isValid) throw new BadRequestException('Connexion à la boutique impossible — vérifiez les identifiants');

    // Chiffrés au repos au même titre que les tokens OAuth sociaux (cf. TokenCryptoService) :
    // ce sont des secrets qui permettent d'agir au nom du client sur sa boutique (lire son
    // catalogue), jamais stockés en clair en base.
    return this.prisma.storeConnection.create({
      data: {
        organizationId: params.organizationId,
        platform: params.platform as any,
        storeUrl: params.storeUrl,
        accessToken: this.encryptOptional(params.accessToken),
        apiKey: this.encryptOptional(params.apiKey),
        apiSecret: this.encryptOptional(params.apiSecret),
        status: 'ACTIVE',
      },
    });
  }

  private encryptOptional(value?: string): string | undefined {
    return value ? this.tokenCrypto.encrypt(value) : undefined;
  }

  private decryptOptional(value: string | null): string | undefined {
    return value ? this.tokenCrypto.decrypt(value) : undefined;
  }

  async listStores(organizationId: string) {
    return this.prisma.storeConnection.findMany({
      where: { organizationId },
      select: { id: true, platform: true, storeUrl: true, status: true, lastSyncedAt: true, createdAt: true },
    });
  }

  // Récupère le catalogue depuis la boutique connectée et le persiste (upsert par externalId
  // pour permettre des synchronisations répétées sans dupliquer les produits).
  async syncCatalog(organizationId: string, storeConnectionId: string, limit = 50) {
    const store = await this.prisma.storeConnection.findFirst({
      where: { id: storeConnectionId, organizationId, status: 'ACTIVE' },
    });
    if (!store) throw new NotFoundException('Connexion boutique introuvable ou inactive');

    // Revalidé à chaque synchronisation, pas seulement à la connexion initiale — cf.
    // store-url-guard.ts (fenêtre de DNS rebinding).
    await assertPublicStoreUrl(store.storeUrl);

    const adapter = this.getAdapter(store.platform);
    const products = await adapter.fetchProducts(
      {
        storeUrl: store.storeUrl,
        accessToken: this.decryptOptional(store.accessToken),
        apiKey: this.decryptOptional(store.apiKey),
        apiSecret: this.decryptOptional(store.apiSecret),
      },
      limit,
    );

    const imported = await Promise.all(
      products.map((p) =>
        this.prisma.importedProduct.upsert({
          where: { storeConnectionId_externalId: { storeConnectionId: store.id, externalId: p.externalId } },
          create: {
            organizationId,
            storeConnectionId: store.id,
            externalId: p.externalId,
            name: p.name,
            description: p.description,
            priceAmount: p.priceAmount,
            currency: p.currency,
            imageUrl: p.imageUrl,
            raw: p.raw as any,
          },
          update: {
            name: p.name,
            description: p.description,
            priceAmount: p.priceAmount,
            imageUrl: p.imageUrl,
            raw: p.raw as any,
          },
        }),
      ),
    );

    await this.prisma.storeConnection.update({
      where: { id: store.id },
      data: { lastSyncedAt: new Date() },
    });

    return { importedCount: imported.length, products: imported };
  }

  async listImportedProducts(organizationId: string, storeConnectionId?: string) {
    return this.prisma.importedProduct.findMany({
      where: { organizationId, ...(storeConnectionId ? { storeConnectionId } : {}) },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
