import { ProductVisionAnalysisService } from './product-vision-analysis.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';

function buildGatewayMock(analyzeImageResponse: string) {
  return {
    analyzeImage: jest.fn(async () => ({ content: analyzeImageResponse, provider: 'openai', model: 'gpt-5', durationMs: 10 })),
  } as unknown as AiGatewayService;
}

// Instance réelle (pas un mock) : ce fichier teste ProductVisionAnalysisService en conditions
// proches du réel, y compris son intégration avec le Prompt Engine V2 (P0.5) — seul le fournisseur
// IA (AiGatewayService) est mocké, comme pour les autres services de ce module.
const promptEngine = new PromptEngineService();

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };

// P0.1 — Product Vision Analysis. Couvre exactement les cas demandés par le brief : produit
// reconnu, catégorie reconnue, texte visible/OCR, marque visible, image ambiguë (repli neutre).
describe('ProductVisionAnalysisService.analyze', () => {
  it('produit clairement reconnu : tous les champs mappés, y compris marque et texte visible (OCR)', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({
        category: 'Chaussures',
        subcategory: 'Running',
        productType: 'Chaussure de sport',
        brand: 'Nike',
        productName: 'Air Zoom',
        model: 'AZ-2024',
        visibleText: ['NIKE', 'AIR ZOOM'],
        logoDetected: true,
        packaging: null,
        colors: ['noir', 'blanc'],
        materials: ['mesh', 'caoutchouc'],
        shape: 'basse',
        visualAttributes: ['semelle épaisse'],
        distinctiveFeatures: ['logo virgule'],
        visibleClaims: [],
        identificationClues: ['logo Nike visible', 'texte AIR ZOOM sur la semelle'],
        confidence: 0.95,
      }),
    );
    const service = new ProductVisionAnalysisService(gateway, promptEngine);

    const result = await service.analyze(CTX, 'https://example.com/photo.png');

    expect(result.brand).toBe('Nike');
    expect(result.visibleText).toEqual(['NIKE', 'AIR ZOOM']);
    expect(result.logoDetected).toBe(true);
    expect(result.category).toBe('Chaussures');
    expect(result.confidence).toBe(0.95);
    expect(result.raw).toContain('Nike');
  });

  it("catégorie reconnue mais marque/modèle absents de l'image : les champs non visibles restent null, jamais devinés", async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({
        category: 'Produits ménagers',
        subcategory: null,
        productType: null,
        brand: null,
        productName: null,
        model: null,
        visibleText: [],
        logoDetected: false,
        packaging: 'flacon plastique',
        colors: ['vert'],
        materials: ['plastique'],
        shape: null,
        visualAttributes: [],
        distinctiveFeatures: [],
        visibleClaims: [],
        identificationClues: ['forme de flacon de nettoyant'],
        confidence: 0.4,
      }),
    );
    const service = new ProductVisionAnalysisService(gateway, promptEngine);

    const result = await service.analyze(CTX, 'https://example.com/photo.png');

    expect(result.category).toBe('Produits ménagers');
    expect(result.brand).toBeNull();
    expect(result.model).toBeNull();
    expect(result.confidence).toBe(0.4);
  });

  it('image ambiguë / réponse non conforme au format JSON : repli neutre (tout à null/vide, confidence 0), ne lève jamais', async () => {
    const gateway = buildGatewayMock("Désolé, je ne peux pas identifier ce produit avec certitude.");
    const service = new ProductVisionAnalysisService(gateway, promptEngine);

    const result = await service.analyze(CTX, 'https://example.com/photo-floue.png');

    expect(result.category).toBeNull();
    expect(result.brand).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.colors).toEqual([]);
    expect(result.raw).toContain('Désolé');
  });

  it('confidence hors bornes (>1 renvoyé par erreur par le modèle) : clampée à 1', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ ...{}, confidence: 1.5 }));
    const service = new ProductVisionAnalysisService(gateway, promptEngine);

    const result = await service.analyze(CTX, 'https://example.com/photo.png');

    expect(result.confidence).toBe(1);
  });

  it("échec total du provider vision (tous fournisseurs indisponibles) : l'erreur remonte, ne pas masquer une vraie panne", async () => {
    const gateway = { analyzeImage: jest.fn().mockRejectedValue(new Error('tous les fournisseurs ont échoué')) } as unknown as AiGatewayService;
    const service = new ProductVisionAnalysisService(gateway, promptEngine);

    await expect(service.analyze(CTX, 'https://example.com/photo.png')).rejects.toThrow('tous les fournisseurs ont échoué');
  });

  it("inclut la description utilisateur fournie dans le prompt, pour recoupement avec l'image", async () => {
    const gateway = buildGatewayMock(JSON.stringify({ confidence: 0.5 }));
    const service = new ProductVisionAnalysisService(gateway, promptEngine);

    await service.analyze(CTX, 'https://example.com/photo.png', 'Une paire de baskets de running rouges');

    const [, params] = (gateway.analyzeImage as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Une paire de baskets de running rouges');
  });

  it('transmet promptVersion pour la traçabilité (distinct de productAnalysis existant)', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ confidence: 0.5 }));
    const service = new ProductVisionAnalysisService(gateway, promptEngine);

    await service.analyze(CTX, 'https://example.com/photo.png');

    const [, , , promptVersion] = (gateway.analyzeImage as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('product-analysis-v2-1');
  });
});
