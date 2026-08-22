import { ProductPageLlmExtractorService } from './product-page-llm-extractor.service';
import { AiGatewayService } from '../../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../../prompt-engine/prompt-engine.service';

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };
const promptEngine = new PromptEngineService();
const URL = 'https://example.com/produit';

function buildGatewayMock(content?: string) {
  return {
    generateText: jest.fn(async () => ({ content: content ?? JSON.stringify(validResponse()), provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })),
  } as unknown as AiGatewayService;
}

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Gilet haute visibilité',
    brand: 'SafeWear',
    description: 'Gilet réfléchissant',
    specifications: [
      { key: 'Poids', value: '200', unit: 'g', status: 'OBSERVED' },
      { key: 'Catégorie déduite', value: 'EPI', unit: null, status: 'INFERRED' },
    ],
    price: { amount: 19.9, currency: 'EUR' },
    availability: 'En stock',
    ...overrides,
  };
}

describe('ProductPageLlmExtractorService.extract', () => {
  it("extrait les specifications OBSERVED uniquement, jamais INFERRED (jamais traité comme un fait vérifié)", async () => {
    const gateway = buildGatewayMock();
    const service = new ProductPageLlmExtractorService(gateway, promptEngine);

    const result = await service.extract(CTX, '<html><body>contenu</body></html>', URL);

    expect(result.specifications).toEqual([{ key: 'Poids', value: '200', unit: 'g' }]);
    expect(result.specifications.some((s) => s.key === 'Catégorie déduite')).toBe(false);
    expect(result.extractionMethod).toBe('LLM');
  });

  it('les claims générées portent une évidence marquée "extraction LLM"', async () => {
    const gateway = buildGatewayMock();
    const service = new ProductPageLlmExtractorService(gateway, promptEngine);

    const result = await service.extract(CTX, '<html></html>', URL);

    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims.every((c) => c.evidence.includes('extraction LLM'))).toBe(true);
    expect(result.claims.every((c) => c.source === 'PRODUCT_URL')).toBe(true);
  });

  it('tronque/nettoie le HTML avant de le transmettre au prompt (jamais le HTML brut)', async () => {
    const gateway = buildGatewayMock();
    const service = new ProductPageLlmExtractorService(gateway, promptEngine);

    await service.extract(CTX, '<html><script>alert(1)</script><body><h1>Titre visible</h1></body></html>', URL);

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).not.toContain('<script>');
    expect(params.prompt).not.toContain('<h1>');
    expect(params.prompt).toContain('Titre visible');
  });

  it('1er essai JSON invalide, 2e essai exploitable : retourne le résultat de la 2e tentative', async () => {
    const gateway = {
      generateText: jest.fn()
        .mockResolvedValueOnce({ content: 'Désolé, je ne peux pas extraire.', provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })
        .mockResolvedValueOnce({ content: JSON.stringify(validResponse()), provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 }),
    } as unknown as AiGatewayService;
    const service = new ProductPageLlmExtractorService(gateway, promptEngine);

    const result = await service.extract(CTX, '<html></html>', URL);

    expect(gateway.generateText as jest.Mock).toHaveBeenCalledTimes(2);
    expect(result.title).toBe('Gilet haute visibilité');
  });

  it('échec des 2 tentatives : repli vide avec warning, ne lève jamais', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas extraire.');
    const service = new ProductPageLlmExtractorService(gateway, promptEngine);

    const result = await service.extract(CTX, '<html></html>', URL);

    expect(result.specifications).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock();
    const service = new ProductPageLlmExtractorService(gateway, promptEngine);

    await service.extract(CTX, '<html></html>', URL);

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('product-page-extraction-v1');
  });
});
