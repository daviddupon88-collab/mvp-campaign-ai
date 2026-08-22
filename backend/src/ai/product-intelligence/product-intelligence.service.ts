import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AiCallContext } from '../ai-gateway/ai-gateway.service';
import { resolveMediaBuffer } from '../../common/http/resolve-media-buffer';
import { ProductVisionAnalysisService } from './product-vision-analysis.service';
import { ProductIdentificationService } from './product-identification.service';
import { ProductVisionAnalysis, ProductIdentificationResult } from './product-intelligence.types';
import { SafeProductPageFetcherService } from './product-page/safe-product-page-fetcher.service';
import { ProductPageLlmExtractorService } from './product-page/product-page-llm-extractor.service';
import { extractProductPageFacts } from './product-page/product-page-extractor';
import { ProductUrlFacts } from './product-page/product-url-facts.types';
import { ProductIntelligenceFusionService } from './product-intelligence-fusion.service';

const MIN_USABLE_FACTS = 2;
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

// P0.3 — Product Intelligence Profile (chantier "Product Intelligence & Creative Intelligence
// Engine V2", 2026-08-18). Orchestre Vision (P0.1) -> Identification (P0.2) -> persistance, avec
// un cache par photo produit (P1.7) : une même image ne relance jamais les appels IA de
// vision/identification pour une nouvelle campagne. Devient la source de vérité consommée par
// Product Grounding (P0.4) pour toute génération publicitaire concernant ce produit.
//
// Mission 4.4 (Product URL Intelligence) — étend ce service pour fusionner une URL produit
// optionnelle dans le MÊME profil canonique (jamais un second concept de "profil produit") :
// URL -> SafeProductPageFetcherService -> extraction déterministe (JSON-LD/OpenGraph/HTML) ->
// repli LLM si insuffisant -> ProductIntelligenceFusionService -> persistance additive. La clé de
// cache (organizationId, imageHash) reste INCHANGÉE (risque de refactor évité) ; ProductUrlSnapshot
// est la couche de cache dédiée à l'URL, en amont de la construction de CE profil.
@Injectable()
export class ProductIntelligenceService {
  private readonly logger = new Logger(ProductIntelligenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly visionAnalysis: ProductVisionAnalysisService,
    private readonly identification: ProductIdentificationService,
    private readonly fetcher: SafeProductPageFetcherService,
    private readonly llmExtractor: ProductPageLlmExtractorService,
    private readonly fusion: ProductIntelligenceFusionService,
  ) {}

