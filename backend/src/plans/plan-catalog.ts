// Catalogue de plans — SOURCE DE VÉRITÉ UNIQUE pour les entitlements de chaque offre.
// Reprend exactement la grille du business plan (Volume 1 chapitre 11, Volume 2 chapitre 1).
// StripeService et EntitlementsService s'appuient tous les deux sur ce fichier :
// aucune limite ne doit être vérifiée ou modifiée ailleurs que via PLAN_CATALOG.

export interface PlanDefinition {
  key: string;
  name: string;
  priceMonthly: number | null; // null = "sur devis" (Enterprise)
  aiCreditsIncluded: number;
  maxSeats: number | null; // null = illimité
  maxActiveCampaigns: number | null; // null = illimité
  maxChannels: number | null; // null = illimité

  // Plafonds dédiés aux ressources les plus coûteuses — distincts du pool de crédits
  // partagé, car un seul appel vidéo (150 crédits, cf. CREDIT_COSTS) suffirait à épuiser
  // le quota de crédits de l'essai gratuit (60) à lui seul. Sans ces plafonds séparés,
  // impossible d'offrir "60 crédits ET 1 vidéo incluse" en même temps — l'essai doit
  // pouvoir garantir un nombre d'images/vidéos/publications précis, indépendamment de
  // combien de texte a déjà été généré. null = pas de plafond dédié (le pool de crédits
  // reste la seule limite, cas de tous les plans payants).
  maxImages: number | null;
  maxVideos: number | null;
  maxSocialPosts: number | null;
  maxOptimizerRuns: number | null; // null = illimité (cron nocturne normal)

  // Restriction de canaux par PLATEFORME (pas seulement par nombre, cf. maxChannels) —
  // utile pour un essai qui limite délibérément aux réseaux les plus demandés (Meta,
  // LinkedIn) sans donner accès à Google Ads/TikTok, plus coûteux à intégrer et à modérer.
  // null = toutes les plateformes disponibles.
  allowedChannels: string[] | null;

  features: {
    apiAccess: boolean;
    sso: boolean;
    whiteLabel: boolean;
    prioritySupport: boolean;
  };
  // Nom de la variable d'environnement contenant le Price ID Stripe correspondant.
  // null pour Enterprise ET pour l'essai : aucun des deux ne se souscrit via Checkout.
  stripePriceEnvKey: string | null;
}

