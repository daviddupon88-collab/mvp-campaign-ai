// Contrat commun pour importer un catalogue produit depuis une boutique e-commerce.
// Miroir du pattern AiProvider / SocialAdapter : la couche métier (ProductImportService)
// ne connaît jamais les spécificités d'une API e-commerce tierce.

export interface StoreCredentials {
  storeUrl: string;
  accessToken?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface NormalizedProduct {
  externalId: string;
  name: string;
  description?: string;
  priceAmount?: number;
  currency?: string;
  imageUrl?: string;
  raw: unknown; // charge utile brute, conservée pour audit/débogage
}

export interface EcommerceAdapter {
  readonly platform: string;

  // Vérifie que les identifiants fournis permettent bien de joindre la boutique.
  testConnection(credentials: StoreCredentials): Promise<boolean>;

  // Récupère le catalogue (ou une page de celui-ci) et le normalise au format commun.
  fetchProducts(credentials: StoreCredentials, limit?: number): Promise<NormalizedProduct[]>;
}
