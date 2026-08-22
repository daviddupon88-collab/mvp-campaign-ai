import { VideoQualityLoopService, QualityLoopParams } from './video-quality-loop.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { VideoDirectorService, Shot } from '../video-direction/video-director.service';
import { VideoFinalizationService } from '../../video-assembly/video-finalization.service';
import { VideoJudgeService } from './video-judge.service';
import { VideoJudgeResult } from './video-judge.types';
import { ShotQualityResult } from '../video-direction/video-analyzer.service';
import { VisualDna } from '../video-direction/visual-dna.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };
const promptEngine = new PromptEngineService();

const VISUAL_DNA: VisualDna = { productCategory: 'x', colors: [], materials: [], shape: 'x', distinctiveFeatures: [], logoOrBrandMarks: null, raw: '{}' };
const CONCEPT: CreativeConcept = {
  title: 't', concept: 'c', coreMessage: 'm', hook: 'h', emotionalDirection: 'e', visualDirection: 'v',
  storytellingApproach: 's', proofStrategy: 'p', cta: 'cta', targetAudience: 'a', duration: 15, format: '9:16', scenesCount: 2, qualityAlignment: '', raw: '{}',
};
const SHOT_1: Shot = { sceneId: 'shot-1', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };
const SHOT_2: Shot = { sceneId: 'shot-2', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };
const NARRATIVE_BLUEPRINT: NarrativeBlueprint = {
  hook: '', problem: '', tension: '', reveal: '', productIntroduction: '',
  benefit: '', proof: '', emotionalPayoff: '', cta: '', pacing: '', pausePoints: [], beats: [], raw: '{}',
};

function buildQuality(score: number): ShotQualityResult {
  return {
    passed: score >= 70,
    qualityScore: score,
    motionQuality: { passed: score >= 70, score, reasons: [], freezeRatio: 0 },
    visualFidelity: { passed: score >= 70, score, reasons: score < 70 ? ['produit différent'] : [] },
    reasons: [],
  };
}

function PASS(): VideoJudgeResult {
  return {
    criteria: [{ name: 'productConsistency', score: 90, justification: 'ok' }],
    globalScore: 90,
    visualQuality: { score: 90, criteria: ['productConsistency'] },
    advertisingEffectiveness: { score: 90, criteria: [] },
    verdict: 'PASS',
  };
}

function repairRequired(overrides: Partial<VideoJudgeResult['criteria'][0]>[]): VideoJudgeResult {
  return {
    criteria: overrides.map((o) => ({ name: 'productConsistency', score: 40, justification: 'x', defect: 'défaut', ...o }) as any),
    globalScore: 40,
    visualQuality: { score: 40, criteria: ['productConsistency'] },
    advertisingEffectiveness: { score: 40, criteria: [] },
    verdict: 'REPAIR_REQUIRED',
  };
}

function buildFinalized() {
  return { status: 'assembled' as const, buffer: Buffer.from('final-video'), mimeType: 'video/mp4' as const, durationSeconds: 10 };
}

function buildDeps(overrides: { judgeResults?: VideoJudgeResult[]; finalizeResults?: any[] } = {}) {
  const finalizeQueue = overrides.finalizeResults ?? [buildFinalized()];
  const judgeQueue = overrides.judgeResults ?? [PASS()];

  const aiGateway = {
    generateText: jest.fn(async () => ({ content: JSON.stringify({ correctedText: 'Texte corrigé.' }), provider: 'anthropic', model: 'claude', durationMs: 5 })),
    generateAudio: jest.fn(async () => ({ content: 'data:audio/mp3;base64,bmV3LWF1ZGlv', provider: 'openai', model: 'tts-1', durationMs: 5 })),
    transcribeAudio: jest.fn(async () => ({ content: JSON.stringify([{ start: 0, end: 1, text: 'Nouveau texte.' }]), provider: 'openai', model: 'whisper-1', durationMs: 5 })),
    generateVideo: jest.fn(async () => ({ content: 'data:video/mp4;base64,bmV3LWNsaXA=', provider: 'google-veo', model: 'veo-1', durationMs: 5 })),
  } as unknown as AiGatewayService;

  const videoDirector = {
    repairShotPrompt: jest.fn(() => 'prompt de réparation'),
  } as unknown as VideoDirectorService;

  let finalizeCallIndex = 0;
  const videoFinalization = {
    finalize: jest.fn(async () => finalizeQueue[Math.min(finalizeQueue.length - 1, finalizeCallIndex++)]),
    concatenateClips: jest.fn(async (contents: string[]) => `data:video/mp4;base64,${Buffer.from(contents.join(',')).toString('base64')}`),
  } as unknown as VideoFinalizationService;

  let judgeCallIndex = 0;
  const videoJudge = {
    judge: jest.fn(async () => judgeQueue[Math.min(judgeQueue.length - 1, judgeCallIndex++)]),
  } as unknown as VideoJudgeService;

  return { aiGateway, videoDirector, videoFinalization, videoJudge };
}

