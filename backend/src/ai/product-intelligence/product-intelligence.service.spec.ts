import { ProductIntelligenceService } from './product-intelligence.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductVisionAnalysisService } from './product-vision-analysis.service';
import { ProductIdentificationService } from './product-identification.service';
import { ProductVisionAnalysis, ProductIdentificationResult } from './product-intelligence.types';
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

function buildService(cachedProfile: unknown = null) {
  const findUnique = jest.fn().mockResolvedValue(cachedProfile);
  const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'profile-1', ...data }));
  const prisma = { productIntelligenceProfile: { findUnique, create } } as unknown as PrismaService;

  const analyze = jest.fn().mockResolvedValue(VISION);
  const visionAnalysis = { analyze } as unknown as ProductVisionAnalysisService;

  const identify = jest.fn().mockResolvedValue(IDENTIFICATION);
  const identification = { identify } as unknown as ProductIdentificationService;

  const service = new ProductIntelligenceService(prisma, visionAnalysis, identification);
  return { service, findUnique, create, analyze, identify };
}

// P0.3 — ProductIntelligenceProfile + cache par photo (P1.7 satisfait ici, cf. plan). La clé de
// cache est le hash SHA-256 du CONTENU de l'image (pas son URL) — deux campagnes avec la même
// photo (même si hébergée à des URLs différentes) doivent réutiliser le même profil.
describe('ProductIntelligenceService.buildProfile', () => {
  const DATA_URI = 'data:image/png;base64,ZmFrZS1pbWFnZS1ieXRlcw==';
  const EXPECTED_HASH = createHash('sha256').update(Buffer.from('ZmFrZS1pbWFnZS1ieXRlcw==', 'base64')).digest('hex');

  it("aucun profil en cache : appelle vision PUIS identification, persiste le profil avec webResearchStatus NOT_CONFIGURED (jamais REAL ni MOCK)", async () => {
    const { service, create, analyze, identify } = buildService(null);

    const profile = await service.buildProfile(CTX, 'org-1', DATA_URI);

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
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

  it("profil déjà en cache pour cette organisation ET ce hash d'image : réutilisé tel quel, AUCUN appel IA (vision/identification) relancé", async () => {
    const cached = { id: 'profile-existant', brand: 'Nike', imageHash: EXPECTED_HASH };
    const { service, analyze, identify, create } = buildService(cached);

    const profile = await service.buildProfile(CTX, 'org-1', DATA_URI);

    expect(profile).toBe(cached);
    expect(analyze).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("les champs marché/audience/sources non connus restent explicitement vides/UNKNOWN — jamais devinés (règle de grounding, P0.4)", async () => {
    const { service, create } = buildService(null);

    await service.buildProfile(CTX, 'org-1', DATA_URI);

    const { data } = (create as jest.Mock).mock.calls[0][0];
    expect(data.targetAudience).toBeNull();
    expect(data.competitors).toEqual([]);
    expect(data.marketingAngles).toEqual([]);
    expect(data.verifiedClaims).toEqual([]); // aucune vérification web réelle possible pour l'instant
  });

  it('les claims visibles sur le packaging sont transcrits comme NON vérifiés, pas comme des faits confirmés', async () => {
    const { service, create } = buildService(null);

    await service.buildProfile(CTX, 'org-1', DATA_URI);

    const { data } = (create as jest.Mock).mock.calls[0][0];
    expect(data.visibleClaims).toEqual(['Amorti premium']);
    expect(data.unverifiedClaims).toEqual(['Amorti premium']);
    expect(data.verifiedClaims).toEqual([]);
  });

  it('la clé de cache utilisée est bien le hash du CONTENU de la photo (organizationId_imageHash), recherché avant tout appel IA', async () => {
    const { service, findUnique } = buildService(null);

    await service.buildProfile(CTX, 'org-1', DATA_URI);

    expect(findUnique).toHaveBeenCalledWith({ where: { organizationId_imageHash: { organizationId: 'org-1', imageHash: EXPECTED_HASH } } });
  });
});
