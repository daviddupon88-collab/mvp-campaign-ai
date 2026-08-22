import { ProductIntelligenceService } from './product-intelligence.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductVisionAnalysisService } from './product-vision-analysis.service';
import { ProductIdentificationService } from './product-identification.service';
import { ProductVisionAnalysis, ProductIdentificationResult } from './product-intelligence.types';
import { SafeProductPageFetcherService } from './product-page/safe-product-page-fetcher.service';
import { ProductPageLlmExtractorService } from './product-page/product-page-llm-extractor.service';
import { ProductIntelligenceFusionService } from './product-intelligence-fusion.service';
import { ProductPageFetchResult } from './product-page/product-page-fetch-result.types';
import { createHash } from 'crypto';

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };

const VISION: ProductVisionAnalysis = {
  category: 'Chaussures',
  subcategory: 'Running',
  productType: null,
  brand: 'Nike',
  productName: null,
  model: null,
  visibleText: ['NIKE'],
  logoDetected: true,
  packaging: null,
  colors: ['noir'],
  materials: [],
  shape: null,
  visualAttributes: ['semelle épaisse'],
  distinctiveFeatures: [],
  visibleClaims: ['Amorti premium'],
  identificationClues: [],
  confidence: 0.8,
  raw: '{}',
};
const IDENTIFICATION: ProductIdentificationResult = {
  candidates: [{ name: 'Nike Air Zoom', brand: 'Nike', model: null, matchScore: 0.9, reason: 'logo visible' }],
  bestMatch: 'Nike Air Zoom',
  confidenceLevel: 'CONFIRMED',
  confidence: 0.9,
};

function buildService(opts: { cachedProfile?: unknown; cachedSnapshot?: unknown; fetchResult?: Partial<ProductPageFetchResult> } = {}) {
  const findUniqueProfile = jest.fn().mockResolvedValue(opts.cachedProfile ?? null);
  const createProfile = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'profile-1', ...data }));
  const updateProfile = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'profile-1', ...data }));
  const findUniqueSnapshot = jest.fn().mockResolvedValue(opts.cachedSnapshot ?? null);
  const upsertSnapshot = jest.fn().mockResolvedValue(undefined);
  const updateSnapshot = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    productIntelligenceProfile: { findUnique: findUniqueProfile, create: createProfile, update: updateProfile },
    productUrlSnapshot: { findUnique: findUniqueSnapshot, upsert: upsertSnapshot, update: updateSnapshot },
  } as unknown as PrismaService;

  const analyze = jest.fn().mockResolvedValue(VISION);
  const visionAnalysis = { analyze } as unknown as ProductVisionAnalysisService;

  const identify = jest.fn().mockResolvedValue(IDENTIFICATION);
  const identification = { identify } as unknown as ProductIdentificationService;

  const fetchFn = jest.fn().mockResolvedValue({
    url: 'https://example.com/produit', finalUrl: 'https://example.com/produit', statusCode: 200,
    contentType: 'text/html', html: '<html><head><title>Produit</title></head></html>', retrievedAt: new Date().toISOString(), warnings: [],
    ...opts.fetchResult,
  });
  const fetcher = { fetch: fetchFn } as unknown as SafeProductPageFetcherService;

  const llmExtract = jest.fn().mockResolvedValue({
    sourceUrl: 'https://example.com/produit', title: undefined, brand: undefined, category: undefined, description: undefined,
    specifications: [], claims: [], images: [], price: undefined, availability: undefined, extractionMethod: 'LLM', warnings: [],
  });
  const llmExtractor = { extract: llmExtract } as unknown as ProductPageLlmExtractorService;

  const fusion = new ProductIntelligenceFusionService();

  const service = new ProductIntelligenceService(prisma, visionAnalysis, identification, fetcher, llmExtractor, fusion);
  return { service, findUniqueProfile, createProfile, updateProfile, findUniqueSnapshot, upsertSnapshot, updateSnapshot, analyze, identify, fetchFn, llmExtract };
}