function buildParams(overrides: Partial<QualityLoopParams> = {}): QualityLoopParams {
  return {
    rawVideoUrl: 'data:video/mp4;base64,cmF3',
    videoClips: [{ sceneId: 'shot-1', content: 'data:video/mp4;base64,Y2xpcDE=' }, { sceneId: 'shot-2', content: 'data:video/mp4;base64,Y2xpcDI=' }],
    narrationDataUri: 'data:audio/mp3;base64,bmFycmF0aW9u',
    narrationText: 'Texte de narration original.',
    transcript: [{ start: 0, end: 2, text: 'Texte de narration original.' }],
    shotPlan: [SHOT_1, SHOT_2],
    perShotQuality: new Map([['shot-1', buildQuality(90)], ['shot-2', buildQuality(40)]]),
    visualDna: VISUAL_DNA,
    referenceImageUrl: 'https://cdn.example.com/photo.png',
    concept: CONCEPT,
    narrativeBlueprint: NARRATIVE_BLUEPRINT,
    productProfile: null,
    ...overrides,
  };
}

describe('VideoQualityLoopService.run', () => {
  it("finalize() renvoie 'skipped' (mode mock/narration indisponible) : PASSED immédiat, aucun appel au Judge", async () => {
    const deps = buildDeps({ finalizeResults: [{ status: 'skipped', reason: 'narration non disponible' }] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('PASSED');
    expect(deps.videoJudge.judge).not.toHaveBeenCalled();
  });

  it('PASS dès le 1er jugement : PASSED, une seule tentative tracée', async () => {
    const deps = buildDeps({ judgeResults: [PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('PASSED');
    if (outcome.status === 'PASSED') {
      expect(outcome.attempts).toHaveLength(1);
      expect(outcome.attempts[0].repairsApplied).toEqual([]);
    }
  });

  it('défaut SUBTITLE_ONLY (grammar) : corrige le transcript via generateText, ré-assemble, PASS au 2e jugement', async () => {
    const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'grammar' as any, score: 30, defect: 'faute' }]), PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('PASSED');
    expect(deps.aiGateway.generateText).toHaveBeenCalledTimes(1);
    expect(deps.aiGateway.generateVideo).not.toHaveBeenCalled(); // jamais de clip régénéré pour un défaut texte
    expect((deps.videoFinalization.finalize as jest.Mock).mock.calls.length).toBe(2);
  });

  it('défaut AUDIO_REGEN (audioQuality) : régénère narration + retranscrit, ré-assemble, PASS au 2e jugement', async () => {
    const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'audioQuality' as any, score: 20, defect: 'niveau trop bas' }]), PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('PASSED');
    expect(deps.aiGateway.generateAudio).toHaveBeenCalledTimes(1);
    expect(deps.aiGateway.transcribeAudio).toHaveBeenCalledTimes(1);
    expect(deps.aiGateway.generateVideo).not.toHaveBeenCalled();
  });

  // Mission 4.5 (Contrôle A1, campagne réelle 2026-08-22) — bug réel confirmé : AUDIO_REGEN
  // régénérait auparavant l'audio depuis params.narrationText (une chaîne FIGÉE, calculée une
  // seule fois avant la boucle) — si ce texte était déjà défectueux (cta tronqué), chaque
  // réparation ne faisait que ré-enregistrer une nouvelle prise du MÊME script cassé.
  describe('AUDIO_REGEN reconstruit la narration depuis le NarrativeBlueprint (correction Mission 4.5)', () => {
    it('ctaClarity : le prompt envoyé à generateAudio provient du NarrativeBlueprint reconstruit, jamais de params.narrationText tel quel', async () => {
      const blueprint: NarrativeBlueprint = {
        hook: 'Un rayon rempli de bouteilles identiques.',
        problem: '', tension: '', reveal: '', productIntroduction: '', benefit: '', proof: '', emotionalPayoff: '',
        cta: 'Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.',
        pacing: '', pausePoints: [], beats: [], raw: '{}',
      };
      const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'ctaClarity' as any, score: 40, defect: 'CTA vocal absent' }]), PASS()] });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      await service.run(CTX, buildParams({ narrativeBlueprint: blueprint, narrationText: 'un mai' /* texte figé volontairement cassé, ne doit JAMAIS être réutilisé */ }));

      const [, callParams] = (deps.aiGateway.generateAudio as jest.Mock).mock.calls[0];
      expect(callParams.prompt).toContain('Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.');
      expect(callParams.prompt).not.toBe('un mai');
    });

    // Mission 4.5 (Phases A2-A5) — interrupteur expérimental temporaire.
    it('flag MISSION_4_5_LEGACY_NARRATION=true : rejoue le comportement historique (réutilise params.narrationText tel quel)', async () => {
      const ORIGINAL_ENV = process.env.MISSION_4_5_LEGACY_NARRATION;
      process.env.MISSION_4_5_LEGACY_NARRATION = 'true';
      try {
        const blueprint: NarrativeBlueprint = {
          hook: 'Un rayon rempli de bouteilles identiques.',
          problem: '', tension: '', reveal: '', productIntroduction: '', benefit: '', proof: '', emotionalPayoff: '',
          cta: 'Achetez maintenant — Lalla Khedidja, 1,5L, en ligne.',
          pacing: '', pausePoints: [], beats: [], raw: '{}',
        };
        const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'ctaClarity' as any, score: 40, defect: 'CTA vocal absent' }]), PASS()] });
        const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

        await service.run(CTX, buildParams({ narrativeBlueprint: blueprint, narrationText: 'texte figé historique' }));

        const [, callParams] = (deps.aiGateway.generateAudio as jest.Mock).mock.calls[0];
        expect(callParams.prompt).toBe('texte figé historique');
      } finally {
        if (ORIGINAL_ENV === undefined) delete process.env.MISSION_4_5_LEGACY_NARRATION;
        else process.env.MISSION_4_5_LEGACY_NARRATION = ORIGINAL_ENV;
      }
    });

    it('narrativeBlueprint inchangé entre 2 tentatives : reconstruction déterministe, jamais un texte différent à chaque essai sans raison', async () => {
      const blueprint: NarrativeBlueprint = {
        hook: 'Hook stable.', problem: '', tension: '', reveal: '', productIntroduction: '', benefit: '', proof: '', emotionalPayoff: '',
        cta: 'CTA stable.', pacing: '', pausePoints: [], beats: [], raw: '{}',
      };
      const deps = buildDeps({
        judgeResults: [
          repairRequired([{ name: 'ctaClarity' as any, score: 40, defect: 'CTA vocal absent' }]),
          repairRequired([{ name: 'ctaClarity' as any, score: 45, defect: 'CTA vocal encore absent' }]),
          PASS(),
        ],
      });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      await service.run(CTX, buildParams({ narrativeBlueprint: blueprint }));

      const calls = (deps.aiGateway.generateAudio as jest.Mock).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][1].prompt).toBe(calls[1][1].prompt); // même blueprint -> même narration reconstruite
    });
  });

  it('défaut CLIP_REGEN avec sceneRef explicite : régénère UNIQUEMENT ce plan, reconcatène, PASS au 2e jugement', async () => {
    const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'motionDynamism' as any, score: 30, defect: 'trop statique', sceneRef: 'shot-2' }]), PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('PASSED');
    expect(deps.aiGateway.generateVideo).toHaveBeenCalledTimes(1);
    expect(deps.videoDirector.repairShotPrompt).toHaveBeenCalledWith(SHOT_2, expect.anything(), expect.anything(), undefined, undefined);
    expect(deps.videoFinalization.concatenateClips).toHaveBeenCalledTimes(1); // 2 clips -> reconcaténation nécessaire
  });

  it('Phase O — 4 scènes dont une seule défaillante (scores 88/54/84/91) : seule la scène à 54 est régénérée, les 3 autres jamais touchées', async () => {
    const shot3: Shot = { sceneId: 'shot-3', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };
    const shot4: Shot = { sceneId: 'shot-4', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };
    const params = buildParams({
      shotPlan: [SHOT_1, SHOT_2, shot3, shot4],
      perShotQuality: new Map([
        ['shot-1', buildQuality(88)],
        ['shot-2', buildQuality(54)],
        ['shot-3', buildQuality(84)],
        ['shot-4', buildQuality(91)],
      ]),
      videoClips: [
        { sceneId: 'shot-1', content: 'data:video/mp4;base64,Y2xpcDE=' },
        { sceneId: 'shot-2', content: 'data:video/mp4;base64,Y2xpcDI=' },
        { sceneId: 'shot-3', content: 'data:video/mp4;base64,Y2xpcDM=' },
        { sceneId: 'shot-4', content: 'data:video/mp4;base64,Y2xpcDQ=' },
      ],
    });
    const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'motionDynamism' as any, score: 40, defect: 'trop statique', sceneRef: 'shot-2' }]), PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, params);

    expect(outcome.status).toBe('PASSED');
    expect(deps.aiGateway.generateVideo).toHaveBeenCalledTimes(1);
    expect(deps.videoDirector.repairShotPrompt).toHaveBeenCalledWith(SHOT_2, expect.anything(), expect.anything(), undefined, undefined);
    // Le lot reconcaténé conserve les 3 clips inchangés + le seul clip régénéré (shot-2)
    const recomposedContents = (deps.videoFinalization.concatenateClips as jest.Mock).mock.calls[0][0];
    expect(recomposedContents).toEqual([
      'data:video/mp4;base64,Y2xpcDE=',
      'data:video/mp4;base64,bmV3LWNsaXA=',
      'data:video/mp4;base64,Y2xpcDM=',
      'data:video/mp4;base64,Y2xpcDQ=',
    ]);
  });

  it("Phase B — le même défaut persiste avec un progrès FAIBLE (delta<5) après une 1re réparation : la 2e tentative escalade le correctif, ne répète jamais le même prompt", async () => {
    const judge1 = repairRequired([{ name: 'motionDynamism' as any, score: 30, defect: 'trop statique', sceneRef: 'shot-2' }]);
    const judge2: VideoJudgeResult = { ...repairRequired([{ name: 'motionDynamism' as any, score: 33, defect: 'toujours un peu statique', sceneRef: 'shot-2' }]), globalScore: 43 };
    const deps = buildDeps({ judgeResults: [judge1, judge2, PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    await service.run(CTX, buildParams());

    expect(deps.aiGateway.generateVideo).toHaveBeenCalledTimes(2); // repair 1 + repair 2 (escaladé, pas bloqué : FAIBLE n'est jamais un skip)
    const secondCall = (deps.videoDirector.repairShotPrompt as jest.Mock).mock.calls[1];
    expect(secondCall[4]).toEqual({ priorFailureReason: 'toujours un peu statique' });
  });

  it("Phase B — le même défaut RÉGRESSE (delta<0, ECHEC) après une 1re réparation : la 2e tentative ne répète JAMAIS la même stratégie, épuisement immédiat", async () => {
    const judge1 = repairRequired([{ name: 'motionDynamism' as any, score: 30, defect: 'trop statique', sceneRef: 'shot-2' }]);
    const judge2: VideoJudgeResult = { ...repairRequired([{ name: 'motionDynamism' as any, score: 20, defect: 'encore pire', sceneRef: 'shot-2' }]), globalScore: 45 };
    const deps = buildDeps({ judgeResults: [judge1, judge2] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('REPAIR_EXHAUSTED');
    expect(deps.videoJudge.judge).toHaveBeenCalledTimes(2); // pas de 3e jugement : le seul défaut restant est bloqué, 0 réparation appliquée
    expect(deps.aiGateway.generateVideo).toHaveBeenCalledTimes(1); // seulement la 1re réparation (celle qui a produit le ECHEC), jamais répétée
  });

  it('Phase C — plusieurs défauts CLIP_REGEN simultanés : le défaut CRITIQUE (poids élevé) est réparé AVANT le défaut IMPORTANT (poids plus faible), pas dans l\'ordre renvoyé par le Judge', async () => {
    const judge1: VideoJudgeResult = {
      criteria: [
        { name: 'motionDynamism', score: 55, justification: 'un peu statique', defect: 'un peu statique', sceneRef: 'shot-1' }, // IMPORTANT, poids 6
        { name: 'productConsistency', score: 30, justification: 'produit méconnaissable', defect: 'produit méconnaissable', sceneRef: 'shot-2' }, // CRITIQUE, poids 12
      ],
      globalScore: 40,
      visualQuality: { score: 40, criteria: [] },
      advertisingEffectiveness: { score: 40, criteria: [] },
      verdict: 'REPAIR_REQUIRED',
    };
    const deps = buildDeps({ judgeResults: [judge1, PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    await service.run(CTX, buildParams());

    const calls = (deps.videoDirector.repairShotPrompt as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(SHOT_2); // productConsistency (CRITIQUE, poids 12) réparé en premier
    expect(calls[1][0]).toBe(SHOT_1); // motionDynamism (IMPORTANT, poids 6) réparé ensuite
  });

  it('Phase C — défaut MINEUR (score >= seuil de passage) visé par CLIP_REGEN : jamais réparé (coût non justifié), le défaut CRITIQUE co-existant l\'est', async () => {
    const judge1: VideoJudgeResult = {
      criteria: [
        { name: 'motionDynamism', score: 65, justification: 'presque parfait', defect: 'légèrement perfectible', sceneRef: 'shot-1' }, // MINEUR (>=62) — jamais réparé par CLIP_REGEN
        { name: 'productConsistency', score: 30, justification: 'produit méconnaissable', defect: 'produit méconnaissable', sceneRef: 'shot-2' }, // CRITIQUE — réparé normalement
      ],
      globalScore: 55,
      visualQuality: { score: 55, criteria: [] },
      advertisingEffectiveness: { score: 55, criteria: [] },
      verdict: 'REPAIR_REQUIRED',
    };
    const deps = buildDeps({ judgeResults: [judge1, PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    await service.run(CTX, buildParams());

    expect(deps.aiGateway.generateVideo).toHaveBeenCalledTimes(1); // seulement productConsistency, jamais motionDynamism (MINEUR)
    expect(deps.videoDirector.repairShotPrompt).toHaveBeenCalledWith(SHOT_2, expect.anything(), expect.anything(), undefined, undefined);
    expect(deps.videoDirector.repairShotPrompt).not.toHaveBeenCalledWith(SHOT_1, expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("défaut CLIP_REGEN SANS sceneRef : cible le plan le PIRE noté (perShotQuality), pas un plan arbitraire", async () => {
    const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'productConsistency' as any, score: 30, defect: 'produit différent' }]), PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    await service.run(CTX, buildParams());

    // shot-2 a le pire qualityScore (40) dans buildParams() par défaut.
    expect(deps.videoDirector.repairShotPrompt).toHaveBeenCalledWith(SHOT_2, expect.anything(), expect.anything(), undefined, undefined);
  });

  describe('Mission 4 Phase H — gate de confiance dédié formatCompliance/sceneConsistency (jamais de repli sur la pire scène pour ces deux critères)', () => {
    it('TEST 15 (Round 4) — formatCompliance à confiance suffisante ET sceneRef unique : CLIP_REGEN ciblé sur CE plan uniquement', async () => {
      // formatCompliance est un critère CRITIQUE (CRITICAL_CRITERIA) : le 2e jugement doit
      // explicitement le renvoyer à un score sain, jamais réutiliser le PASS() partagé (qui ne
      // porte que productConsistency) — sinon formatCompliance, absent, serait traité comme 0 et
      // déclencherait une fausse régression (même bug fixture que Mission 3, cf. historique).
      const resolvedJudge: VideoJudgeResult = {
        criteria: [
          { name: 'productConsistency', score: 90, justification: 'ok' },
          { name: 'formatCompliance', score: 95, justification: 'cadre plein après réparation' },
        ],
        globalScore: 90,
        visualQuality: { score: 90, criteria: ['productConsistency', 'formatCompliance'] },
        advertisingEffectiveness: { score: 90, criteria: [] },
        verdict: 'PASS',
      };
      const deps = buildDeps({
        judgeResults: [repairRequired([{ name: 'formatCompliance' as any, score: 40, defect: 'BORDER_DETECTED', sceneRef: 'shot-2', confidence: 0.95 }]), resolvedJudge],
      });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      const outcome = await service.run(CTX, buildParams());

      expect(outcome.status).toBe('PASSED');
      expect(deps.aiGateway.generateVideo).toHaveBeenCalledTimes(1);
      expect(deps.videoDirector.repairShotPrompt).toHaveBeenCalledWith(SHOT_2, expect.anything(), expect.anything(), undefined, undefined);
    });

    it('TEST 16 (Round 4) — formatCompliance détecté sur toute la vidéo (sceneRef absent), même à confiance élevée : AUCUN CLIP_REGEN, jamais de repli sur la pire scène', async () => {
      const deps = buildDeps({
        judgeResults: [repairRequired([{ name: 'formatCompliance' as any, score: 40, defect: 'UNDERFILLED', sceneRef: undefined, confidence: 0.99 }])],
      });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      const outcome = await service.run(CTX, buildParams());

      expect(outcome.status).toBe('REPAIR_EXHAUSTED');
      expect(deps.aiGateway.generateVideo).not.toHaveBeenCalled(); // jamais de repli sur shot-2 (pire qualityScore) pour ce critère précis
    });

    it('TEST 11 (Correction 3) — sceneConsistency à confiance insuffisante, même avec un sceneRef : AUCUN CLIP_REGEN', async () => {
      const deps = buildDeps({
        judgeResults: [repairRequired([{ name: 'sceneConsistency' as any, score: 40, defect: 'éclairage incohérent', sceneRef: 'shot-2', confidence: 0.4 }])],
      });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      const outcome = await service.run(CTX, buildParams());

      expect(outcome.status).toBe('REPAIR_EXHAUSTED');
      expect(deps.aiGateway.generateVideo).not.toHaveBeenCalled();
    });

    it('TEST 12 (Correction 3, recoupe TEST 3) — sceneConsistency à confiance suffisante ET sceneRef unique : CLIP_REGEN ciblé sur CE plan uniquement', async () => {
      // sceneConsistency n'est PAS un critère critique (pas dans CRITICAL_CRITERIA) : PASS()
      // suffit ici, contrairement au TEST 15 ci-dessus (formatCompliance, lui, est critique).
      const deps = buildDeps({
        judgeResults: [repairRequired([{ name: 'sceneConsistency' as any, score: 40, defect: 'éclairage incohérent', sceneRef: 'shot-2', confidence: 0.91 }]), PASS()],
      });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      const outcome = await service.run(CTX, buildParams());

      expect(outcome.status).toBe('PASSED');
      expect(deps.aiGateway.generateVideo).toHaveBeenCalledTimes(1);
      expect(deps.videoDirector.repairShotPrompt).toHaveBeenCalledWith(SHOT_2, expect.anything(), expect.anything(), undefined, undefined);
    });

    it('formatCompliance sans confidence renseignée du tout : gate refusé, jamais un repli optimiste malgré un sceneRef présent', async () => {
      const deps = buildDeps({
        judgeResults: [repairRequired([{ name: 'formatCompliance' as any, score: 40, defect: 'BORDER_DETECTED', sceneRef: 'shot-2' }])],
      });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      const outcome = await service.run(CTX, buildParams());

      expect(outcome.status).toBe('REPAIR_EXHAUSTED');
      expect(deps.aiGateway.generateVideo).not.toHaveBeenCalled();
    });
  });

  it('uniquement des défauts UNREPAIRABLE : REPAIR_EXHAUSTED immédiat, aucun appel IA de réparation, pas de 2e jugement', async () => {
    const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'storytelling' as any, score: 20, defect: 'récit confus' }])] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('REPAIR_EXHAUSTED');
    expect(deps.videoJudge.judge).toHaveBeenCalledTimes(1);
    expect(deps.aiGateway.generateVideo).not.toHaveBeenCalled();
    expect(deps.aiGateway.generateAudio).not.toHaveBeenCalled();
  });

  it('REPAIR_REQUIRED persistant après MAX_REPAIR_ATTEMPTS (2) : REPAIR_EXHAUSTED, jamais un faux succès', async () => {
    const failing = repairRequired([{ name: 'grammar' as any, score: 30, defect: 'faute' }]);
    const deps = buildDeps({ judgeResults: [failing, failing, failing] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('REPAIR_EXHAUSTED');
    expect(deps.videoJudge.judge).toHaveBeenCalledTimes(VideoQualityLoopService.MAX_REPAIR_ATTEMPTS + 1);
  });

  it("Phase A — réparation qui améliore motionDynamism mais fait régresser productConsistency (critique) sous le plancher : la réparation est REJETÉE, l'état revient à la tentative précédente", async () => {
    const initialParams = buildParams();
    const judge1: VideoJudgeResult = {
      criteria: [
        { name: 'motionDynamism', score: 45, justification: 'trop statique', defect: 'trop statique', sceneRef: 'shot-2' },
        { name: 'productConsistency', score: 88, justification: 'fidèle' },
      ],
      globalScore: 60,
      visualQuality: { score: 60, criteria: [] },
      advertisingEffectiveness: { score: 60, criteria: [] },
      verdict: 'REPAIR_REQUIRED',
    };
    const judge2: VideoJudgeResult = {
      criteria: [
        { name: 'motionDynamism', score: 75, justification: 'mieux' },
        { name: 'productConsistency', score: 40, justification: 'produit méconnaissable', defect: 'produit méconnaissable' },
      ],
      globalScore: 65,
      visualQuality: { score: 65, criteria: [] },
      advertisingEffectiveness: { score: 65, criteria: [] },
      verdict: 'REPAIR_REQUIRED',
    };
    const deps = buildDeps({ judgeResults: [judge1, judge2, judge2] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, initialParams);

    expect(outcome.status).toBe('REPAIR_EXHAUSTED');
    if (outcome.status === 'REPAIR_EXHAUSTED') {
      // La meilleure version reste celle de la tentative 1 (judge1, score 60) — jamais celle,
      // pire sur un critère critique, produite par la réparation rejetée.
      expect(outcome.bestAttempt.attemptNumber).toBe(1);
      expect(outcome.bestAttempt.judge.globalScore).toBe(60);
      expect(outcome.attempts[1].reverted).toBe(true);
      expect(outcome.attempts[1].regressionReason).toContain('productConsistency');
    }
  });

  it('Phase A — réparation qui améliore réellement (aucune régression) : acceptée normalement, comportement PASS inchangé', async () => {
    const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'motionDynamism' as any, score: 30, defect: 'trop statique', sceneRef: 'shot-2' }]), PASS()] });
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    expect(outcome.status).toBe('PASSED');
    if (outcome.status === 'PASSED') {
      expect(outcome.attempts[0].reverted).toBeFalsy();
    }
  });

  it('échec de la régénération du clip (provider vidéo indisponible) : plan conservé tel quel, ne fait pas échouer toute la boucle', async () => {
    const deps = buildDeps({ judgeResults: [repairRequired([{ name: 'motionDynamism' as any, score: 30, defect: 'trop statique', sceneRef: 'shot-2' }]), repairRequired([{ name: 'motionDynamism' as any, score: 30, defect: 'toujours statique', sceneRef: 'shot-2' }])] });
    (deps.aiGateway.generateVideo as jest.Mock).mockRejectedValue(new Error('Google Veo indisponible'));
    const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

    const outcome = await service.run(CTX, buildParams());

    // Échec de régénération -> aucune réparation appliquée pour cette tentative -> sortie
    // immédiate en REPAIR_EXHAUSTED (rien n'a changé, continuer serait redondant).
    expect(outcome.status).toBe('REPAIR_EXHAUSTED');
    expect(deps.videoFinalization.concatenateClips).not.toHaveBeenCalled();
  });

  // Mission 3 (validation empirique, 2026-08-20) — REJEU d'un jugement réel (campagne
  // c29f0982-f5c4-40a0-bbac-e8dad2eba0eb, tentative 1, base de données historique) : 9 critères
  // texte simultanément UNAVAILABLE_DEFECT (échec de l'appel Judge groupé), scores visuels réels
  // élevés (92-100). Avant ce fix, ce jugement déclenchait 2 cycles complets de réparation
  // (SUBTITLE_ONLY + AUDIO_REGEN) sur 74-114 appels IA / 36-115 minutes réels sans jamais pouvoir
  // progresser — aucun de ces 9 défauts n'a jamais été un vrai problème de contenu.
  describe("Mission 3 — UNAVAILABLE_DEFECT jamais dispatché vers une réparation locale (rejeu de données réelles)", () => {
    const UNAVAILABLE_ONLY_JUDGE: VideoJudgeResult = {
      criteria: [
        { name: 'productConsistency', score: 92, justification: 'x' },
        { name: 'motionDynamism', score: 100, justification: 'x' },
        { name: 'productVisibility', score: 94, justification: 'x' },
        { name: 'formatCompliance', score: 100, justification: 'x' },
        { name: 'storytelling', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
        { name: 'hookStrength', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
        { name: 'pacing', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
        { name: 'textReadability', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
        { name: 'grammar', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
        { name: 'ctaClarity', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
        { name: 'brandCoherence', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
        { name: 'factualConsistency', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
        { name: 'advertisingEffectiveness', score: 50, justification: 'Critère non renvoyé par le modèle.', defect: 'Vérification indisponible' },
      ] as any,
      globalScore: 64,
      visualQuality: { score: 96, criteria: [] },
      advertisingEffectiveness: { score: 50, criteria: [] },
      verdict: 'REPAIR_REQUIRED',
    };

    it('aucune réparation SUBTITLE_ONLY/AUDIO_REGEN/CLIP_REGEN déclenchée quand tous les défauts sont UNAVAILABLE_DEFECT — épuisement immédiat, zéro coût gaspillé', async () => {
      const deps = buildDeps({ judgeResults: [UNAVAILABLE_ONLY_JUDGE] });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      const outcome = await service.run(CTX, buildParams());

      expect(outcome.status).toBe('REPAIR_EXHAUSTED');
      expect(deps.aiGateway.generateText).not.toHaveBeenCalled(); // pas de SUBTITLE_ONLY sur pacing/textReadability/grammar
      expect(deps.aiGateway.generateAudio).not.toHaveBeenCalled(); // pas d'AUDIO_REGEN sur ctaClarity
      expect(deps.aiGateway.generateVideo).not.toHaveBeenCalled(); // aucun CLIP_REGEN
      if (outcome.status === 'REPAIR_EXHAUSTED') {
        expect(outcome.attempts[0].repairsApplied).toEqual([]);
      }
    });

    it('un vrai défaut (audioQuality) coexistant avec les 9 UNAVAILABLE_DEFECT est réparé normalement, les 9 faux défauts sont ignorés', async () => {
      const withRealDefect: VideoJudgeResult = {
        ...UNAVAILABLE_ONLY_JUDGE,
        criteria: [
          ...UNAVAILABLE_ONLY_JUDGE.criteria,
          { name: 'audioQuality', score: 49, justification: 'x', defect: 'Le mixage final ne converge pas vers le niveau sonore cible' },
        ],
      };
      // 2e jugement : même 15 critères (jamais de critère manquant, sinon le garde-fou
      // anti-régression — Phase A — le traiterait comme une chute à 0, cf. repair-regression-guard.ts),
      // tous résolus à un score sain après la réparation AUDIO_REGEN.
      const resolvedJudge: VideoJudgeResult = {
        criteria: withRealDefect.criteria.map((c) => ({ name: c.name, score: 90, justification: 'ok' })),
        globalScore: 90,
        visualQuality: { score: 90, criteria: [] },
        advertisingEffectiveness: { score: 90, criteria: [] },
        verdict: 'PASS',
      };
      const deps = buildDeps({ judgeResults: [withRealDefect, resolvedJudge] });
      const service = new VideoQualityLoopService(deps.aiGateway, promptEngine, deps.videoDirector, deps.videoFinalization, deps.videoJudge);

      const outcome = await service.run(CTX, buildParams());

      expect(outcome.status).toBe('PASSED');
      expect(deps.aiGateway.generateAudio).toHaveBeenCalledTimes(1); // le VRAI défaut audio est réparé
      expect(deps.aiGateway.generateText).not.toHaveBeenCalled(); // les 9 faux défauts texte restent ignorés
    });
  });
});
