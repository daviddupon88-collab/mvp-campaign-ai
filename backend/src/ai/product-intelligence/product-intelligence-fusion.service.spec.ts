import { ProductIntelligenceFusionService } from './product-intelligence-fusion.service';
import { ProductVisionAnalysis } from './product-intelligence.types';
import { ProductUrlFacts } from './product-page/product-url-facts.types';

const VISION: ProductVisionAnalysis = {
  category: 'Gilet de sécurité', subcategory: null, productType: null, brand: 'SafeWear', productName: 'Gilet Pro',
  model: null, visibleText: [], logoDetected: true, packaging: null, colors: ['jaune'], materials: ['polyester'],
  shape: null, visualAttributes: [], distinctiveFeatures: ['bandes réfléchissantes'], visibleClaims: [],
  identificationClues: [], confidence: 0.8, raw: '{}',
};

function urlFacts(overrides: Partial<ProductUrlFacts> = {}): ProductUrlFacts {
  return {
    sourceUrl: 'https://example.com/produit', title: 'Gilet Pro', brand: 'SafeWear', category: undefined,
    description: 'Gilet réfléchissant', specifications: [], claims: [], images: [], price: undefined,
    availability: undefined, extractionMethod: 'JSON_LD', warnings: [],
    ...overrides,
  };
}

describe('ProductIntelligenceFusionService.fuse', () => {
  const service = new ProductIntelligenceFusionService();

  it('même valeur des deux sources (brand) : fait résolu, aucun conflit, confiance renforcée', () => {
    const result = service.fuse(VISION, urlFacts(), undefined);

    const brandFact = result.facts.find((f) => f.key === 'brand');
    expect(brandFact).toBeDefined();
    expect(brandFact!.value).toBe('SafeWear');
    expect(result.conflicts).toEqual([]);
  });

  it('valeurs différentes (brand IMAGE vs PRODUCT_URL, écart de confiance net) : conflit détecté, résolu par priorité PRODUCT_URL', () => {
    const visionWithDifferentBrand: ProductVisionAnalysis = { ...VISION, brand: 'AutreMarque', confidence: 0.4 };
    const result = service.fuse(visionWithDifferentBrand, urlFacts({ brand: 'SafeWear' }), undefined);

    const conflict = result.conflicts.find((c) => c.attribute === 'brand');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('URL_PREFERRED');
    expect(conflict!.sources).toHaveLength(2);
    const brandFact = result.facts.find((f) => f.key === 'brand');
    expect(brandFact!.value).toBe('SafeWear');
  });

  it('conflit avec confiances trop proches : UNRESOLVED, aucun fait résolu pour cet attribut', () => {
    const visionSameConfidence: ProductVisionAnalysis = { ...VISION, brand: 'AutreMarque', confidence: 0.85 };
    const result = service.fuse(visionSameConfidence, urlFacts({ brand: 'SafeWear' }), undefined);

    const conflict = result.conflicts.find((c) => c.attribute === 'brand');
    expect(conflict!.resolution).toBe('UNRESOLVED');
    expect(result.facts.some((f) => f.key === 'brand')).toBe(false);
  });

  it('un seul candidat pour un attribut : fait résolu directement, jamais de conflit', () => {
    const visionNoBrand: ProductVisionAnalysis = { ...VISION, brand: null };
    const result = service.fuse(visionNoBrand, urlFacts({ brand: 'SafeWear' }), undefined);

    expect(result.conflicts.find((c) => c.attribute === 'brand')).toBeUndefined();
    expect(result.facts.find((f) => f.key === 'brand')?.source).toBe('PRODUCT_URL');
  });

  it('attributs purement visuels (matériau/couleur) : toujours source IMAGE, jamais de conflit', () => {
    const result = service.fuse(VISION, urlFacts(), undefined);

    expect(result.facts.filter((f) => f.key === 'material').every((f) => f.source === 'IMAGE')).toBe(true);
    expect(result.facts.filter((f) => f.key === 'color').every((f) => f.source === 'IMAGE')).toBe(true);
  });

  it('specifications structurées de l\'URL deviennent des ProductFact source PRODUCT_URL', () => {
    const result = service.fuse(VISION, urlFacts({ specifications: [{ key: 'Poids', value: '500', unit: 'g' }] }), undefined);

    const spec = result.facts.find((f) => f.key === 'Poids');
    expect(spec).toBeDefined();
    expect(spec!.source).toBe('PRODUCT_URL');
    expect(spec!.value).toBe('500 g');
  });

  it('aucun URL disponible (null) : fonctionne uniquement sur photo + description, jamais une erreur', () => {
    const result = service.fuse(VISION, null, 'Un gilet jaune pour le chantier');

    expect(result.facts.find((f) => f.key === 'brand')?.source).toBe('IMAGE');
    expect(result.facts.find((f) => f.key === 'user_description')).toBeDefined();
    expect(result.conflicts).toEqual([]);
  });

  it('les claims proviennent intégralement de urlFacts.claims (aucune claim générée pour vision/description)', () => {
    const claimFromUrl = { id: 'c1', text: 'Poids : 500 g', source: 'PRODUCT_URL' as const, evidence: 'JSON-LD', confidence: 0.9, allowedForAdvertising: true };
    const result = service.fuse(VISION, urlFacts({ claims: [claimFromUrl] }), 'texte libre');

    expect(result.claims).toEqual([claimFromUrl]);
  });
});