export const PLAN_CATALOG: Record<string, PlanDefinition> = {
  // Essai gratuit — plafonds volontairement stricts sur les ressources les plus coûteuses
  // (vidéo, image, publication réelle), pour qu'une organisation en essai ne puisse jamais
  // générer une facture fournisseur d'IA disproportionnée par rapport à ce qu'elle rapporte
  // (0€). Les fonctionnalités elles-mêmes (Brand Brain, Content Studio, Calendrier,
  // Analytics) restent en accès complet — c'est le VOLUME qui est limité, pas le produit.
  trial: {
    key: 'trial',
    name: 'Essai gratuit',
    priceMonthly: 0,
    // 75, pas 60 : une campagne multi-canaux (ex: 3 canaux + 1 image) coûte mécaniquement
    // ~65 crédits depuis l'introduction du copywriting différencié par canal (un appel
    // generateText distinct par canal plutôt qu'un texte unique dupliqué) — 60 crédits
    // rendait le scénario multi-canaux le plus démonstratif du produit irréalisable dès la
    // première campagne. Décision commerciale explicite (README item 61), pas un simple
    // ajustement technique.
    aiCreditsIncluded: 75,
    maxSeats: 2,
    maxActiveCampaigns: 3,
    maxChannels: 3,
    maxImages: 10,
    maxVideos: 1,
    maxSocialPosts: 10,
    maxOptimizerRuns: 1,
    allowedChannels: ['META_FACEBOOK', 'META_INSTAGRAM', 'LINKEDIN'],
    features: { apiAccess: false, sso: false, whiteLabel: false, prioritySupport: false },
    stripePriceEnvKey: null,
  },
  starter: {
    key: 'starter',
    name: 'Starter',
    priceMonthly: 39,
    aiCreditsIncluded: 500,
    maxSeats: 3,
    maxActiveCampaigns: 5,
    maxChannels: 3,
    maxImages: null,
    maxVideos: null,
    maxSocialPosts: null,
    maxOptimizerRuns: null,
    allowedChannels: null,
    features: { apiAccess: false, sso: false, whiteLabel: false, prioritySupport: false },
    stripePriceEnvKey: 'STRIPE_PRICE_STARTER',
  },
  growth: {
    key: 'growth',
    name: 'Growth',
    priceMonthly: 99,
    aiCreditsIncluded: 2000,
    maxSeats: 10,
    maxActiveCampaigns: 20,
    maxChannels: null,
    maxImages: null,
    maxVideos: null,
    maxSocialPosts: null,
    maxOptimizerRuns: null,
    allowedChannels: null,
    features: { apiAccess: false, sso: false, whiteLabel: false, prioritySupport: false },
    stripePriceEnvKey: 'STRIPE_PRICE_GROWTH',
  },
  business: {
    key: 'business',
    name: 'Business',
    priceMonthly: 249,
    aiCreditsIncluded: 6000,
    maxSeats: 30,
    maxActiveCampaigns: null,
    maxChannels: null,
    maxImages: null,
    maxVideos: null,
    maxSocialPosts: null,
    maxOptimizerRuns: null,
    allowedChannels: null,
    features: { apiAccess: true, sso: false, whiteLabel: false, prioritySupport: true },
    stripePriceEnvKey: 'STRIPE_PRICE_BUSINESS',
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    priceMonthly: null,
    aiCreditsIncluded: 30000,
    maxSeats: null,
    maxActiveCampaigns: null,
    maxChannels: null,
    maxImages: null,
    maxVideos: null,
    maxSocialPosts: null,
    maxOptimizerRuns: null,
    allowedChannels: null,
    features: { apiAccess: true, sso: true, whiteLabel: true, prioritySupport: true },
    stripePriceEnvKey: null,
  },
};

// Plan offert pendant l'essai gratuit (14 jours) : plafonds dédiés (cf. plan 'trial'
// ci-dessus) plutôt qu'un accès complet au plan Growth — un essai illimité en volume
// pendant 14 jours exposait l'entreprise à un coût fournisseur d'IA réel sans aucune
// garantie de conversion en abonnement payant.
export const TRIAL_PLAN_KEY = 'trial';
export const TRIAL_DURATION_DAYS = 14;

// Packs de crédits ponctuels (cf. chapitre 6.4 du Volume 2 — "packs de recharge"),
// pour un usage ponctuel au-delà du quota sans changer d'abonnement.
export interface CreditPackDefinition {
  key: string;
  credits: number;
  priceEnvKey: string;
}
export const CREDIT_PACKS: Record<string, CreditPackDefinition> = {
  small: { key: 'small', credits: 500, priceEnvKey: 'STRIPE_PRICE_CREDIT_PACK_SMALL' },
  medium: { key: 'medium', credits: 2000, priceEnvKey: 'STRIPE_PRICE_CREDIT_PACK_MEDIUM' },
  large: { key: 'large', credits: 5000, priceEnvKey: 'STRIPE_PRICE_CREDIT_PACK_LARGE' },
};

export function getPlan(planKey: string): PlanDefinition {
  const plan = PLAN_CATALOG[planKey];
  if (!plan) throw new Error(`Plan inconnu: ${planKey}`);
  return plan;
}

// Ordre de progression commerciale — utilisé pour transformer un plafond atteint en
// invitation à l'upgrade ciblée, plutôt qu'un message d'erreur générique. 'trial' et
// 'starter' recommandent tous les deux 'growth' (le plan intermédiaire mis en avant,
// cf. PricingGrid côté frontend) ; 'enterprise' n'a rien au-dessus, donc null.
const UPGRADE_PATH: Record<string, string | null> = {
  trial: 'growth',
  starter: 'growth',
  growth: 'business',
  business: 'enterprise',
  enterprise: null,
};

