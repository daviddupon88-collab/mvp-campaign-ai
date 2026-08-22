import { CreativeConceptService } from './creative-concept.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { CreativeIntelligence } from './creative-intelligence.types';
import { QualityTarget } from '../quality/quality-target';

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

// Mission 4.3 (Goal-First Quality Architecture, Phase 2) — QualityTarget de test, criticalCriteria
// non vide pour pouvoir vérifier que le bloc d'exigences de construction atteint bien le prompt.
const TARGET: QualityTarget = {
  targetScore: 75,
  version: 'test-v1',
  criticalCriteria: ['hookStrength', 'ctaClarity', 'storytelling'],
  minimumCriticalScore: 60,
  prohibitedConditions: [],
};

describe('CreativeConceptService.generate', () => {
  it('transforme la Creative Intelligence en concept structuré à 14 champs (dont qualityAlignment)', async () => {
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
        qualityAlignment: 'Hook : plan large chantier noir = événement visuel dès la 1ère seconde. CTA : présent en voix off ET à l\'écran.',
      }),
    );
    const service = new CreativeConceptService(gateway, promptEngine);

    const result = await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    expect(result.title).toBe('Vu de loin, protégé de près');
    expect(result.scenesCount).toBe(4);
    expect(result.duration).toBe(20);
    expect(result.format).toBe('9:16');
    expect(result.qualityAlignment).toContain('Hook');
  });

  it('scenesCount hors bornes (7 renvoyé par erreur) : cadré à 5 (MAX_SCENES)', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 7 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    const result = await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    expect(result.scenesCount).toBe(5);
  });

  it('scenesCount hors bornes (1 renvoyé par erreur) : cadré à 2 (MIN_SCENES)', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 1 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    const result = await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    expect(result.scenesCount).toBe(2);
  });

  it('réponse non conforme au format JSON attendu : repli scenesCount=3 (comportement historique inchangé), ne lève jamais', async () => {
    const gateway = buildGatewayMock("Désolé, je ne peux pas répondre.");
    const service = new CreativeConceptService(gateway, promptEngine);

    const result = await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    expect(result.scenesCount).toBe(3);
    expect(result.title).toBe('');
    expect(result.qualityAlignment).toBe('');
    expect(result.raw).toContain('Désolé');
  });

  it("le prompt embarque l'exemple mauvais/bon (règle démonstration > description) et l'intelligence créative fournie", async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 3 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('MAUVAIS');
    expect(params.prompt).toContain('BON');
    expect(params.prompt).toContain('Ouvriers du BTP');
  });

  // Audit forensic (2026-08-22, campagnes réelles) : "proofToShow" (SHOW > TELL, déjà discipliné
  // dans CreativeIntelligenceService) se diluait en affirmation verbale au moment précis où il
  // devient "proofStrategy" — corrompant toute la chaîne en aval (NarrativeBlueprint, Shot Plan).
  it('le prompt réaffirme explicitement la règle SHOW > TELL pour proofStrategy, pas seulement héritée de proofToShow', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 3 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('RÈGLE SHOW > TELL (proofStrategy)');
    expect(params.prompt).toContain('ne peut pas être filmé tel quel par une caméra');
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 3 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('video-concept-v3');
  });

  // Bug réel constaté en conditions réelles (2026-08-21) : sans maxTokens explicite, ce call
  // retombait sur le défaut 4000 de AnthropicProvider — schéma à 14 champs texte, risque réel de
  // troncature JSON en sortie.
  it('demande un budget de tokens généreux (8000), pas le défaut 4000 — évite la troncature JSON', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 3 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    const [, requestParams] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(requestParams.maxTokens).toBe(8000);
  });

  // Mission 4.3 (Goal-First Quality Architecture, Phase 2, Étape 3) — preuve que le concept est
  // construit AVEC les exigences de qualité, pas seulement évalué après coup par le Creative Gate.
  it('le prompt embarque les exigences de construction dérivées du QualityTarget', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 3 }));
    const service = new CreativeConceptService(gateway, promptEngine);

    await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: TARGET },
    );

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Exigences de construction');
    expect(params.prompt).toContain('hookStrength');
    expect(params.prompt).toContain('qualityAlignment');
  });

  it('aucun critère critique pertinent au stade concept : aucun bloc d\'exigences vide dans le prompt', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ scenesCount: 3 }));
    const service = new CreativeConceptService(gateway, promptEngine);
    const emptyTarget: QualityTarget = { ...TARGET, criticalCriteria: [] };

    await service.generate(
      { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' },
      { creativeIntelligence: CREATIVE_INTELLIGENCE, qualityTarget: emptyTarget },
    );

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).not.toContain('Exigences de construction');
  });
});
