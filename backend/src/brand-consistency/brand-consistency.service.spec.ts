import { BrandConsistencyService } from './brand-consistency.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService } from '../ai/ai-gateway/ai-gateway.service';
import { ConfigService } from '@nestjs/config';

const BRAND_KIT = { toneOfVoice: 'Direct et énergique', valueProps: ['Confort', 'Durabilité'], colorPalette: ['#0000FF', '#FFFFFF'] };

function buildService(textScoreResponse: unknown, imageScoreResponse: unknown) {
  const brandKitFindUnique = jest.fn().mockResolvedValue(BRAND_KIT);
  const brandConsistencyCheckCreate = jest.fn().mockResolvedValue({ id: 'check-1' });
  const prisma = {
    brandKit: { findUnique: brandKitFindUnique },
    brandConsistencyCheck: { create: brandConsistencyCheckCreate },
  } as unknown as PrismaService;

  const generateText = jest.fn().mockResolvedValue({ content: JSON.stringify(textScoreResponse), provider: 'openai', model: 'test', durationMs: 5 });
  const analyzeImage = jest.fn().mockResolvedValue({ content: JSON.stringify(imageScoreResponse), provider: 'openai', model: 'test-vision', durationMs: 5 });
  const aiGateway = { generateText, analyzeImage } as unknown as AiGatewayService;

  // AI_MODE != 'mock' pour emprunter le chemin AiGateway réel (contrôlable), plutôt que la
  // simulation figée — même convention que ai-optimizer.service.spec.ts.
  const config = { get: jest.fn().mockReturnValue('real') } as unknown as ConfigService;

  const service = new BrandConsistencyService(config, prisma, aiGateway);
  return { service, generateText, analyzeImage, brandKitFindUnique, brandConsistencyCheckCreate };
}

// Chantier "prompts précis, orientés objectif, tracés" (2026-08-18) : BrandConsistencyService
// est un vérificateur (cohérence de ton/palette), délibérément PAS orienté objectif marketing —
// injecter l'objectif ici créerait un risque de biais (un contenu jugé "cohérent" parce qu'il
// "sert l'objectif", ce qu'un contrôle de cohérence de marque ne doit jamais faire, cf. plan).
// Seule la traçabilité (promptVersion) s'applique ici, aucun changement de contenu de prompt.
describe('BrandConsistencyService — traçabilité promptVersion', () => {
  it('scoreTextBatch (generateText) transmet PROMPT_VERSIONS.brandConsistencyText', async () => {
    const { service, generateText } = buildService([{ label: 'copywriting', score: 80, summary: 'ok' }], {});

    await service.runCampaignBrandCheck('org-1', 'campaign-1', [{ label: 'copywriting', text: 'Achetez maintenant' }], []);

    const [, , , promptVersion] = (generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('brand-consistency-text-v1');
  });

  it('scoreImage (analyzeImage) transmet PROMPT_VERSIONS.brandConsistencyImage', async () => {
    const { service, analyzeImage } = buildService([], { score: 78, summary: 'ok' });

    await service.runCampaignBrandCheck('org-1', 'campaign-1', [], [{ label: 'visual', url: 'https://example.com/img.png' }]);

    const [, , , promptVersion] = (analyzeImage as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('brand-consistency-image-v1');
  });

  it("sans Brand Kit renseigné : aucun appel IA, aucun changement de comportement (repli existant, non affecté par ce chantier)", async () => {
    const { service, generateText, analyzeImage, brandKitFindUnique } = buildService([], {});
    (brandKitFindUnique as jest.Mock).mockResolvedValue(null);

    const result = await service.runCampaignBrandCheck('org-1', 'campaign-1', [{ label: 'copywriting', text: 'x' }], []);

    expect(result).toEqual({ overallScore: null, checks: [] });
    expect(generateText).not.toHaveBeenCalled();
    expect(analyzeImage).not.toHaveBeenCalled();
  });
});
