import { CreativeConceptService } from './creative-concept.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { CreativeIntelligence } from './creative-intelligence.types';

function buildGatewayMock(content: string) {
  return {
    generateText: jest.fn(async () => ({ content, provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })),
  } as unknown as AiGatewayService;
}

const promptEngine = new PromptEngineService();

const CREATIVE_INTELLIGENCE: CreativeIntelligence = {
  adObjective: 'Générer des ventes',
  targetAudience: 'Ouvriers du BTP',
  primaryProblem: 'Visibilité insuffisante de nuit',
  primaryDesire: 'Se sentir en sécurité',
  primaryBenefit: 'Visibilité 360°',
  valueProposition: 'Visible dans le noir, confortable le jour',
  creativeAngle: 'La sécurité qui ne se voit pas... jusqu\'à ce qu\'elle sauve',
  desiredEmotion: 'Confiance',
  hook: 'Un chantier plongé dans le noir',
  proofToShow: 'Les bandes réfléchissantes captent la lumière des phares',
  objections: [],
  mainMessage: 'Vu de loin, protégé de près',
  cta: 'Commandez la vôtre',
  visualTone: 'Sombre puis lumineux',
  pacing: 'Contrasté',
  adStyle: 'Démonstration dramatique',
  raw: '{}',
};

describe('CreativeConceptService.generate', () => {
  it('transforme la Creative Intelligence en concept structuré à 13 champs', async () => {
    const gateway = buildGatewayMock(
      JSON.stringify({
        title: 'Vu de loin, protégé de près',
        concept: 'Un travailleur invisible dans le noir devient soudain visible grâce au gilet',
        coreMessage: 'La visibilité sauve des vies',
        hook: 'Plan large, chantier plongé dans le noir',
        emotionalDirection: 'Tension puis soulagement',
        visualDirection: 'Contraste sombre/lumineux',
        storytellingApproach: 'Problème puis démonstration',
        proofStrategy: 'Gros plan sur les bandes réfléchissantes qui captent la lumière',
        cta: 'Commandez la vôtre',
        targetAudience: 'Ouvriers du BTP',
        duration: 20,
        scenesCount: 4,
      }),
    );
    const service = new CreativeConceptService(gateway, promptEngine);

    const result = await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { creativeIntelligence: CREATIVE_INTELLIGENCE });

    expect(result.title).toBe('Vu de loin, protégé de près');
    expect(result.scenesCount).toBe(4);
    expect(result.duration).toBe(20);
    expect(result.format).toBe('9:16');
  });

  it('scenesCount hors bornes (7 renvoyé par erreur) : cadré à 5 (MAX_SCENES)', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 7 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    const result = await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { creativeIntelligence: CREATIVE_INTELLIGENCE });

    expect(result.scenesCount).toBe(5);
  });

  it('scenesCount hors bornes (1 renvoyé par erreur) : cadré à 2 (MIN_SCENES)', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 1 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    const result = await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { creativeIntelligence: CREATIVE_INTELLIGENCE });

    expect(result.scenesCount).toBe(2);
  });

  it('réponse non conforme au format JSON attendu : repli scenesCount=3 (comportement historique inchangé), ne lève jamais', async () => {
    const gateway = buildGatewayMock("Désolé, je ne peux pas répondre.");
    const service = new CreativeConceptService(gateway, promptEngine);

    const result = await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { creativeIntelligence: CREATIVE_INTELLIGENCE });

    expect(result.scenesCount).toBe(3);
    expect(result.title).toBe('');
    expect(result.raw).toContain('Désolé');
  });

  it("le prompt embarque l'exemple mauvais/bon (règle démonstration > description) et l'intelligence créative fournie", async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 3 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { creativeIntelligence: CREATIVE_INTELLIGENCE });

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('MAUVAIS');
    expect(params.prompt).toContain('BON');
    expect(params.prompt).toContain('Ouvriers du BTP');
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 3 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    await service.generate({ organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' }, { creativeIntelligence: CREATIVE_INTELLIGENCE });

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('video-concept-v1');
  });
});
