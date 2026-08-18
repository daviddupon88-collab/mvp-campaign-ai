import { ModerationService } from './moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService } from '../ai/ai-gateway/ai-gateway.service';
import { ConfigService } from '@nestjs/config';

function buildService(
  opts: {
    aiMode?: 'mock' | 'real';
    claimsResponse?: unknown;
    objectiveResponse?: unknown;
    trademarkResponse?: unknown;
    moderateTextResult?: { flagged: boolean; categories: string[] };
    generateTextImpl?: (prompt: string) => unknown; // pour simuler une réponse malformée ciblée
  } = {},
) {
  const {
    aiMode = 'real',
    claimsResponse = [],
    objectiveResponse = { achieved: true, summary: 'Objectif atteint' },
    trademarkResponse = { detected: false, brands: [] },
    moderateTextResult = { flagged: false, categories: [] },
    generateTextImpl,
  } = opts;

  const config = { get: jest.fn().mockReturnValue(aiMode === 'mock' ? 'mock' : 'real') } as unknown as ConfigService;

  const moderationCheckCreate = jest.fn().mockResolvedValue({ id: 'check-1' });
  const prisma = { moderationCheck: { create: moderationCheckCreate } } as unknown as PrismaService;

  const moderateText = jest.fn().mockResolvedValue(moderateTextResult);
  // Les deux checks batchés (promesses trompeuses / atteinte de l'objectif) passent tous les
  // deux par generateText — routage par mot-clé distinctif du prompt, même principe que le
  // mock partagé de ai-orchestrator.service.spec.ts (buildGatewayMock).
  const generateText = jest.fn(async (_ctx: unknown, params: { prompt: string }) => {
    if (generateTextImpl) {
      const raw = generateTextImpl(params.prompt);
      return { content: typeof raw === 'string' ? raw : JSON.stringify(raw), provider: 'anthropic', model: 'test', durationMs: 5 };
    }
    if (params.prompt.includes('atteint-il PLEINEMENT')) {
      return { content: JSON.stringify(objectiveResponse), provider: 'anthropic', model: 'test', durationMs: 5 };
    }
    return { content: JSON.stringify(claimsResponse), provider: 'openai', model: 'test', durationMs: 5 };
  });
  const analyzeImage = jest.fn().mockResolvedValue({ content: JSON.stringify(trademarkResponse), provider: 'openai', model: 'test-vision', durationMs: 5 });
  const aiGateway = { moderateText, generateText, analyzeImage } as unknown as AiGatewayService;

  const service = new ModerationService(config, prisma, aiGateway);
  return { service, moderateText, generateText, analyzeImage, moderationCheckCreate };
}

