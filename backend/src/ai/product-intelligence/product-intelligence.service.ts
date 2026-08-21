import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AiCallContext } from '../ai-gateway/ai-gateway.service';
import { resolveMediaBuffer } from '../../common/http/resolve-media-buffer';
import { ProductVisionAnalysisService } from './product-vision-analysis.service';
import { ProductIdentificationService } from './product-identification.service';

// P0.3 — Product Intelligence Profile (chantier "Product Intelligence & Creative Intelligence
// Engine V2", 2026-08-18). Orchestre Vision (P0.1) -> Identification (P0.2) -> persistance, avec
// un cache par photo produit (P1.7) : une même image ne relance jamais les appels IA de
// vision/identification pour une nouvelle campagne. Devient la source de vérité consommée par
// Product Grounding (P0.4) pour toute génération publicitaire concernant ce produit.
@Injectable()
export class ProductIntelligenceService {
  private readonly logger = new Logger(ProductIntelligenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly visionAnalysis: ProductVisionAnalysisService,
    private readonly identification: ProductIdentificationService,
  ) {}

  async buildProfile(ctx: AiCallContext, organizationId: string, imageUrl: string, productDescriptionHint?: string) {
    const imageHash = await this.computeImageHash(imageUrl);

    const cached = await this.prisma.productIntelligenceProfile.findUnique({
      where: { organizationId_imageHash: { organizationId, imageHash } },
    });
    if (cached) {
      this.logger.log(`Product Intelligence Profile réutilisé depuis le cache (organisation ${organizationId}, hash ${imageHash.slice(0, 12)}...) — aucun appel IA relancé.`);
      return cached;
    }

    const vision = await this.visionAnalysis.analyze(ctx, imageUrl, productDescriptionHint);
    const identification = await this.identification.identify(ctx, vision, productDescriptionHint);

    return this.prisma.productIntelligenceProfile.create({
      data: {
        organizationId,
        imageHash,
        sourceImageUrl: imageUrl,
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
        benefits: [],
        usps: [],
        // Les claims visibles sur le packaging sont transcrits (P0.1) mais jamais vérifiés par
        // la seule vision — ils restent "non vérifiés" jusqu'à un Fact Verification réel (P1).
        visibleClaims: vision.visibleClaims,
        verifiedClaims: [],
        unverifiedClaims: vision.visibleClaims,
        // Marché/audience/sources : UNKNOWN explicite (null/[]), jamais deviné — cf. P0.4
        // (Product Grounding) qui traduit cette absence en règle de prompt, pas en silence.
        targetAudience: null,
        customerProblems: [],
        customerNeeds: [],
        customerObjections: [],
        competitors: [],
        marketingAngles: [],
        keywords: [],
        trends: [],
        sources: [],
        webResearchStatus: 'NOT_CONFIGURED',
        confidence: identification.confidence,
      },
    });
  }

  private async computeImageHash(imageUrl: string): Promise<string> {
    const buffer = await resolveMediaBuffer(imageUrl);
    return createHash('sha256').update(buffer).digest('hex');
  }
}
