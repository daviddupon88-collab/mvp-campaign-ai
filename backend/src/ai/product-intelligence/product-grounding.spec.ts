import { renderGroundedContext } from './product-grounding';
import { ProductIntelligenceProfile } from '@prisma/client';

function buildProfile(overrides: Partial<ProductIntelligenceProfile> = {}): ProductIntelligenceProfile {
  return {
    id: 'profile-1',
    organizationId: 'org-1',
    imageHash: 'hash',
    sourceImageUrl: 'https://example.com/photo.png',
    profileVersion: 1,
    category: 'Chaussures',
    subcategory: 'Running',
    productType: null,
    brand: 'Nike',
    productName: 'Air Zoom',
    model: null,
    visionAnalysis: {},
    identification: {},
    features: ['semelle épaisse', 'mesh respirant'],
    benefits: [],
    usps: ['amorti premium'],
    visibleClaims: ['Sans sulfate'],
    verifiedClaims: [],
    unverifiedClaims: ['Sans sulfate'],
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
    confidence: 0.8,
    lastUpdated: new Date(),
    createdAt: new Date(),
    ...overrides,
  } as ProductIntelligenceProfile;
}

// P0.4 — Product Grounding. Couvre la règle absolue du brief : aucun claim inventé, un prix non
// listé reste absent du texte produit, une information inconnue reste explicitement INCONNUE.
describe('renderGroundedContext', () => {
  it('inclut identité, caractéristiques confirmées et USP détectées', () => {
    const text = renderGroundedContext(buildProfile());

    expect(text).toContain('Chaussures / Running');
    expect(text).toContain('Nike');
    expect(text).toContain('Air Zoom');
    expect(text).toContain('semelle épaisse');
    expect(text).toContain('amorti premium');
  });

  it('indique explicitement que la recherche web est NON DISPONIBLE quand webResearchStatus=NOT_CONFIGURED — jamais silencieusement omis', () => {
    const text = renderGroundedContext(buildProfile({ webResearchStatus: 'NOT_CONFIGURED' }));

    expect(text).toContain('NON DISPONIBLE');
    expect(text).toContain('aucune vérification externe');
  });

  it("n'invente JAMAIS un prix : aucun champ prix n'existe dans le profil, donc aucun prix n'apparaît jamais dans le texte généré", () => {
    const text = renderGroundedContext(buildProfile());

    expect(text).not.toMatch(/\d+\s*€/);
    expect(text).not.toMatch(/\$\d+/);
  });

  it('contient toujours le bloc de règles strictes anti-invention (certification, garantie, témoignage, caractéristique)', () => {
    const text = renderGroundedContext(buildProfile());

    expect(text).toContain('RÈGLES STRICTES DE GROUNDING');
    expect(text).toContain('certification');
    expect(text).toContain('garantie');
    expect(text).toContain('témoignage');
  });

  it('profil sans aucune caractéristique/USP/claim confirmée : reste explicite ("aucune...confirmée"), jamais un champ vide silencieux', () => {
    const text = renderGroundedContext(buildProfile({ features: [], usps: [], visibleClaims: [] }));

    expect(text).toContain('aucune caractéristique distinctive confirmée');
    expect(text).toContain('aucune USP confirmée');
    expect(text).toContain('aucune');
  });

  it("marque/modèle non identifiés (profil incertain) : le texte le dit explicitement, ne fabrique pas un nom", () => {
    const text = renderGroundedContext(buildProfile({ brand: null, productName: null, model: null }));

    expect(text).toContain('marque/modèle non identifiés avec certitude');
  });

  it('les affirmations visibles sur le packaging sont marquées NON vérifiées, jamais présentées comme certaines', () => {
    const text = renderGroundedContext(buildProfile({ visibleClaims: ['Sans sulfate'] }));

    expect(text).toContain('NON vérifiées');
    expect(text).toContain('Sans sulfate');
  });
});
