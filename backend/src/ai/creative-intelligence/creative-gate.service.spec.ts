import { CreativeGateService } from './creative-gate.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { CreativeIntelligence } from './creative-intelligence.types';
import { CreativeConcept } from './creative-concept.types';

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };
const promptEngine = new PromptEngineService();

function buildGatewayMock(content?: string) {
  return {
    generateText: jest.fn(async () => ({ content: content ?? JSON.stringify(defaultResponse()), provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })),
  } as unknown as AiGatewayService;
}

function defaultResponse(overrides: Record<string, unknown> = {}) {
  return {
    score: 85,
    verdict: 'APPROVED',
    hook: 'Un chantier plongé dans le noir',
    promessePrincipale: 'Visible dans le noir, protégé de jour',
    benefices: ['Visibilité 360°'],
    preuve: 'Bandes réfléchissantes qui captent la lumière',
    cta: 'Commandez la vôtre',
    forces: ['hook fort'],
    faiblesses: [],
    risques: [],
    causesDeRejet: [],
    recommandation: '',
    ...overrides,
  };
}

const INTELLIGENCE: CreativeIntelligence = {
  adObjective: 'x', targetAudience: 'Ouvriers du BTP', primaryProblem: 'x', primaryDesire: 'x',
  primaryBenefit: 'Visibilité 360°', valueProposition: 'x', creativeAngle: 'x', desiredEmotion: 'x',
  hook: 'x', proofToShow: 'x', objections: [], mainMessage: 'x', cta: 'Commandez la vôtre',
  visualTone: 'x', pacing: 'x', adStyle: 'x', raw: '{}',
};
const CONCEPT: CreativeConcept = {
  title: 't', concept: 'c', coreMessage: 'La visibilité sauve des vies', hook: 'Un chantier plongé dans le noir',
  emotionalDirection: 'e', visualDirection: 'v', storytellingApproach: 's', proofStrategy: 'p',
  cta: 'Commandez la vôtre', targetAudience: 'Ouvriers du BTP', duration: 15, format: '9:16', scenesCount: 3, raw: '{}',
};

function buildParams(overrides: { intelligence?: CreativeIntelligence; concept?: CreativeConcept } = {}) {
  return {
    creativeIntelligence: overrides.intelligence ?? INTELLIGENCE,
    creativeConcept: overrides.concept ?? CONCEPT,
    objective: 'Générer des ventes',
    productProfile: null,
  };
}

describe('CreativeGateService.evaluate', () => {
  it('score >=75, aucun motif de rejet : APPROVED', async () => {
    const gateway = buildGatewayMock();
    const service = new CreativeGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(result.status).toBe('APPROVED');
    expect(result.score).toBe(85);
    expect(result.hook).toBe('Un chantier plongé dans le noir');
  });

  it('score <75 sans motif de rejet automatique : REVISE', async () => {
    const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 60, verdict: 'REVISE' })));
    const service = new CreativeGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(result.status).toBe('REVISE');
  });

  it('motif de rejet automatique présent MALGRÉ un score >=75 : BLOCKED quand même (le score seul ne suffit pas)', async () => {
    const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 90, verdict: 'APPROVED', causesDeRejet: ['le produit apparaît de façon purement décorative'] })));
    const service = new CreativeGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(result.status).toBe('BLOCKED');
    expect(result.causesDeRejet).toContain('le produit apparaît de façon purement décorative');
  });

  it('information critique manquante (aucun bénéfice, hook, message ni CTA) : BLOCKED SANS appeler generateText', async () => {
    const gateway = buildGatewayMock();
    const service = new CreativeGateService(gateway, promptEngine);
    const emptyIntelligence: CreativeIntelligence = { ...INTELLIGENCE, primaryBenefit: '', cta: '', targetAudience: '' };
    const emptyConcept: CreativeConcept = { ...CONCEPT, hook: '', coreMessage: '', cta: '', targetAudience: '' };

    const result = await service.evaluate(CTX, buildParams({ intelligence: emptyIntelligence, concept: emptyConcept }));

    expect(result.status).toBe('BLOCKED');
    expect(result.causesDeRejet.length).toBeGreaterThan(0);
    expect(gateway.generateText as jest.Mock).not.toHaveBeenCalled();
  });

  it('réponse JSON malformée : repli neutre REVISE, ne lève jamais', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas évaluer ce concept.');
    const service = new CreativeGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(result.status).toBe('REVISE');
    expect(result.score).toBe(50);
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock();
    const service = new CreativeGateService(gateway, promptEngine);

    await service.evaluate(CTX, buildParams());

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('creative-gate-v1');
  });
});