  async buildProfile(ctx: AiCallContext, organizationId: string, imageUrl: string, productDescriptionHint?: string, productUrl?: string) {
    const imageHash = await this.computeImageHash(imageUrl);
    const normalizedProductUrl = productUrl?.trim() || undefined;

    const cached = await this.prisma.productIntelligenceProfile.findUnique({
      where: { organizationId_imageHash: { organizationId, imageHash } },
    });

    // Mission 4.4 — un profil en cache reste valide UNIQUEMENT si productUrl n'a pas changé
    // (undefined->undefined, ou même URL) : une nouvelle URL fournie sur une photo déjà connue
    // doit déclencher une fusion fraîche, jamais un repli silencieux sur l'ancien profil sans URL.
    if (cached && (cached.productUrl ?? undefined) === normalizedProductUrl) {
      this.logger.log(`Product Intelligence Profile réutilisé depuis le cache (organisation ${organizationId}, hash ${imageHash.slice(0, 12)}...) — aucun appel IA relancé.`);
      return cached;
    }

    // Réutilise l'analyse vision déjà en cache (image inchangée) — seule la fusion avec l'URL
    // change, jamais la peine de relancer un appel vision/identification pour ça.
    const vision: ProductVisionAnalysis = cached ? (cached.visionAnalysis as unknown as ProductVisionAnalysis) : await this.visionAnalysis.analyze(ctx, imageUrl, productDescriptionHint);
    const identification: ProductIdentificationResult = cached
      ? (cached.identification as unknown as ProductIdentificationResult)
      : await this.identification.identify(ctx, vision, productDescriptionHint);

    const urlFacts = normalizedProductUrl ? await this.buildUrlFacts(ctx, organizationId, normalizedProductUrl) : null;
    const fusionResult = this.fusion.fuse(vision, urlFacts, productDescriptionHint);

    const data = {
      category: vision.category,
      subcategory: vision.subcategory,
      productType: vision.productType,
      brand: vision.brand,
      productName: vision.productName,
      model: vision.model,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visionAnalysis: vision as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      identification: identification as any,
      features: vision.visualAttributes,
      benefits: [] as string[],
      usps: [] as string[],
      // Les claims visibles sur le packaging sont transcrits (P0.1) mais jamais vérifiés par
      // la seule vision — ils restent "non vérifiés" jusqu'à un Fact Verification réel (P1).
      visibleClaims: vision.visibleClaims,
      verifiedClaims: [] as string[],
      unverifiedClaims: vision.visibleClaims,
      // Marché/audience/sources : UNKNOWN explicite (null/[]), jamais deviné — cf. P0.4
      // (Product Grounding) qui traduit cette absence en règle de prompt, pas en silence.
      targetAudience: null as string | null,
      customerProblems: [] as string[],
      customerNeeds: [] as string[],
      customerObjections: [] as string[],
      competitors: [] as string[],
      marketingAngles: [] as string[],
      keywords: [] as string[],
      trends: [] as string[],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sources: [] as any,
      webResearchStatus: 'NOT_CONFIGURED',
      confidence: identification.confidence,
      // Mission 4.4 (Product URL Intelligence) — additif.
      productUrl: normalizedProductUrl ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      productUrlFacts: (urlFacts as any) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      productFacts: fusionResult.facts as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      productClaims: fusionResult.claims as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      productConflicts: fusionResult.conflicts as any,
    };

    if (cached) {
      return this.prisma.productIntelligenceProfile.update({ where: { id: cached.id }, data });
    }

    return this.prisma.productIntelligenceProfile.create({
      data: { organizationId, imageHash, sourceImageUrl: imageUrl, ...data },
    });
  }