export function getRecommendedUpgrade(currentPlanKey: string): string | null {
  return UPGRADE_PATH[currentPlanKey] ?? null;
}

// ---------------------------------------------------------------------------
// ÉCONOMIE DE L'IA — grille de coûts en crédits par (méthode d'API, origine de l'appel).
// Reprend l'esprit de la grille détaillée du chapitre 6.5 du Volume 2 (publication=5,
// image=20-35, vidéo=80-400 crédits), simplifiée à la granularité de tâches que le système
// distingue réellement aujourd'hui (analyse produit/stratégie/copywriting ne sont pas
// différenciées côté crédits, seul le type d'appel — texte/image/vidéo — et son origine
// le sont). Source de vérité unique utilisée par AiGatewayService.creditCostFor().
//
// Note : le coût d'une vidéo (150) dépasse à lui seul le pool de crédits de l'essai
// gratuit (60) — c'est intentionnel et sans incidence : les plafonds dédiés
// (PlanDefinition.maxVideos etc.) gouvernent la vidéo/image/publication pendant l'essai,
// pas le pool de crédits partagé. Cf. EntitlementsService.assertVideoQuotaAvailable().
// ---------------------------------------------------------------------------
export const CREDIT_COSTS: Record<string, Record<string, number>> = {
  // Génération de contenu de campagne (Copywriting AI, Creative Studio, Video Studio).
  // analyzeImage : analyse produit par vision (photo téléversée) — remplace generateText
  // pour l'étape d'analyse produit quand une photo est fournie, cf. AiOrchestratorService.
  // analyzeProductImage(). Coût explicite plutôt que le repli silencieux à 5 (creditCostFor).
  campaign_generation: { generateText: 8, generateImage: 25, generateVideo: 150, analyzeImage: 10 },
  // Garde-fous qualité/sécurité : coût réduit ou nul — ce ne sont pas des fonctionnalités
  // que le client "achète", mais des vérifications que Campaign-ai effectue pour son propre
  // compte avant de proposer un résultat. moderateText n'est jamais facturé au client
  // (l'API de modération OpenAI elle-même n'est pas facturée par tokens).
  moderation: { generateText: 2, analyzeImage: 3, moderateText: 0 },
  brand_consistency: { generateText: 2, analyzeImage: 3 },
  // Recommandations nocturnes : coût modéré, amorti sur l'ensemble des campagnes publiées
  // d'une organisation plutôt que facturé "à l'usage" comme la génération initiale.
  optimizer: { generateText: 5 },
};

export function creditCostFor(purpose: string, taskType: string): number {
  return CREDIT_COSTS[purpose]?.[taskType] ?? 5; // repli prudent si combinaison non cataloguée
}

// Correspondance entre les slugs internes de canal utilisés par le wizard de création de
// campagne / AI Orchestrator ('facebook', 'tiktok'... cf. AiOrchestratorService.
// buildChannelPrompt) et l'enum SocialPlatform utilisé par les connexions OAuth réelles
// ('META_FACEBOOK'...) — deux vocabulaires distincts qui empêchaient jusqu'ici de vérifier
// PlanDefinition.allowedChannels dès la création d'une campagne (seule la publication
// effective, en aval, le faisait — cf. CampaignsService.create). 'email' n'a volontairement
// aucune correspondance : ce n'est pas un canal de diffusion social soumis à connexion OAuth
// ni à allowedChannels.
const CHANNEL_SLUG_TO_PLATFORM: Record<string, string | undefined> = {
  facebook: 'META_FACEBOOK',
  instagram: 'META_INSTAGRAM',
  linkedin: 'LINKEDIN',
  tiktok: 'TIKTOK',
  googleads: 'GOOGLE_ADS',
};

export function mapChannelSlugsToPlatforms(slugs: string[]): string[] {
  return slugs.map((slug) => CHANNEL_SLUG_TO_PLATFORM[slug]).filter((platform): platform is string => !!platform);
}
