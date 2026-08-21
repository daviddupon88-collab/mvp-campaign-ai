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
  const runwayProvider = { name: 'runway', generateVideo: jest.fn().mockRejectedValue(new Error('Runway error: 401 invalid key')) };
  const openAiProvider = {
    name: 'openai',
    generateText: jest.fn().mockResolvedValue({ content: 'texte généré', provider: 'openai', model: 'gpt-5', durationMs: 1 }),
  };
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
    runwayProvider as any,
    fluxProvider as any,
    ideogramProvider as any,
  );

  return { gateway, mockProvider, googleVeoProvider, runwayProvider, openAiProvider, aiGenerationCreate, aiGenerationUpdate };
}

// Couvre la correction de l'audit : avant cette correction, 'mock' restait dans la chaîne
// de repli de generateVideo (et de tous les autres types de tâche) même hors AI_MODE=mock —
// un échec Google Veo en production basculait donc silencieusement vers une URL vidéo
// factice, facturée en crédits et marquée SUCCEEDED, indiscernable d'une vraie vidéo.
describe('AiGatewayService — repli mock', () => {
  it("AI_MODE=live : échec de Google Veo ne bascule JAMAIS sur mock, son erreur remonte telle quelle", async () => {
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

  // Runway retiré du repli le 2026-08-18 (constaté en conditions réelles) : le compte Runway de
  // cet environnement n'est pas activé (pas de crédits) — le garder dans fallbackChains ne
  // faisait qu'ajouter une latence réelle (soumission + polling) vouée à toujours échouer avant
  // l'échec final du plan. RunwayProvider reste câblé (cf. buildGateway ci-dessus) : ce test
  // vérifie qu'il n'est PAS appelé tant qu'il n'est pas remis dans la chaîne — même s'il
  // répondrait avec succès — pour détecter un retour accidentel de 'runway' dans la chaîne
  // avant que le compte ne soit réactivé.
  it("AI_MODE=live : Runway n'est jamais appelé (retiré du repli) même s'il répondrait avec succès", async () => {
    const { gateway, googleVeoProvider, runwayProvider } = buildGateway('live');
    (runwayProvider.generateVideo as jest.Mock).mockResolvedValue({
      content: 'https://example.com/runway-video.mp4',
      provider: 'runway',
      model: 'gen4_turbo',
      durationMs: 1,
    });

    await expect(
      gateway.generateVideo({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'google-veo'),
    ).rejects.toThrow('Google Veo error');

    expect(googleVeoProvider.generateVideo).toHaveBeenCalledTimes(1);
    expect(runwayProvider.generateVideo).not.toHaveBeenCalled();
  });

  it("AI_MODE=mock : utilise directement mock, sans jamais appeler le provider réel (comportement inchangé)", async () => {
    const { gateway, mockProvider, googleVeoProvider } = buildGateway('mock');

    const result = await gateway.generateVideo({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'google-veo');

    expect(result.provider).toBe('mock');
    expect(googleVeoProvider.generateVideo).not.toHaveBeenCalled();
    expect(mockProvider.generateVideo).toHaveBeenCalledTimes(1);
  });

  // Bug corrigé le 2026-08-18 (cf. EntitlementsService.assertVideoQuotaAvailable) : le
  // plafond vidéo distingue désormais "clips DANS cette campagne" de "campagnes distinctes
  // avec vidéo" — il a donc besoin de savoir à QUELLE campagne rattacher chaque appel.
  it('transmet ctx.campaignId à assertVideoQuotaAvailable, pas seulement organizationId', async () => {
    const { gateway } = buildGateway('mock');
    const entitlements = (gateway as any).entitlements;

    await gateway.generateVideo({ organizationId: 'org-1', campaignId: 'camp-42', purpose: 'campaign_generation' }, { prompt: 'x' }, 'google-veo');

    expect(entitlements.assertVideoQuotaAvailable).toHaveBeenCalledWith('org-1', 'camp-42');
  });
});

// Bug corrigé le 2026-08-19 (constaté sur plusieurs campagnes réelles la même nuit — chaque
// campagne finissait par échouer sur un timeout OpenAI différent, sans jamais aboutir) : un
// timeout réseau (AbortError) sur UN SEUL appel abandonnait immédiatement tout le fournisseur,
// faisant échouer toute la campagne (plus de fournisseur de repli après le retrait de
// Runway/Flux/Ideogram) au lieu de retenter cet appel précis.
describe('AiGatewayService — retry sur timeout réseau transitoire', () => {
  it('AbortError (timeout) : retente le MÊME fournisseur et réussit à la 2e tentative, sans jamais basculer sur un autre fournisseur', async () => {
    const { gateway, openAiProvider } = buildGateway('live');
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    (openAiProvider.generateText as jest.Mock)
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({ content: 'texte généré', provider: 'openai', model: 'gpt-5', durationMs: 1 });

    const result = await gateway.generateText({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'openai');

    expect(result.content).toBe('texte généré');
    expect(openAiProvider.generateText).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('AbortError persistant (3 échecs) : épuise ses tentatives sur ce fournisseur puis bascule sur le suivant de la chaîne', async () => {
    const { gateway, openAiProvider, aiGenerationUpdate } = buildGateway('live');
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    (openAiProvider.generateText as jest.Mock).mockRejectedValue(abortError);
    const anthropicProvider = (gateway as any).providers.get('anthropic');
    anthropicProvider.generateText = jest.fn().mockResolvedValue({ content: 'texte via anthropic', provider: 'anthropic', model: 'claude', durationMs: 1 });

    const result = await gateway.generateText({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'openai');

    expect(result.content).toBe('texte via anthropic');
    expect(openAiProvider.generateText).toHaveBeenCalledTimes(3); // épuise ses 3 tentatives sur CE fournisseur
    expect(anthropicProvider.generateText).toHaveBeenCalledTimes(1); // puis le suivant réussit du premier coup
  }, 10_000);

  it("erreur d'authentification (401, non transitoire) : bascule immédiatement sur le fournisseur suivant, sans nouvelle tentative ni délai", async () => {
    const { gateway, openAiProvider } = buildGateway('live');
    (openAiProvider.generateText as jest.Mock).mockRejectedValue(new Error('OpenAI error: 401 invalid_api_key'));
    const anthropicProvider = (gateway as any).providers.get('anthropic');
    anthropicProvider.generateText = jest.fn().mockResolvedValue({ content: 'texte via anthropic', provider: 'anthropic', model: 'claude', durationMs: 1 });

    const result = await gateway.generateText({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'openai');

    expect(result.content).toBe('texte via anthropic');
    expect(openAiProvider.generateText).toHaveBeenCalledTimes(1); // une seule tentative — jamais retentée
  });
});

// Chantier "prompts précis, orientés objectif, tracés" (2026-08-18) : AiGeneration.promptVersion
// existait dans le schéma Prisma depuis sa création mais n'était écrit nulle part — traçabilité
// prévue mais jamais câblée. Couvre le câblage via executeTracked (generateText ici, mais le
// mécanisme est partagé par generateImage/generateVideo/generateAudio/analyzeImage).
describe('AiGatewayService — traçabilité promptVersion', () => {
  it('promptVersion transmis à generateText se retrouve dans le AiGeneration créé en base', async () => {
    const { gateway, aiGenerationCreate } = buildGateway('live');

    await gateway.generateText({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'openai', 'strategy-v1');

    expect(aiGenerationCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ promptVersion: 'strategy-v1' }) }));
  });

  it('promptVersion omis : aucune valeur par défaut forcée, reste undefined dans le AiGeneration créé', async () => {
    const { gateway, aiGenerationCreate } = buildGateway('live');

    await gateway.generateText({ organizationId: 'org-1', purpose: 'campaign_generation' }, { prompt: 'x' }, 'openai');

    expect(aiGenerationCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ promptVersion: undefined }) }));
  });
});