// P0.3 — ProductIntelligenceProfile + cache par photo (P1.7 satisfait ici, cf. plan). La clé de
// cache est le hash SHA-256 du CONTENU de l'image (pas son URL) — deux campagnes avec la même
// photo (même si hébergée à des URLs différentes) doivent réutiliser le même profil.
describe('ProductIntelligenceService.buildProfile', () => {
  const DATA_URI = 'data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==';
  const EXPECTED_HASH = createHash('sha256').update(Buffer.from('ZmFrZS1pbWFnZS1ieXRlcw==', 'base64')).digest('hex');

  it("aucun profil en cache : appelle vision PUIS identification, persiste le profil avec webResearchStatus NOT_CONFIGURED (jamais REAL ni MOCK)", async () => {
    const { service, createProfile, analyze, identify } = buildService();

    const profile = await service.buildProfile(CTX, 'org-1', DATA_URI);

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-1',
          imageHash: EXPECTED_HASH,
          brand: 'Nike',
          webResearchStatus: 'NOT_CONFIGURED',
          confidence: 0.9,
        }),
      }),
    );
    expect(profile.brand).toBe('Nike');
  });

  it("profil déjà en cache pour cette organisation ET ce hash d'image, aucune URL demandée : réutilisé tel quel, AUCUN appel IA/fetch relancé", async () => {
    const cached = { id: 'profile-existant', brand: 'Nike', imageHash: EXPECTED_HASH, productUrl: null };
    const { service, analyze, identify, createProfile, fetchFn } = buildService({ cachedProfile: cached });

    const profile = await service.buildProfile(CTX, 'org-1', DATA_URI);

    expect(profile).toBe(cached);
    expect(analyze).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(createProfile).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("les champs marché/audience/sources non connus restent explicitement vides/UNKNOWN — jamais devinés (règle de grounding, P0.4)", async () => {
    const { service, createProfile } = buildService();

    await service.buildProfile(CTX, 'org-1', DATA_URI);

    const { data } = (createProfile as jest.Mock).mock.calls[0][0];
    expect(data.targetAudience).toBeNull();
    expect(data.competitors).toEqual([]);
    expect(data.marketingAngles).toEqual([]);
    expect(data.verifiedClaims).toEqual([]); // aucune vérification web réelle possible pour l'instant
  });

  it('les claims visibles sur le packaging sont transcrits comme NON vérifiés, pas comme des faits confirmés', async () => {
    const { service, createProfile } = buildService();

    await service.buildProfile(CTX, 'org-1', DATA_URI);

    const { data } = (createProfile as jest.Mock).mock.calls[0][0];
    expect(data.visibleClaims).toEqual(['Amorti premium']);
    expect(data.unverifiedClaims).toEqual(['Amorti premium']);
    expect(data.verifiedClaims).toEqual([]);
  });

  it('la clé de cache utilisée est bien le hash du CONTENU de la photo (organizationId_imageHash), recherché avant tout appel IA', async () => {
    const { service, findUniqueProfile } = buildService();

    await service.buildProfile(CTX, 'org-1', DATA_URI);

    expect(findUniqueProfile).toHaveBeenCalledWith({ where: { organizationId_imageHash: { organizationId: 'org-1', imageHash: EXPECTED_HASH } } });
  });

  // Mission 4.4 (Product URL Intelligence)
  describe('avec productUrl', () => {
    it('fusionne les faits URL avec la vision, persiste productUrl/productUrlFacts/productFacts/productClaims/productConflicts', async () => {
      const { service, createProfile, fetchFn } = buildService({
        fetchResult: { html: `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Air Zoom', brand: 'Nike', additionalProperty: [{ name: 'Poids', value: '250', unitText: 'g' }] })}</script></head></html>` },
      });

      await service.buildProfile(CTX, 'org-1', DATA_URI, undefined, 'https://example.com/produit');

      expect(fetchFn).toHaveBeenCalledWith('https://example.com/produit');
      const { data } = (createProfile as jest.Mock).mock.calls[0][0];
      expect(data.productUrl).toBe('https://example.com/produit');
      expect(data.productUrlFacts.title).toBe('Air Zoom');
      expect(data.productFacts.some((f: { key: string }) => f.key === 'Poids')).toBe(true);
      expect(data.productClaims.length).toBeGreaterThan(0);
    });

    it("profil en cache avec la MÊME photo mais SANS URL enregistrée : une nouvelle URL fournie déclenche une fusion fraîche (pas de repli silencieux sur l'ancien profil)", async () => {
      const cached = { id: 'profile-existant', brand: 'Nike', imageHash: EXPECTED_HASH, productUrl: null, visionAnalysis: VISION, identification: IDENTIFICATION };
      const { service, createProfile, updateProfile, analyze, fetchFn } = buildService({ cachedProfile: cached });

      await service.buildProfile(CTX, 'org-1', DATA_URI, undefined, 'https://example.com/produit');

      expect(fetchFn).toHaveBeenCalled();
      // Réutilise le profil existant (update), ne recrée jamais un doublon.
      expect(updateProfile).toHaveBeenCalled();
      expect(createProfile).not.toHaveBeenCalled();
      // Vision/identification déjà en cache — pas la peine de relancer les appels IA coûteux.
      expect(analyze).not.toHaveBeenCalled();
    });

    it('URL inaccessible (fetch échoué) : campagne poursuivie sans faits URL, ne lève jamais', async () => {
      const { service, createProfile } = buildService({ fetchResult: { html: undefined, warnings: ['Page produit inaccessible : timeout'] } });

      await service.buildProfile(CTX, 'org-1', DATA_URI, undefined, 'https://example.com/produit');

      const { data } = (createProfile as jest.Mock).mock.calls[0][0];
      expect(data.productUrlFacts.warnings).toContain('Page produit inaccessible : timeout');
      expect(data.productFacts).toBeDefined();
    });

    it('snapshot en cache et encore frais : réutilisé, aucun fetch relancé', async () => {
      const freshSnapshot = {
        id: 'snap-1', contentHash: 'abc', expiresAt: new Date(Date.now() + 1_000_000),
        extractedFacts: { sourceUrl: 'https://example.com/produit', title: 'Depuis cache', specifications: [], claims: [], images: [], extractionMethod: 'JSON_LD', warnings: [] },
      };
      const { service, fetchFn, createProfile } = buildService({ cachedSnapshot: freshSnapshot });

      await service.buildProfile(CTX, 'org-1', DATA_URI, undefined, 'https://example.com/produit');

      expect(fetchFn).not.toHaveBeenCalled();
      const { data } = (createProfile as jest.Mock).mock.calls[0][0];
      expect(data.productUrlFacts.title).toBe('Depuis cache');
    });

    it('repli LLM déclenché quand extraction déterministe insuffisante (<2 specifications)', async () => {
      const { service, llmExtract } = buildService({ fetchResult: { html: '<html><body>rien d\'exploitable</body></html>' } });

      await service.buildProfile(CTX, 'org-1', DATA_URI, undefined, 'https://example.com/produit');

      expect(llmExtract).toHaveBeenCalled();
    });

    // Mission 4.5 (Phase 1 — instrumentation)
    describe('instrumentation (cacheHit / durées)', () => {
      it('snapshot en cache et frais : cacheHit=true, aucun fetch relancé', async () => {
        const freshSnapshot = {
          id: 'snap-1', contentHash: 'abc', expiresAt: new Date(Date.now() + 1_000_000),
          extractedFacts: { sourceUrl: 'https://example.com/produit', title: 'Depuis cache', specifications: [], claims: [], images: [], extractionMethod: 'JSON_LD', warnings: [] },
        };
        const { service, createProfile } = buildService({ cachedSnapshot: freshSnapshot });

        await service.buildProfile(CTX, 'org-1', DATA_URI, undefined, 'https://example.com/produit');

        const { data } = (createProfile as jest.Mock).mock.calls[0][0];
        expect(data.productUrlFacts.cacheHit).toBe(true);
      });

      it('fetch réel effectué (pas de snapshot en cache) : cacheHit=false', async () => {
        const { service, createProfile } = buildService({
          fetchResult: { html: `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Air Zoom', additionalProperty: [{ name: 'Poids', value: '250', unitText: 'g' }] })}</script></head></html>` },
        });

        await service.buildProfile(CTX, 'org-1', DATA_URI, undefined, 'https://example.com/produit');

        const { data } = (createProfile as jest.Mock).mock.calls[0][0];
        expect(data.productUrlFacts.cacheHit).toBe(false);
      });

      it('repli LLM déclenché : llmFallbackDurationMs mesuré sur le résultat final', async () => {
        const { service, createProfile } = buildService({ fetchResult: { html: '<html><body>rien d\'exploitable</body></html>' } });

        await service.buildProfile(CTX, 'org-1', DATA_URI, undefined, 'https://example.com/produit');

        const { data } = (createProfile as jest.Mock).mock.calls[0][0];
        expect(typeof data.productUrlFacts.llmFallbackDurationMs).toBe('number');
      });
    });
  });
});
