import { StoryboardGateService, applySafePruning, EvaluateStoryboardGateParams } from './storyboard-gate.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';
import { Shot, ShotPlan } from './video-director.service';
import { QualityTarget } from '../quality/quality-target';

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
    scenesToRemove: [],
    faiblesses: [],
    recommandation: '',
    criterionScores: { productConsistency: 85, storytelling: 85, ctaClarity: 85 },
    risks: [],
    requiredChanges: [],
    rootCauseLevel: null,
    ...overrides,
  };
}

const CONCEPT: CreativeConcept = {
  title: 't', concept: 'c', coreMessage: 'm', hook: 'h', emotionalDirection: 'e', visualDirection: 'v',
  storytellingApproach: 's', proofStrategy: 'p', cta: 'cta', targetAudience: 'a', duration: 15, format: '9:16', scenesCount: 3, qualityAlignment: '', raw: '{}',
};
const HOOK_SHOT: Shot = { sceneId: 'shot-1', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', narrativeRole: 'hook' };
const DEMO_SHOT: Shot = { sceneId: 'shot-2', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', narrativeRole: 'demonstration' };
const CTA_SHOT: Shot = { sceneId: 'shot-3', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', narrativeRole: 'payoff', onScreenText: 'Commandez maintenant' };
const SHOT_PLAN: ShotPlan = [HOOK_SHOT, DEMO_SHOT, CTA_SHOT];

const BLUEPRINT: NarrativeBlueprint = {
  hook: 'h', problem: 'p', tension: 't', reveal: 'r', productIntroduction: 'i', benefit: 'b', proof: 'pr',
  emotionalPayoff: 'e', cta: 'c', pacing: 'x', pausePoints: [],
  beats: [{ id: 'beat-1', role: 'hook', objective: 'accrocher', duration: 3, requiredVisualEvidence: 'x', requiredVoiceover: 'x', shotIds: [] }],
  raw: '{}',
};

// Mission 4.3 (Goal-First Quality Architecture, Phase 1) — QualityTarget de test, criticalCriteria
// vide par défaut pour ne pas changer le contenu du prompt attendu par les tests pré-existants
// (le mapping de plancher critique a ses propres tests dédiés plus bas, avec criticalCriteria non vide).
const TARGET: QualityTarget = { targetScore: 75, version: 'test-v1', criticalCriteria: [], minimumCriticalScore: 60, prohibitedConditions: [] };

// Mission 4.3 (Goal-First Quality Architecture, Phase 5b) — helper "single edit point" : ce
// fichier appelait evaluate() avec le même objet littéral répété à 4 endroits avant ce chantier
// (rule-of-three appliquée, même pattern que les autres services de ce chantier).
function buildParams(overrides: Partial<EvaluateStoryboardGateParams> = {}): EvaluateStoryboardGateParams {
  return {
    creativeConcept: CONCEPT,
    shotPlan: SHOT_PLAN,
    qualityTarget: TARGET,
    narrativeBlueprint: BLUEPRINT,
    executionInstructions: SHOT_PLAN.map((s) => ({ sceneId: s.sceneId, prompt: `prompt for ${s.sceneId}` })),
    productProfile: null,
    ...overrides,
  };
}

describe('StoryboardGateService.evaluate', () => {
  it('score >=75, verdict APPROVED : status APPROVED', async () => {
    const gateway = buildGatewayMock();
    const service = new StoryboardGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(result.status).toBe('APPROVED');
    expect(result.score).toBe(85);
    expect(result.readyForGeneration).toBe(true);
    expect(result.rootCauseLevel).toBeNull();
  });

  it('score <75 : status REJECT même si le champ verdict dit APPROVED (le seuil prime)', async () => {
    const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 60, verdict: 'APPROVED' })));
    const service = new StoryboardGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(result.status).toBe('REJECT');
    expect(result.readyForGeneration).toBe(false);
    expect(result.blockingDefects.some((d) => d.includes('60/100'))).toBe(true);
  });

  it('réponse JSON malformée : repli neutre REJECT, ne lève jamais, rootCauseLevel TECHNICAL', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas évaluer ce storyboard.');
    const service = new StoryboardGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(result.status).toBe('REJECT');
    expect(result.score).toBe(50);
    expect(result.rootCauseLevel).toBe('TECHNICAL');
    expect(result.readyForGeneration).toBe(false);
  });

  it('transmet promptVersion pour la traçabilité', async () => {
    const gateway = buildGatewayMock();
    const service = new StoryboardGateService(gateway, promptEngine);

    await service.evaluate(CTX, buildParams());

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('storyboard-gate-v3');
  });

  // Mission 4.3 (Goal-First Quality Architecture, Phase 5b) — bug réel constaté en conditions
  // réelles (2026-08-21) : sans maxTokens explicite, ce call retombait sur le défaut 4000 de
  // AnthropicProvider — insuffisant pour le schéma de sortie v3 (criterionScores/risks/
  // requiredChanges/rootCauseLevel en plus du v2) et le prompt élargi (NarrativeBlueprint +
  // instructions d'exécution compilées par plan) : la réponse était tronquée avant la fin du JSON
  // ("Unexpected end of JSON input"), rejetée à tort comme REJECT/score neutre — un incident
  // technique confondu avec un vrai défaut de contenu.
  it('demande un budget de tokens généreux (16000), pas le défaut 4000 — évite la troncature JSON sur le schéma v3 élargi', async () => {
    const gateway = buildGatewayMock();
    const service = new StoryboardGateService(gateway, promptEngine);

    await service.evaluate(CTX, buildParams());

    const [, requestParams] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(requestParams.maxTokens).toBe(16000);
  });

  // Audit forensic (2026-08-22, campagne réelle da896157...) : 8000 s'est révélé encore
  // insuffisant en conditions réelles pour ce gate qui doit RAISONNER (évaluer + motiver), pas
  // seulement générer mécaniquement. Même discipline retry-avant-repli que
  // VideoDirectorService.generateShotPlanWithRetry/NarrativeBlueprintService.
  it('1er essai JSON invalide, 2e essai exploitable : retourne le résultat de la 2e tentative, jamais le repli neutre', async () => {
    const gateway = {
      generateText: jest.fn()
        .mockResolvedValueOnce({ content: 'Désolé, je ne peux pas évaluer.', provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 })
        .mockResolvedValueOnce({ content: JSON.stringify(defaultResponse()), provider: 'anthropic', model: 'claude-sonnet-5', durationMs: 10 }),
    } as unknown as AiGatewayService;
    const service = new StoryboardGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(gateway.generateText as jest.Mock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('APPROVED');
    expect(result.score).toBe(85);
  });

  // Mission 4.3 (Goal-First Quality Architecture, Phase 1) — preuve que le seuil n'est plus une
  // constante figée (STORYBOARD_GATE_THRESHOLD) mais une donnée du QualityTarget transmis.
  it('le score cible est piloté par QualityTarget.targetScore, jamais une constante figée', async () => {
    const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 78, verdict: 'APPROVED' })));
    const service = new StoryboardGateService(gateway, promptEngine);

    const stricter = await service.evaluate(CTX, buildParams({ qualityTarget: { ...TARGET, targetScore: 80 } }));
    expect(stricter.status).toBe('REJECT');

    const looser = await service.evaluate(CTX, buildParams({ qualityTarget: { ...TARGET, targetScore: 75 } }));
    expect(looser.status).toBe('APPROVED');
  });

  it('criterionScores est parsé correctement depuis la réponse LLM', async () => {
    const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ criterionScores: { productConsistency: 72, storytelling: 91, ctaClarity: 88 } })));
    const service = new StoryboardGateService(gateway, promptEngine);

    const result = await service.evaluate(CTX, buildParams());

    expect(result.criterionScores).toEqual({ productConsistency: 72, storytelling: 91, ctaClarity: 88 });
  });

  // Mission 4.3 (Goal-First Quality Architecture, Phase 5b) — le plancher critique est appliqué
  // en CODE : un score global >= cible ne doit jamais masquer un critère critique sous son
  // plancher (brief : "global=81 mais productFidelity=55 => toujours bloqué").
  describe('plancher critique (applyCriticalFloor)', () => {
    const TARGET_WITH_FLOOR: QualityTarget = { ...TARGET, criticalCriteria: ['productConsistency', 'storytelling', 'ctaClarity'], minimumCriticalScore: 60 };

    it('score global élevé + un critère critique sous le plancher : readyForGeneration=false même si le LLM dit APPROVED', async () => {
      const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 81, verdict: 'APPROVED', criterionScores: { productConsistency: 55, storytelling: 90, ctaClarity: 90 } })));
      const service = new StoryboardGateService(gateway, promptEngine);

      const result = await service.evaluate(CTX, buildParams({ qualityTarget: TARGET_WITH_FLOOR }));

      expect(result.status).toBe('REJECT');
      expect(result.readyForGeneration).toBe(false);
      expect(result.blockingDefects.some((d) => d.includes('productConsistency'))).toBe(true);
    });

    it('rootCauseLevel est déterminé par le mapping fixe du critère violé, jamais par le champ du LLM', async () => {
      const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 81, verdict: 'APPROVED', rootCauseLevel: 'BRAND', criterionScores: { productConsistency: 55, storytelling: 90, ctaClarity: 90 } })));
      const service = new StoryboardGateService(gateway, promptEngine);

      const result = await service.evaluate(CTX, buildParams({ qualityTarget: TARGET_WITH_FLOOR }));

      expect(result.rootCauseLevel).toBe('PRODUCT'); // productConsistency -> PRODUCT, pas 'BRAND' rapporté par le LLM
    });

    it('storytelling sous le plancher -> rootCauseLevel NARRATIVE', async () => {
      const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 81, criterionScores: { productConsistency: 90, storytelling: 40, ctaClarity: 90 } })));
      const service = new StoryboardGateService(gateway, promptEngine);

      const result = await service.evaluate(CTX, buildParams({ qualityTarget: TARGET_WITH_FLOOR }));

      expect(result.rootCauseLevel).toBe('NARRATIVE');
    });

    it('ctaClarity sous le plancher -> rootCauseLevel CONCEPT', async () => {
      const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 81, criterionScores: { productConsistency: 90, storytelling: 90, ctaClarity: 30 } })));
      const service = new StoryboardGateService(gateway, promptEngine);

      const result = await service.evaluate(CTX, buildParams({ qualityTarget: TARGET_WITH_FLOOR }));

      expect(result.rootCauseLevel).toBe('CONCEPT');
    });

    it('aucun critère critique sous le plancher : le résultat LLM (APPROVED) est respecté', async () => {
      const gateway = buildGatewayMock(JSON.stringify(defaultResponse({ score: 90, verdict: 'APPROVED', criterionScores: { productConsistency: 90, storytelling: 90, ctaClarity: 90 } })));
      const service = new StoryboardGateService(gateway, promptEngine);

      const result = await service.evaluate(CTX, buildParams({ qualityTarget: TARGET_WITH_FLOOR }));

      expect(result.status).toBe('APPROVED');
      expect(result.readyForGeneration).toBe(true);
    });
  });

  describe('nouvelles entrées atteignent le prompt', () => {
    it('narrativeBlueprint.beats, executionInstructions et productProfile apparaissent dans le prompt envoyé', async () => {
      const gateway = buildGatewayMock();
      const service = new StoryboardGateService(gateway, promptEngine);
      const productProfile = { category: 'gilet', subcategory: null, brand: 'Acme', productName: 'Gilet Pro', model: null, features: [], usps: [], visibleClaims: [], webResearchStatus: 'NOT_CONFIGURED' } as any;

      await service.evaluate(CTX, buildParams({ productProfile, executionInstructions: [{ sceneId: 'shot-1', prompt: 'INSTRUCTION_UNIQUE_MARKER' }] }));

      const [, { prompt }] = (gateway.generateText as jest.Mock).mock.calls[0];
      expect(prompt).toContain('beat-1');
      expect(prompt).toContain('INSTRUCTION_UNIQUE_MARKER');
      expect(prompt).toContain('Acme');
    });

    it('productProfile null : aucun bloc de grounding ajouté', async () => {
      const gateway = buildGatewayMock();
      const service = new StoryboardGateService(gateway, promptEngine);

      await service.evaluate(CTX, buildParams({ productProfile: null }));

      const [, { prompt }] = (gateway.generateText as jest.Mock).mock.calls[0];
      expect(prompt).not.toContain('Intelligence produit');
    });
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
