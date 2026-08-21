import { StoryboardGateService, applySafePruning } from './storyboard-gate.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { Shot, ShotPlan } from './video-director.service';

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };
const promptEngine = new PromptEngineService();

function buildGatewayMock(content?: string) {
  return {
    generateText: jest.fn(async () => ({ content: content ?? JSON.stringify(defaultResponse()), provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })),
  } as unknown as AiGatewayService;
}

function defaultResponse(overrides: Record<string, unknown> = {}) {
  return { score: 85, verdict: 'APPROVED', scenesToRemove: [], faiblesses: [], recommandation: '', ...overrides };
}

const CONCEPT: CreativeConcept = {
  title: 't', concept: 'c', coreMessage: 'm', hook: 'h', emotionalDirection: 'e', visualDirection: 'v',
  storytellingApproach: 's', proofStrategy: 'p', cta: 'cta', targetAudience: 'a', duration: 15, format: '9:16', scenesCount: 3, raw: '{}',
};
const HOOK_SHOT: Shot = { sceneId: 'shot-1', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', narrativeRole: 'hook' };
const DEMO_SHOT: Shot = { sceneId: 'shot-2', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', narrativeRole: 'demonstration' };
const CTA_SHOT: Shot = { sceneId: 'shot-3', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', narrativeRole: 'payoff', onScreenText: 'Commandez maintenant' };
const SHOT_PLAN: ShotPlan = [HOOK_SHOT, DEMO_SHOT, CTA_SHOT];

describe('StoryboardGateService.evaluate', () => {
  it('score >=75, verdict APPROVED : status APPROVED', async () => {
    const gateway = buildGatewayMock();
    const service = new StoryboardGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, { creativeConcept: CONCEPT, shotPlan: SHOT_PLAN });

    expect(result.status).toBe('APPROVED');
    expect(result.score).toBe(85);
  });

  it('score <75 : status REJECT même si le champ verdict dit APPROVED (le seuil prime)', async () => {
    const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 60, verdict: 'APPROVED' })));
    const service = new StoryboardGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, { creativeConcept: CONCEPT, shotPlan: SHOT_PLAN });

    expect(result.status).toBe('REJECT');
  });

  it('réponse JSON malformée : repli neutre REJECT, ne lève jamais', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas évaluer ce storyboard.');
    const service = new StoryboardGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, { creativeConcept: CONCEPT, shotPlan: SHOT_PLAN });

    expect(result.status).toBe('REJECT');
    expect(result.score).toBe(50);
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock();
    const service = new StoryboardGateService(gateway, promptEngine);

    await service.evaluate(CTX, { creativeConcept: CONCEPT, shotPlan: SHOT_PLAN });

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('storyboard-gate-v1');
  });
});

describe('applySafePruning', () => {
  it('aucune scène à supprimer : renvoie le plan inchangé', () => {
    expect(applySafePruning(SHOT_PLAN, [])).toEqual(SHOT_PLAN);
  });

  it('supprime une scène secondaire recommandée (ni hook ni CTA) : retirée normalement', () => {
    const result = applySafePruning(SHOT_PLAN, ['shot-2']);

    expect(result.map((s) => s.sceneId)).toEqual(['shot-1', 'shot-3']);
  });

  it('le LLM recommande de supprimer le plan hook : jamais supprimé (garde-fou)', () => {
    const result = applySafePruning(SHOT_PLAN, ['shot-1']);

    expect(result.map((s) => s.sceneId)).toContain('shot-1');
  });

  it('le LLM recommande de supprimer le plan CTA (seul porteur de texte) : jamais supprimé (garde-fou)', () => {
    const result = applySafePruning(SHOT_PLAN, ['shot-3']);

    expect(result.map((s) => s.sceneId)).toContain('shot-3');
  });

  it('le LLM recommande de tout supprimer sauf un plan : le plancher de 2 plans minimum est respecté', () => {
    const fourShots: ShotPlan = [HOOK_SHOT, DEMO_SHOT, { ...DEMO_SHOT, sceneId: 'shot-2b' }, CTA_SHOT];

    const result = applySafePruning(fourShots, ['shot-2', 'shot-2b']);

    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('aucun plan marqué "hook" : le premier plan du storyboard est protégé par repli', () => {
    const noHookPlan: ShotPlan = [{ ...HOOK_SHOT, narrativeRole: undefined }, DEMO_SHOT, CTA_SHOT];

    const result = applySafePruning(noHookPlan, ['shot-1']);

    expect(result.map((s) => s.sceneId)).toContain('shot-1');
  });
});