// Chantier "valider seulement si l'objectif complet de campaign-ai est atteint sans exception"
// (2026-08-18) : nouveau 4e type de vérification, OBJECTIVE_ACHIEVEMENT. Contrairement aux 3
// checks existants (sécurité/légalité), celui-ci juge SPÉCIFIQUEMENT l'atteinte de l'objectif
// marketing — et n'a que deux issues de jugement : PASSED ou BLOCKED, jamais de demi-mesure
// (FLAGGED réservé exclusivement à une panne du service IA lui-même, pas à un jugement mitigé).
describe('ModerationService.checkObjectiveAchievement (via runCampaignModeration)', () => {
  it('achieved:true -> le check est PASSED', async () => {
    const { service, moderationCheckCreate } = buildService({ objectiveResponse: { achieved: true, summary: 'Objectif atteint' } });

    const result = await service.runCampaignModeration('org-1', 'campaign-1', 'Attirer des clients B2B', [], []);

    const objectiveCheck = result.checks.find((c) => c.checkType === 'OBJECTIVE_ACHIEVEMENT');
    expect(objectiveCheck).toEqual(expect.objectContaining({ status: 'PASSED', label: 'campaign' }));
    expect(moderationCheckCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ checkType: 'OBJECTIVE_ACHIEVEMENT', status: 'PASSED', contentId: 'campaign' }) }));
  });

  it("achieved:false -> le check est BLOCKED, JAMAIS FLAGGED (c'est le point central de \"sans exception\")", async () => {
    const { service } = buildService({ objectiveResponse: { achieved: false, summary: 'Contenu hors-sujet par rapport à l\'objectif' } });

    const result = await service.runCampaignModeration('org-1', 'campaign-1', 'Attirer des clients B2B', [], []);

    const objectiveCheck = result.checks.find((c) => c.checkType === 'OBJECTIVE_ACHIEVEMENT');
    expect(objectiveCheck?.status).toBe('BLOCKED');
    expect(objectiveCheck?.summary).toContain('hors-sujet');
  });

  it('un objectif non atteint fait basculer le VERDICT GLOBAL à BLOCKED même si tous les autres checks sont PASSED', async () => {
    const { service } = buildService({
      objectiveResponse: { achieved: false, summary: 'Objectif non atteint' },
      claimsResponse: [], // aucune promesse trompeuse détectée
      moderateTextResult: { flagged: false, categories: [] }, // aucune toxicité
    });

    const result = await service.runCampaignModeration('org-1', 'campaign-1', 'Attirer des clients B2B', [{ label: 'copywriting', text: 'Achetez nos chaussures.' }], []);

    expect(result.verdict).toBe('BLOCKED');
  });

  it('réponse JSON malformée -> FLAGGED (revue humaine), PAS BLOCKED : une panne technique ne doit jamais bloquer automatiquement une campagne', async () => {
    const { service } = buildService({ generateTextImpl: () => 'Désolé, je ne peux pas répondre.' });

    const result = await service.runCampaignModeration('org-1', 'campaign-1', 'Attirer des clients B2B', [], []);

    const objectiveCheck = result.checks.find((c) => c.checkType === 'OBJECTIVE_ACHIEVEMENT');
    expect(objectiveCheck?.status).toBe('FLAGGED');
  });

  it('champ "achieved" absent de la réponse -> FLAGGED, pas BLOCKED', async () => {
    const { service } = buildService({ generateTextImpl: (prompt) => (prompt.includes('atteint-il PLEINEMENT') ? { summary: 'sans le champ achieved' } : []) });

    const result = await service.runCampaignModeration('org-1', 'campaign-1', 'Attirer des clients B2B', [], []);

    const objectiveCheck = result.checks.find((c) => c.checkType === 'OBJECTIVE_ACHIEVEMENT');
    expect(objectiveCheck?.status).toBe('FLAGGED');
  });

  it("échec total de generateText -> FLAGGED, pas BLOCKED", async () => {
    const { service, generateText } = buildService();
    (generateText as jest.Mock).mockImplementation(async (_ctx: unknown, params: { prompt: string }) => {
      if (params.prompt.includes('atteint-il PLEINEMENT')) throw new Error('panne fournisseur');
      return { content: JSON.stringify([]), provider: 'openai', model: 'test', durationMs: 5 };
    });

    const result = await service.runCampaignModeration('org-1', 'campaign-1', 'Attirer des clients B2B', [], []);

    const objectiveCheck = result.checks.find((c) => c.checkType === 'OBJECTIVE_ACHIEVEMENT');
    expect(objectiveCheck?.status).toBe('FLAGGED');
  });

  it('mode mock (AI_MODE=mock) : simulation PASSED, aucun appel IA réel', async () => {
    const { service, generateText } = buildService({ aiMode: 'mock' });

    const result = await service.runCampaignModeration('org-1', 'campaign-1', 'Attirer des clients B2B', [{ label: 'x', text: 'y' }], []);

    const objectiveCheck = result.checks.find((c) => c.checkType === 'OBJECTIVE_ACHIEVEMENT');
    expect(objectiveCheck?.status).toBe('PASSED');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('promptVersion transmis à generateText est bien PROMPT_VERSIONS.moderationObjectiveAchievement', async () => {
    const { service, generateText } = buildService();

    await service.runCampaignModeration('org-1', 'campaign-1', 'Attirer des clients B2B', [], []);

    const objectiveCall = (generateText as jest.Mock).mock.calls.find((c) => c[1].prompt.includes('atteint-il PLEINEMENT'));
    expect(objectiveCall[3]).toBe('moderation-objective-achievement-v1');
  });
});

describe('ModerationService — traçabilité promptVersion (checks existants, aucun changement de contenu)', () => {
  it('checkMisleadingClaimsBatch transmet PROMPT_VERSIONS.moderationMisleadingClaims', async () => {
    const { service, generateText } = buildService();

    await service.runCampaignModeration('org-1', 'campaign-1', 'x', [{ label: 'copywriting', text: 'Achetez maintenant' }], []);

    const claimsCall = (generateText as jest.Mock).mock.calls.find((c) => !c[1].prompt.includes('atteint-il PLEINEMENT'));
    expect(claimsCall[3]).toBe('moderation-misleading-claims-v1');
  });

  it('checkTrademarkInImage transmet PROMPT_VERSIONS.moderationTrademark', async () => {
    const { service, analyzeImage } = buildService();

    await service.runCampaignModeration('org-1', 'campaign-1', 'x', [], [{ label: 'visual', url: 'https://example.com/img.png' }]);

    const [, , , promptVersion] = (analyzeImage as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('moderation-trademark-v1');
  });
});
