import { CreativeVariationService } from './creative-variation.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { CreativeConcept } from './creative-concept.types';

function buildGatewayMock(content: string) {
  return { generateText: jest.fn(async () => ({ content, provider: 'anthropic', model: 'claude', durationMs: 10 })) } as unknown as AiGatewayService;
}

const promptEngine = new PromptEngineService();
const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };

const ACCEPTED: CreativeConcept = {
  title: 'Vu de loin, protégé de près', concept: 'c', coreMessage: 'm', hook: 'Chantier plongé dans le noir',
  emotionalDirection: 'e', visualDirection: 'Contraste sombre/lumineux', storytellingApproach: 's', proofStrategy: 'p',
  cta: 'Commandez la vôtre', targetAudience: 'Ouvriers du BTP', duration: 20, format: '9:16', scenesCount: 4, qualityAlignment: '', raw: '{}',
};

describe('CreativeVariationService.generateVariations', () => {
  it('génère des variantes qui héritent visualDirection/format/scenesCount du concept accepté (jamais renvoyés par le modèle)', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify([
        { title: 'Variante A', concept: 'x', coreMessage: 'x', hook: 'Un cri dans le noir', emotionalDirection: 'x', storytellingApproach: 'x', proofStrategy: 'x', cta: 'Achetez maintenant' },
        { title: 'Variante B', concept: 'y', coreMessage: 'y', hook: 'Le silence du danger', emotionalDirection: 'y', storytellingApproach: 'y', proofStrategy: 'y', cta: 'Découvrez' },
      ]),
    );
    const service = new CreativeVariationService(gateway, promptEngine);

    const variations = await service.generateVariations(CTX, ACCEPTED);

    expect(variations).toHaveLength(2);
    expect(variations[0].hook).toBe('Un cri dans le noir');
    expect(variations[0].visualDirection).toBe(ACCEPTED.visualDirection);
    expect(variations[0].format).toBe('9:16');
    expect(variations[0].scenesCount).toBe(4);
  });

  it('count cadré [2,3] : 5 demandées -> 3 dans le prompt', async () => {
    const gateway = buildGatewayMock(JSON.stringify([]));
    const service = new CreativeVariationService(gateway, promptEngine);

    await service.generateVariations(CTX, ACCEPTED, 5);

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('EXACTEMENT 3 variantes');
  });

  it('count cadré [2,3] : 1 demandée -> 2 dans le prompt', async () => {
    const gateway = buildGatewayMock(JSON.stringify([]));
    const service = new CreativeVariationService(gateway, promptEngine);

    await service.generateVariations(CTX, ACCEPTED, 1);

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('EXACTEMENT 2 variantes');
  });

  it('une variante malformée au milieu du tableau : ignorée individuellement, les autres conservées', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify([
        { title: 'Variante A', hook: 'x', cta: 'x' },
        { title: 'incomplète' }, // pas de hook/cta -> invalide
        { title: 'Variante C', hook: 'y', cta: 'y' },
      ]),
    );
    const service = new CreativeVariationService(gateway, promptEngine);

    const variations = await service.generateVariations(CTX, ACCEPTED);

    expect(variations).toHaveLength(2);
    expect(variations.map((v) => v.title)).toEqual(['Variante A', 'Variante C']);
  });

  it('réponse non conforme au format JSON attendu : aucune variante produite, ne lève jamais', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas générer de variantes.');
    const service = new CreativeVariationService(gateway, promptEngine);

    const variations = await service.generateVariations(CTX, ACCEPTED);

    expect(variations).toEqual([]);
  });

  it('réponse JSON valide mais pas un tableau : aucune variante produite', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ not: 'an array' }));
    const service = new CreativeVariationService(gateway, promptEngine);

    const variations = await service.generateVariations(CTX, ACCEPTED);

    expect(variations).toEqual([]);
  });

  it('un seul appel IA, quel que soit le nombre de variantes demandées', async () => {
    const gateway = buildGatewayMock(JSON.stringify([]));
    const service = new CreativeVariationService(gateway, promptEngine);

    await service.generateVariations(CTX, ACCEPTED, 3);

    expect((gateway.generateText as jest.Mock).mock.calls.length).toBe(1);
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock(JSON.stringify([]));
    const service = new CreativeVariationService(gateway, promptEngine);

    await service.generateVariations(CTX, ACCEPTED);

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('creative-variation-v1');
  });

  // Bug réel constaté en conditions réelles (2026-08-21) : sans maxTokens explicite, ce call
  // retombait sur le défaut 4000 de AnthropicProvider — jusqu'à 3 concepts complets (14 champs
  // chacun), risque réel élevé de troncature JSON en sortie.
  it('demande un budget de tokens généreux (8000), pas le défaut 4000 — évite la troncature JSON', async () => {
    const gateway = buildGatewayMock(JSON.stringify([]));
    const service = new CreativeVariationService(gateway, promptEngine);

    await service.generateVariations(CTX, ACCEPTED);

    const [, requestParams] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(requestParams.maxTokens).toBe(8000);
  });
});
