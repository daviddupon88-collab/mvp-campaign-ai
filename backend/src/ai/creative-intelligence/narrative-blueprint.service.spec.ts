import { NarrativeBlueprintService } from './narrative-blueprint.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { CreativeConcept } from './creative-concept.types';
import { QualityTarget } from '../quality/quality-target';

function buildGatewayMock(content: string) {
  return {
    generateText: jest.fn(async () => ({ content, provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })),
  } as unknown as AiGatewayService;
}

const promptEngine = new PromptEngineService();
const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };

const CONCEPT: CreativeConcept = {
  title: 'Vu de loin, protégé de près', concept: 'c', coreMessage: 'La visibilité sauve des vies', hook: 'Un chantier plongé dans le noir',
  emotionalDirection: 'e', visualDirection: 'v', storytellingApproach: 'Problème puis démonstration', proofStrategy: 'p',
  cta: 'cta', targetAudience: 'a', duration: 15, format: '9:16', scenesCount: 3, qualityAlignment: '', raw: '{}',
};

const TARGET: QualityTarget = {
  targetScore: 75,
  version: 'test-v1',
  criticalCriteria: ['hookStrength', 'ctaClarity', 'storytelling'],
  minimumCriticalScore: 60,
  prohibitedConditions: [],
};

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    hook: 'Un chantier plongé dans le noir', problem: 'Invisible la nuit', tension: 'Le danger approche',
    reveal: 'Le gilet réfléchissant', productIntroduction: 'Voici le gilet', benefit: 'Visible à 360°',
    proof: 'Bandes réfléchissantes qui captent la lumière', emotionalPayoff: 'Sécurité retrouvée', cta: 'Commandez la vôtre',
    pacing: 'rapide au début, ralenti sur la preuve',
    pausePoints: ['après le hook'],
    beats: [{ id: 'beat-1', role: 'hook', objective: 'accrocher', duration: 3, requiredVisualEvidence: 'chantier sombre', requiredVoiceover: 'Un chantier plongé dans le noir' }],
    ...overrides,
  };
}

describe('NarrativeBlueprintService.generate', () => {
  it('transforme le Creative Concept en structure narrative complète', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse()));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    const result = await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    expect(result.hook).toBe('Un chantier plongé dans le noir');
    expect(result.cta).toBe('Commandez la vôtre');
    expect(result.pacing).toBe('rapide au début, ralenti sur la preuve');
    expect(result.pausePoints).toEqual(['après le hook']);
    expect(result.beats).toHaveLength(1);
    expect(result.beats[0]).toMatchObject({ id: 'beat-1', role: 'hook', duration: 3 });
  });

  it('beats[].shotIds est toujours vide à la génération — peuplé en Phase 4 uniquement', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse()));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    const result = await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    expect(result.beats[0].shotIds).toEqual([]);
  });

  it('beat sans id fourni : id de repli déterministe (beat-N par index), jamais undefined', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse({ beats: [{ role: 'hook' }] })));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    const result = await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    expect(result.beats[0].id).toBe('beat-1');
  });

  it('réponse non conforme au format JSON attendu : repli neutre (tous champs vides, beats: []), ne lève jamais', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas répondre.');
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    const result = await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    expect(result.hook).toBe('');
    expect(result.cta).toBe('');
    expect(result.beats).toEqual([]);
    expect(result.raw).toContain('Désolé');
  });

  // Audit forensic (2026-08-22, campagne réelle fa26aacb...) : un seul JSON invalide (pas
  // forcément une troncature — une virgule/guillemet mal placé en milieu de document) suffisait à
  // produire un blueprint vide définitif, gaspillant tout le travail amont (Creative Gate,
  // Storyboard Gate, Shot Plan). Même discipline retry-avant-repli que
  // VideoDirectorService.generateShotPlanWithRetry.
  it('1er essai JSON invalide, 2e essai exploitable : retourne le blueprint de la 2e tentative, jamais le repli neutre', async () => {
    const gateway = {
      generateText: jest.fn()
        .mockResolvedValueOnce({ content: 'Désolé, je ne peux pas répondre.', provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })
        .mockResolvedValueOnce({ content: JSON.stringify(validResponse()), provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 }),
    } as unknown as AiGatewayService;
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    const result = await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    expect(gateway.generateText as jest.Mock).toHaveBeenCalledTimes(2);
    expect(result.hook).toBe('Un chantier plongé dans le noir');
    expect(result.beats).toHaveLength(1);
  });

  it('le prompt embarque le hook/storytellingApproach du concept, jamais une structure générique', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse()));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Un chantier plongé dans le noir');
    expect(params.prompt).toContain('Problème puis démonstration');
  });

  // Audit forensic (2026-08-22, campagne réelle) : 6 beats générés pour un Shot Plan de 3 plans —
  // chaque plan devait porter 2 preuves simultanées, rejeté par le Storyboard Gate pour surcharge
  // narrative. Le prompt doit désormais plafonner explicitement beats.length à scenesCount.
  it('le prompt plafonne explicitement le nombre de beats à scenesCount', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse()));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Nombre de plans prévus pour ce concept (scenesCount) : 3');
    expect(params.prompt).toContain('Le nombre de beats ne doit JAMAIS dépasser scenesCount');
  });

  // Audit forensic (2026-08-22, campagnes réelles) : requiredVisualEvidence héritait à tort de la
  // consigne "prêt à être dit à voix haute" — corrigé par une règle SHOW > TELL dédiée.
  it('le prompt distingue explicitement requiredVisualEvidence (jamais une phrase à prononcer) des champs narratifs top-level', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse()));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('requiredVisualEvidence n\'est JAMAIS une phrase à prononcer');
    expect(params.prompt).toContain('ne peut pas être filmé tel quel est invalide');
  });

  it('le prompt embarque les exigences de construction dérivées du QualityTarget (stade concept)', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse()));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Exigences de construction');
    expect(params.prompt).toContain('hookStrength');
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse()));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('narrative-blueprint-v3');
  });

  // Bug réel constaté en conditions réelles (2026-08-21) : sans maxTokens explicite, ce call
  // retombait sur le défaut 4000 de AnthropicProvider — insuffisant pour ce schéma (9 champs texte
  // + pausePoints + 2-6 beats à 6 sous-champs chacun), la réponse était tronquée avant la fin du
  // JSON, repliée à tort sur le neutre (beats: []) — faisait ensuite échouer PreFlightQualityGate.
  it('demande un budget de tokens généreux (8000), pas le défaut 4000 — évite la troncature JSON', async () => {
    const gateway = buildGatewayMock(JSON.stringify(validResponse()));
    const service = new NarrativeBlueprintService(gateway, promptEngine);

    await service.generate(CTX, { creativeConcept: CONCEPT, qualityTarget: TARGET });

    const [, requestParams] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(requestParams.maxTokens).toBe(8000);
  });
});
