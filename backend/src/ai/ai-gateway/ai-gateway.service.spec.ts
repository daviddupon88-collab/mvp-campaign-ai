import { AiGatewayService } from './ai-gateway.service';

function buildGateway(aiMode: 'mock' | 'live') {
  const config = { get: jest.fn((key: string, fallback?: any) => (key === 'AI_MODE' ? aiMode : fallback)) } as any;

  const aiGenerationCreate = jest.fn().mockResolvedValue({ id: 'gen-1' });
  const aiGenerationUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    aiGeneration: { create: aiGenerationCreate, update: aiGenerationUpdate, groupBy: jest.fn().mockResolvedValue([]) },
  } as any;

  const entitlements = {
    assertCreditsAvailable: jest.fn().mockResolvedValue(undefined),
    assertBudgetAvailable: jest.fn().mockResolvedValue(undefined),
    assertImageQuotaAvailable: jest.fn().mockResolvedValue(undefined),
    assertVideoQuotaAvailable: jest.fn().mockResolvedValue(undefined),
    consumeCredits: jest.fn().mockResolvedValue(undefined),
  } as any;

  const mockProvider = { name: 'mock', generateVideo: jest.fn().mockResolvedValue({ content: 'https://example.com/mock-video.mp4', provider: 'mock', model: 'mock-video-v1', durationMs: 1 }) };
  const googleVeoProvider = { name: 'google-veo', generateVideo: jest.fn().mockRejectedValue(new Error('Google Veo error: 401 token expired')) };
  const openAiProvider = { name: 'openai' };
  const anthropicProvider = { name: 'anthropic' };
  const fluxProvider = { name: 'flux' };
  const ideogramProvider = { name: 'ideogram' };

  const gateway = new AiGatewayService(
    config,
    prisma,
    entitlements,
    mockProvider as any,
    openAiProvider as any,
    anthropicProvider as any,
    googleVeoProvider as any,
    fluxProvider as any,
    ideogramProvider as any,
  );

  return { gateway, mockProvider, googleVeoProvider, aiGenerationUpdate };
}

// Couvre la correction de l'audit : avant cette correction, 'mock' restait dans la chaîne
// de repli de generateVideo (et de tous les autres types de tâche) même hors AI_MODE=mock —
// un échec Google Veo en production basculait donc silencieusement vers une URL vidéo
// factice, facturée en crédits et marquée SUCCEEDED, indiscernable d'une vraie vidéo.
describe('AiGatewayService — repli mock', () => {
  it("AI_MODE=live : un échec du provider réel ne bascule JAMAIS sur mock, l'erreur remonte telle quelle", async () => {
    const { gateway, mockProvider, googleVeoProvider } = buildGateway('live');

    await expect(
      gateway.generateVideo({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'google-veo'),
    ).rejects.toThrow('Google Veo error');

    expect(googleVeoProvider.generateVideo).toHaveBeenCalledTimes(1);
    expect(mockProvider.generateVideo).not.toHaveBeenCalled();
  });

  it('AI_MODE=live : marque la génération FAILED en base plutôt que de la faire réussir avec un contenu factice', async () => {
    const { gateway, aiGenerationUpdate } = buildGateway('live');

    await expect(
      gateway.generateVideo({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'google-veo'),
    ).rejects.toThrow();

    expect(aiGenerationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it("AI_MODE=mock : utilise directement mock, sans jamais appeler le provider réel (comportement inchangé)", async () => {
    const { gateway, mockProvider, googleVeoProvider } = buildGateway('mock');

    const result = await gateway.generateVideo({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'google-veo');

    expect(result.provider).toBe('mock');
    expect(googleVeoProvider.generateVideo).not.toHaveBeenCalled();
    expect(mockProvider.generateVideo).toHaveBeenCalledTimes(1);
  });
});