  // Mission 4.4 (Product URL Intelligence, Phase D/U) — URL -> ProductUrlSnapshot cache ->
  // SafeProductPageFetcherService -> extraction déterministe -> repli LLM si insuffisant.
  // Ne lève JAMAIS pour une page inaccessible (brief Phase Q : "une URL inaccessible ne doit pas
  // automatiquement bloquer une campagne") — retourne un ProductUrlFacts vide avec warnings.
  private async buildUrlFacts(ctx: AiCallContext, organizationId: string, productUrl: string): Promise<ProductUrlFacts> {
    const normalizedUrl = this.normalizeUrl(productUrl);
    const existingSnapshot = await this.prisma.productUrlSnapshot.findUnique({
      where: { organizationId_normalizedUrl: { organizationId, normalizedUrl } },
    });

    if (existingSnapshot && existingSnapshot.expiresAt > new Date()) {
      this.logger.log(`Snapshot de page produit réutilisé depuis le cache (organisation ${organizationId}, URL ${normalizedUrl}) — aucun fetch relancé.`);
      // Mission 4.5 (Phase 1 — instrumentation) — cacheHit=true posé ICI seulement : c'est le
      // SEUL chemin qui n'effectue aucun fetch réel (le chemin "contenu inchangé" plus bas
      // effectue quand même un vrai fetch pour vérifier le hash, donc ce n'est pas un cache hit
      // au sens mesuré ici).
      return { ...(existingSnapshot.extractedFacts as unknown as ProductUrlFacts), cacheHit: true };
    }

    const fetchResult = await this.fetcher.fetch(productUrl);
    if (!fetchResult.html) {
      this.logger.warn(`Page produit inaccessible ou non exploitable (${productUrl}) : ${fetchResult.warnings.join(' ; ')} — campagne poursuivie sans faits produit issus de l'URL.`);
      return {
        ...this.emptyUrlFacts(productUrl, fetchResult.warnings),
        cacheHit: false,
        fetchDurationMs: fetchResult.fetchDurationMs,
        redirectCount: fetchResult.redirectCount,
      };
    }

    const contentHash = createHash('sha256').update(fetchResult.html).digest('hex');
    if (existingSnapshot && existingSnapshot.contentHash === contentHash) {
      // Contenu inchangé malgré l'expiration du TTL — pas la peine de ré-extraire, juste
      // renouveler la fraîcheur du snapshot (brief Phase U : "Si la page a changé -> nouvelle
      // extraction", implicitement : si elle n'a PAS changé, ne pas en refaire une pour rien).
      await this.prisma.productUrlSnapshot.update({ where: { id: existingSnapshot.id }, data: { expiresAt: new Date(Date.now() + SNAPSHOT_TTL_MS) } });
      return {
        ...(existingSnapshot.extractedFacts as unknown as ProductUrlFacts),
        cacheHit: false,
        fetchDurationMs: fetchResult.fetchDurationMs,
        redirectCount: fetchResult.redirectCount,
      };
    }

    let facts = extractProductPageFacts(fetchResult.html, fetchResult.finalUrl);
    if (facts.specifications.length < MIN_USABLE_FACTS) {
      this.logger.log(`Extraction déterministe insuffisante (${facts.specifications.length} spécification(s)) — repli LLM pour ${normalizedUrl}.`);
      const llmStartedAt = Date.now();
      const llmFacts = await this.llmExtractor.extract(ctx, fetchResult.html, fetchResult.finalUrl);
      facts = this.mergeExtraction(facts, llmFacts);
      facts.llmFallbackDurationMs = Date.now() - llmStartedAt;
    }
    facts.warnings = [...facts.warnings, ...fetchResult.warnings];
    facts.cacheHit = false;
    facts.fetchDurationMs = fetchResult.fetchDurationMs;
    facts.redirectCount = fetchResult.redirectCount;

    await this.prisma.productUrlSnapshot.upsert({
      where: { organizationId_normalizedUrl: { organizationId, normalizedUrl } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: { organizationId, normalizedUrl, contentHash, extractedFacts: facts as any, extractedClaims: facts.claims as any, expiresAt: new Date(Date.now() + SNAPSHOT_TTL_MS) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: { contentHash, extractedFacts: facts as any, extractedClaims: facts.claims as any, retrievedAt: new Date(), expiresAt: new Date(Date.now() + SNAPSHOT_TTL_MS) },
    });

    return facts;
  }

  // Fusionne l'extraction déterministe (prioritaire) avec le repli LLM : ne remplace jamais une
  // donnée déterministe déjà trouvée, complète seulement ce qui manque.
  private mergeExtraction(deterministic: ProductUrlFacts, llm: ProductUrlFacts): ProductUrlFacts {
    const hadDeterministic = deterministic.specifications.length > 0 || !!deterministic.title;
    return {
      ...deterministic,
      title: deterministic.title ?? llm.title,
      brand: deterministic.brand ?? llm.brand,
      description: deterministic.description ?? llm.description,
      specifications: [...deterministic.specifications, ...llm.specifications],
      claims: [...deterministic.claims, ...llm.claims],
      price: deterministic.price ?? llm.price,
      availability: deterministic.availability ?? llm.availability,
      extractionMethod: hadDeterministic && (llm.specifications.length > 0 || llm.title) ? 'MIXED' : hadDeterministic ? deterministic.extractionMethod : 'LLM',
      warnings: [...deterministic.warnings, ...llm.warnings],
    };
  }

  private emptyUrlFacts(url: string, warnings: string[]): ProductUrlFacts {
    return {
      sourceUrl: url, title: undefined, brand: undefined, category: undefined, description: undefined,
      specifications: [], claims: [], images: [], price: undefined, availability: undefined,
      extractionMethod: 'HTML', warnings,
    };
  }

  // Retire les paramètres de tracking usuels (utm_*, fbclid, gclid) et le fragment — deux URLs qui
  // ne diffèrent que par un tracking parameter sont LA MÊME page produit pour le cache.
  private normalizeUrl(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      const params = [...url.searchParams.keys()];
      for (const key of params) {
        if (/^utm_|^(fbclid|gclid|msclkid|ref|mc_[a-z]+)$/i.test(key)) url.searchParams.delete(key);
      }
      url.hash = '';
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  private async computeImageHash(imageUrl: string): Promise<string> {
    const buffer = await resolveMediaBuffer(imageUrl);
    return createHash('sha256').update(buffer).digest('hex');
  }
}
