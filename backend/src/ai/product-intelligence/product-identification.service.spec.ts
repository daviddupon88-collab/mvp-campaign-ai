import { ProductIdentificationService } from './product-identification.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { ProductVisionAnalysis } from './product-intelligence.types';

function buildGatewayMock(generateTextContent: string) {
  return {
    generateText: jest.fn(async () => ({ content: generateTextContent, provider: 'anthropic', model: 'claude', durationMs: 10 })),
  } as unknown as AiGatewayService;
}

const promptEngine = new PromptEngineService();

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
  visualAttributes: [],
  distinctiveFeatures: [],
  visibleClaims: [],
  identificationClues: ['logo Nike visible'],
  confidence: 0.8,
  raw: '{}',
};

// P0.2 — Product Identification. Couvre exactement les cas du brief : produit confirmé,
// plusieurs candidats proches, produit inconnu — et la règle absolue "ne jamais transformer
// une hypothèse en fait" (confidenceLevel dérivé déterministe, jamais auto-déclaré par le LLM).
describe('ProductIdentificationService.identify', () => {
  it('un seul candidat net avec un score élevé -> CONFIRMED', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ candidates: [{ name: 'Nike Air Zoom', brand: 'Nike', model: 'AZ-2024', matchScore: 0.92, reason: 'Logo et texte NIKE visibles' }] }));
    const service = new ProductIdentificationService(gateway, promptEngine);

    const result = await service.identify(CTX, VISION);

    expect(result.confidenceLevel).toBe('CONFIRMED');
    expect(result.bestMatch).toBe('Nike Air Zoom');
    expect(result.confidence).toBe(0.92);
  });

  it('plusieurs candidats proches, aucun net -> PROBABLE ou UNCERTAIN selon le meilleur score, tous les candidats conservés (pas juste le meilleur)', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({
        candidates: [
          { name: 'Nike Air Zoom Pegasus', brand: 'Nike', model: null, matchScore: 0.55, reason: 'Forme compatible' },
          { name: 'Nike Air Zoom Structure', brand: 'Nike', model: null, matchScore: 0.5, reason: 'Couleur compatible' },
        ],
      }),
    );
    const service = new ProductIdentificationService(gateway, promptEngine);

    const result = await service.identify(CTX, VISION);

    expect(result.candidates).toHaveLength(2);
    expect(result.confidenceLevel).toBe('UNCERTAIN'); // 0.55 < seuil PROBABLE (0.6)
    expect(result.bestMatch).toBe('Nike Air Zoom Pegasus'); // le plus haut score, pas le premier de la liste
  });

  it('produit inconnu (candidates vide) -> UNKNOWN, bestMatch null, jamais une hypothèse inventée', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ candidates: [] }));
    const service = new ProductIdentificationService(gateway, promptEngine);

    const result = await service.identify(CTX, VISION);

    expect(result.confidenceLevel).toBe('UNKNOWN');
    expect(result.bestMatch).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('réponse non conforme au format JSON attendu -> repli sur UNKNOWN, ne lève jamais', async () => {
    const gateway = buildGatewayMock('Je ne suis pas certain de pouvoir identifier ce produit.');
    const service = new ProductIdentificationService(gateway, promptEngine);

    const result = await service.identify(CTX, VISION);

    expect(result.confidenceLevel).toBe('UNKNOWN');
    expect(result.candidates).toEqual([]);
  });

  it('candidat malformé (champ requis manquant) filtré, les candidats valides restent', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({
        candidates: [
          { name: 'Produit valide', matchScore: 0.7, reason: 'ok' },
          { brand: 'SansNom', matchScore: 0.9 }, // pas de "name" ni "reason" -> invalide
        ],
      }),
    );
    const service = new ProductIdentificationService(gateway, promptEngine);

    const result = await service.identify(CTX, VISION);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].name).toBe('Produit valide');
  });

  it("n'appelle jamais analyzeImage — raisonne uniquement sur l'analyse vision déjà extraite (pas un 2e appel vision)", async () => {
    const analyzeImage = jest.fn();
    const gateway = { generateText: jest.fn(async () => ({ content: JSON.stringify({ candidates: [] }), provider: 'anthropic', model: 'claude', durationMs: 10 })), analyzeImage } as unknown as AiGatewayService;
    const service = new ProductIdentificationService(gateway, promptEngine);

    await service.identify(CTX, VISION);

    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("route bien vers 'anthropic' (raisonnement), pas openai, et transmet promptVersion pour la traçabilité", async () => {
    const gateway = buildGatewayMock(JSON.stringify({ candidates: [] }));
    const service = new ProductIdentificationService(gateway, promptEngine);

    await service.identify(CTX, VISION);

    const [, , provider, promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(provider).toBe('anthropic');
    expect(promptVersion).toBe('product-identification-v1');
  });
});
