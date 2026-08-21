import * as fs from 'fs';

// Même convention que video-analyzer.service.spec.ts / video-assembly.service.spec.ts : mock de
// fluent-ffmpeg contrôlable, variables préfixées "mock" (hoisting Jest). Quatre "modes" de
// commande distingués par la méthode appelée : audioFilters(string) -> mesure de niveau sonore
// (loudnorm), audioFilters(array) -> Mission 4 Phase D, dynamique vocale (astats RMS),
// videoFilters(array) -> Mission 4 Phase A, composition (cropdetect), seekInput()+frames() ->
// extraction de frame.
const mockCreatedCommands: any[] = [];
const mockLoudnormStats = { value: '{"input_i":"-16.0","input_tp":"-1.5"}' as string | null };
// Bande "ADEQUATE" par défaut (écart-type ~4 dB, cf. ACOUSTIC_DYNAMICS_SCORE_REFERENCE_STDDEV)
// pour que les tests happy-path n'introduisent pas un défaut voiceDynamism non demandé.
const mockRmsLines: string[] = [
  'lavfi.astats.Overall.RMS_level=-20.0',
  'lavfi.astats.Overall.RMS_level=-16.0',
  'lavfi.astats.Overall.RMS_level=-24.0',
  'lavfi.astats.Overall.RMS_level=-18.0',
];
// FULL_FRAME par défaut (crop == canvas 720x1280) sur 4 échantillons pour que les tests
// happy-path n'introduisent pas un défaut formatCompliance non demandé.
function cropLine(w: number, h: number, ptsTime: number): string {
  return `[Parsed_cropdetect_1 @ 0x0] x1:0 x2:${w - 1} y1:0 y2:${h - 1} w:${w} h:${h} x:0 y:0 pts:${Math.round(ptsTime)} pts_time:${ptsTime.toFixed(6)} crop=${w}:${h}:0:0`;
}
const mockCropLines: string[] = [cropLine(720, 1280, 1), cropLine(720, 1280, 2), cropLine(720, 1280, 3), cropLine(720, 1280, 4)];
const mockNextFailure = { message: null as string | null };
const mockFfprobeDuration = { value: 10 };
const mockFfprobeImpl = jest.fn((filePath: string, cb: (err: any, data: any) => void) => {
  cb(null, { format: { duration: mockFfprobeDuration.value }, streams: [{ codec_type: 'video', width: 720, height: 1280 }] });
});

jest.mock('fluent-ffmpeg', () => {
  const fn = jest.fn(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    let isLoudnorm = false;
    let isRmsVariance = false;
    let isCropDetect = false;
    const command: any = {
      audioFilters: jest.fn((filters: string | string[]) => {
        if (Array.isArray(filters)) isRmsVariance = true;
        else isLoudnorm = true;
        return command;
      }),
      videoFilters: jest.fn(() => {
        isCropDetect = true;
        return command;
      }),
      outputOptions: jest.fn(() => command),
      seekInput: jest.fn(() => command),
      frames: jest.fn(() => command),
      on: jest.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb;
        return command;
      }),
      save: jest.fn((outputPath: string) => {
        command.__outputPath = outputPath;
        if (mockNextFailure.message) {
          const failureMessage = mockNextFailure.message;
          mockNextFailure.message = null;
          setImmediate(() => handlers.error?.(new Error(failureMessage)));
          return;
        }
        if (isLoudnorm) {
          if (mockLoudnormStats.value) handlers.stderr?.(mockLoudnormStats.value);
        } else if (isRmsVariance) {
          mockRmsLines.forEach((line) => handlers.stderr?.(line));
        } else if (isCropDetect) {
          mockCropLines.forEach((line) => handlers.stderr?.(line));
        } else {
          fs.writeFileSync(outputPath, Buffer.from('fake-frame-bytes'));
        }
        setImmediate(() => handlers.end?.());
      }),
    };
    mockCreatedCommands.push(command);
    return command;
  });
  (fn as any).setFfmpegPath = jest.fn();
  (fn as any).setFfprobePath = jest.fn();
  (fn as any).ffprobe = mockFfprobeImpl;
  return fn;
});

import { VideoJudgeService } from './video-judge.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { ShotQualityResult } from '../video-direction/video-analyzer.service';
import { VisualDna } from '../video-direction/visual-dna.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { Shot } from '../video-direction/video-director.service';

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };
const promptEngine = new PromptEngineService();

const VISUAL_DNA: VisualDna = { productCategory: 'chaussures', colors: ['bleu'], materials: ['mesh'], shape: 'basse', distinctiveFeatures: [], logoOrBrandMarks: null, raw: '{}' };
const CONCEPT: CreativeConcept = {
  title: 't', concept: 'c', coreMessage: 'm', hook: 'h', emotionalDirection: 'e', visualDirection: 'v',
  storytellingApproach: 's', proofStrategy: 'p', cta: 'cta', targetAudience: 'a', duration: 15, format: '9:16', scenesCount: 2, raw: '{}',
};
const SHOT_1: Shot = { sceneId: 'shot-1', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', onScreenText: 'Visible dans le noir' };
const SHOT_2: Shot = { sceneId: 'shot-2', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };
const SHOT_3: Shot = { sceneId: 'shot-3', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };

function buildQuality(fidelityScore: number, motionScore: number): ShotQualityResult {
  return {
    passed: fidelityScore >= 70 && motionScore >= 70,
    qualityScore: Math.round(fidelityScore * 0.6 + motionScore * 0.4),
    motionQuality: { passed: motionScore >= 70, score: motionScore, reasons: motionScore < 70 ? ['quasi-statique'] : [], freezeRatio: 0 },
    visualFidelity: { passed: fidelityScore >= 70, score: fidelityScore, reasons: fidelityScore < 70 ? ['produit différent'] : [] },
    reasons: [],
  };
}

const NINE_TEXT_CRITERIA = ['storytelling', 'hookStrength', 'pacing', 'textReadability', 'grammar', 'ctaClarity', 'brandCoherence', 'factualConsistency', 'advertisingEffectiveness'];

function buildGatewayMock(
  opts: {
    textJson?: string;
    textError?: Error;
    visionJson?: string;
    visionError?: Error;
    sceneConsistencyJson?: string;
    sceneConsistencyError?: Error;
  } = {},
) {
  const textContent = opts.textJson ?? JSON.stringify(NINE_TEXT_CRITERIA.map((name) => ({ name, score: 85, justification: 'ok' })));
  const textMock = opts.textError
    ? jest.fn().mockRejectedValue(opts.textError)
    : jest.fn(async () => ({ content: textContent, provider: 'anthropic', model: 'claude', durationMs: 10 }));

  // Distingue les 2 appels vision par le contenu du prompt (Mission 4 Phase B introduit un 2e
  // appel, dédié à sceneConsistency, distinct de celui productVisibility+visualComposition).
  const visionMock = jest.fn(async (_ctx: unknown, params: { prompt: string }) => {
    const isSceneConsistency = params.prompt.includes('COHÉRENCE VISUELLE');
    if (isSceneConsistency) {
      if (opts.sceneConsistencyError) throw opts.sceneConsistencyError;
      return {
        content: opts.sceneConsistencyJson ?? JSON.stringify({ score: 92, confidence: 0.9, defects: [] }),
        provider: 'openai',
        model: 'gpt-vision',
        durationMs: 5,
      };
    }
    if (opts.visionError) throw opts.visionError;
    return {
      content: opts.visionJson ?? JSON.stringify({ visible: true, score: 90, reason: 'produit net et central', composition: { score: 88, reason: 'cadrage équilibré' } }),
      provider: 'openai',
      model: 'gpt-vision',
      durationMs: 5,
    };
  });

  return {
    generateText: textMock,
    analyzeImage: visionMock,
  } as unknown as AiGatewayService;
}

function buildParams(overrides: Partial<Parameters<VideoJudgeService['judge']>[1]> = {}) {
  return {
    finalVideoBuffer: Buffer.from('fake-video'),
    narrationBuffer: Buffer.from('fake-narration'),
    shotPlan: [SHOT_1, SHOT_2],
    perShotQuality: new Map([
      ['shot-1', buildQuality(90, 90)],
      ['shot-2', buildQuality(85, 88)],
    ]),
    visualDna: VISUAL_DNA,
    concept: CONCEPT,
    // Mission 4 Phase D : 3,0 mots/s sur 3s, aucune pause — dans la cible VOICE_PACING_OK
    // ([2.5, 3.5]) pour ne pas introduire de défaut voicePacing non demandé dans les tests
    // qui ne testent pas spécifiquement ce critère (cf. describe dédié plus bas).
    transcript: [{ start: 0, end: 3, text: 'Le produit reste visible même dans le noir total.' }],
    productProfile: null,
    ...overrides,
  };
}

describe('VideoJudgeService.judge', () => {
  beforeEach(() => {
    mockCreatedCommands.length = 0;
    mockLoudnormStats.value = '{"input_i":"-16.0","input_tp":"-1.5"}';
    mockRmsLines.length = 0;
    mockRmsLines.push('lavfi.astats.Overall.RMS_level=-20.0', 'lavfi.astats.Overall.RMS_level=-16.0', 'lavfi.astats.Overall.RMS_level=-24.0', 'lavfi.astats.Overall.RMS_level=-18.0');
    mockCropLines.length = 0;
    mockCropLines.push(cropLine(720, 1280, 1), cropLine(720, 1280, 2), cropLine(720, 1280, 3), cropLine(720, 1280, 4));
    mockNextFailure.message = null;
    mockFfprobeDuration.value = 10;
    mockFfprobeImpl.mockClear();
  });

  it('vidéo de bonne qualité sur tous les fronts : verdict PASS, formatCompliance toujours 100', async () => {
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    expect(result.verdict).toBe('PASS');
    expect(result.globalScore).toBeGreaterThanOrEqual(75);
    expect(result.criteria.find((c) => c.name === 'formatCompliance')?.score).toBe(100);
    expect(result.criteria).toHaveLength(19); // 15 + voiceDynamism + voicePacing (Phase D) + visualComposition (Phase A) + sceneConsistency (Phase B)
  });

  it('Phase D — sous-scores exacts : moyenne pondérée renormalisée au sein de chaque groupe (visualQuality / advertisingEffectiveness)', async () => {
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    const WEIGHTS_MIRROR: Record<string, number> = {
      productConsistency: 12, factualConsistency: 10, advertisingEffectiveness: 10, productVisibility: 7,
      storytelling: 7, hookStrength: 6, ctaClarity: 7, brandCoherence: 5, motionDynamism: 4, pacing: 5,
      audioQuality: 4, voiceAudibility: 3, formatCompliance: 3, textReadability: 2, grammar: 2,
      voiceDynamism: 4, voicePacing: 3, // Mission 4 Phase D
      visualComposition: 3, // Mission 4 Phase A
      sceneConsistency: 3, // Mission 4 Phase B
    };
    const VISUAL = ['productConsistency', 'motionDynamism', 'productVisibility', 'brandCoherence', 'formatCompliance', 'textReadability', 'grammar', 'audioQuality', 'voiceAudibility', 'voiceDynamism', 'voicePacing', 'visualComposition', 'sceneConsistency'];
    const ADVERTISING = ['advertisingEffectiveness', 'hookStrength', 'ctaClarity', 'storytelling', 'pacing', 'factualConsistency'];

    function expectedSubScore(group: string[]): number {
      const items = result.criteria.filter((c) => group.includes(c.name));
      const totalWeight = items.reduce((sum, c) => sum + WEIGHTS_MIRROR[c.name], 0);
      const weightedSum = items.reduce((sum, c) => sum + c.score * WEIGHTS_MIRROR[c.name], 0);
      return Math.round(weightedSum / totalWeight);
    }

    expect(result.visualQuality.score).toBe(expectedSubScore(VISUAL));
    expect(result.advertisingEffectiveness.score).toBe(expectedSubScore(ADVERTISING));
    expect(result.visualQuality.criteria).toEqual(VISUAL);
    expect(result.advertisingEffectiveness.criteria).toEqual(ADVERTISING);
  });

  it("Règle 2 (spec V2) — visuel excellent mais efficacité publicitaire faible : REPAIR_REQUIRED même si globalScore franchirait seul le seuil", async () => {
    const gateway = buildGatewayMock({
      textJson: JSON.stringify(
        NINE_TEXT_CRITERIA.map((name) =>
          ['storytelling', 'hookStrength', 'pacing', 'ctaClarity', 'factualConsistency', 'advertisingEffectiveness'].includes(name)
            ? { name, score: 40, justification: 'ne persuade pas' }
            : { name, score: 95, justification: 'ok' },
        ),
      ),
      visionJson: JSON.stringify({ visible: true, score: 95, reason: 'produit net et central' }),
    });
    const service = new VideoJudgeService(gateway, promptEngine);
    const params = buildParams({
      perShotQuality: new Map([
        ['shot-1', buildQuality(95, 95)],
        ['shot-2', buildQuality(95, 95)],
      ]),
    });

    const result = await service.judge(CTX, params);

    expect(result.visualQuality.score).toBeGreaterThanOrEqual(85);
    expect(result.advertisingEffectiveness.score).toBeLessThan(60);
    // Preuve que ce n'est PAS le score global qui bloque ici (il franchirait seul PASS_THRESHOLD=62) —
    // c'est bien le plancher publicitaire indépendant qui rejette la vidéo, conformément à la Règle 2.
    expect(result.globalScore).toBeGreaterThanOrEqual(62);
    expect(result.verdict).toBe('REPAIR_REQUIRED');
  });

  it('productConsistency agrégé = moyenne des visualFidelity.score par plan (coût IA nul, pas un nouvel appel vision par plan)', async () => {
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    const productConsistency = result.criteria.find((c) => c.name === 'productConsistency');
    expect(productConsistency?.score).toBe(Math.round((90 + 85) / 2));
  });

  it('critère critique (productConsistency) sous le plancher : REPAIR_REQUIRED même si le score global reste correct', async () => {
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);
    const params = buildParams({
      perShotQuality: new Map([
        ['shot-1', buildQuality(20, 95)], // fidélité catastrophique
        ['shot-2', buildQuality(20, 95)],
      ]),
    });

    const result = await service.judge(CTX, params);

    expect(result.criteria.find((c) => c.name === 'productConsistency')?.score).toBeLessThan(50);
    expect(result.verdict).toBe('REPAIR_REQUIRED');
  });

  it('critère critique (factualConsistency) sous le plancher via le jugement texte : REPAIR_REQUIRED', async () => {
    const textJson = JSON.stringify(
      NINE_TEXT_CRITERIA.map((name) => (name === 'factualConsistency' ? { name, score: 10, justification: 'affirme une certification non vérifiée' } : { name, score: 90, justification: 'ok' })),
    );
    const gateway = buildGatewayMock({ textJson });
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    expect(result.verdict).toBe('REPAIR_REQUIRED');
  });

  it('réponse du jugement texte non conforme au JSON attendu : repli neutre (50) sur les 9 critères texte, ne lève jamais', async () => {
    const gateway = buildGatewayMock({ textJson: 'Désolé, je ne peux pas juger cette vidéo.' });
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    for (const name of NINE_TEXT_CRITERIA) {
      const criterion = result.criteria.find((c) => c.name === name);
      expect(criterion?.score).toBe(50);
      expect(criterion?.defect).toBe('Vérification indisponible');
    }
  });

  it("échec total de l'appel de jugement texte (tous fournisseurs épuisés, ex. AbortError) : repli neutre (50) sur les 9 critères, ne lève jamais — ne doit pas faire planter toute la campagne", async () => {
    const gateway = buildGatewayMock({ textError: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    for (const name of NINE_TEXT_CRITERIA) {
      const criterion = result.criteria.find((c) => c.name === name);
      expect(criterion?.score).toBe(50);
      expect(criterion?.defect).toBe('Vérification indisponible');
    }
  });

  describe('Audit forensique Mission 4.2 (P0-3) — panne de mesure du jugement texte groupé ne doit plus, à elle seule, faire échouer le verdict', () => {
    it("échec total de l'appel texte (tous les critères d'advertisingEffectiveness UNAVAILABLE_DEFECT) mais tout le reste mesuré est bon : verdict PASS, pas REPAIR_REQUIRED par pure panne de mesure", async () => {
      const gateway = buildGatewayMock({ textError: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());

      expect(result.advertisingEffectiveness.dataAvailable).toBe(false);
      expect(result.criteria.find((c) => c.name === 'factualConsistency')?.defect).toBe('Vérification indisponible');
      // factualConsistency est un critère CRITIQUE (CRITICAL_CRITERIA) — sa panne de mesure ne
      // doit plus, à elle seule, déclencher criticalFailure (comportement avant P0-3 : cassé).
      expect(result.verdict).toBe('PASS');
    });

    it("panne de mesure du texte groupé MAIS un vrai défaut critique mesuré ailleurs (productConsistency) : verdict reste REPAIR_REQUIRED — la panne de mesure ne doit jamais non plus masquer un vrai défaut", async () => {
      const gateway = buildGatewayMock({ textError: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
      const service = new VideoJudgeService(gateway, promptEngine);
      const params = buildParams({
        perShotQuality: new Map([
          ['shot-1', buildQuality(20, 95)], // fidélité catastrophique, mesurée déterministiquement (pas via le texte)
          ['shot-2', buildQuality(20, 95)],
        ]),
      });

      const result = await service.judge(CTX, params);

      expect(result.criteria.find((c) => c.name === 'productConsistency')?.score).toBeLessThan(50);
      expect(result.verdict).toBe('REPAIR_REQUIRED');
    });
  });

  it('un critère texte manquant dans le tableau renvoyé : repli neutre pour CE critère seulement, les autres restent tels que renvoyés', async () => {
    const textJson = JSON.stringify(NINE_TEXT_CRITERIA.filter((n) => n !== 'grammar').map((name) => ({ name, score: 80, justification: 'ok' })));
    const gateway = buildGatewayMock({ textJson });
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    expect(result.criteria.find((c) => c.name === 'grammar')?.score).toBe(50);
    expect(result.criteria.find((c) => c.name === 'storytelling')?.score).toBe(80);
  });

  it('perShotQuality vide (aucune donnée par plan) : productConsistency/motionDynamism neutres, ne lève jamais', async () => {
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams({ perShotQuality: new Map() }));

    expect(result.criteria.find((c) => c.name === 'productConsistency')?.score).toBe(50);
    expect(result.criteria.find((c) => c.name === 'motionDynamism')?.score).toBe(50);
  });

  it('narrationBuffer absent (narration non disponible) : voiceAudibility neutre, ne lève jamais', async () => {
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams({ narrationBuffer: null }));

    expect(result.criteria.find((c) => c.name === 'voiceAudibility')?.score).toBe(50);
  });

  it('mixage final loin de la cible -16 LUFS : audioQuality bas', async () => {
    mockLoudnormStats.value = '{"input_i":"-30.0"}';
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    expect(result.criteria.find((c) => c.name === 'audioQuality')?.score).toBeLessThan(50);
  });

  it("échec de la mesure de niveau sonore (ffmpeg) : audioQuality neutre, ne lève jamais", async () => {
    mockNextFailure.message = 'codec introuvable';
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    expect(result.criteria.find((c) => c.name === 'audioQuality')?.score).toBe(50);
  });

  it('échec analyzeImage (productVisibility, tous fournisseurs vision indisponibles) : repli neutre, ne lève jamais', async () => {
    const gateway = buildGatewayMock({ visionError: new Error('tous les fournisseurs ont échoué') });
    const service = new VideoJudgeService(gateway, promptEngine);

    const result = await service.judge(CTX, buildParams());

    expect(result.criteria.find((c) => c.name === 'productVisibility')?.score).toBe(50);
  });

  it('transmet promptVersion pour la traçabilité (appel texte groupé)', async () => {
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    await service.judge(CTX, buildParams());

    const [, , , promptVersion] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(promptVersion).toBe('video-judge-v2');
  });

  it('exactement 3 appels IA au total (2 vision + 1 texte), quel que soit le nombre de critères', async () => {
    // Mission 4 Phase B : sceneConsistency introduit un 2e appel vision DÉLIBÉRÉ (comparaison
    // inter-plans, impossible autrement) — le compte passe de 1 à 2 appels vision, jamais plus
    // (visualComposition, lui, reste gratuit : même appel que productVisibility, cf. test dédié).
    const gateway = buildGatewayMock();
    const service = new VideoJudgeService(gateway, promptEngine);

    await service.judge(CTX, buildParams());

    expect((gateway.generateText as jest.Mock).mock.calls.length).toBe(1);
    expect((gateway.analyzeImage as jest.Mock).mock.calls.length).toBe(2);
  });

  // Mission 3 (validation empirique, 2026-08-20) — fix ciblé issu de l'audit de 3 campagnes
  // réelles historiques : un 1er échec de l'appel texte groupé ne doit plus condamner directement
  // les 9 critères au repli neutre — une seconde tentative est faite d'abord (coût marginal : 1
  // appel texte, contre potentiellement 2 cycles de réparation locale gaspillés en aval).
  describe('Mission 3 — retry de l\'appel texte groupé avant repli neutre', () => {
    it('1er appel échoue (AbortError), 2e appel réussit : utilise les VRAIS scores du 2e appel, exactement 2 appels texte', async () => {
      const analyzeImage = jest.fn(async () => ({ content: JSON.stringify({ visible: true, score: 90, reason: 'ok' }), provider: 'openai', model: 'gpt-vision', durationMs: 5 }));
      const generateText = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        .mockResolvedValueOnce({ content: JSON.stringify(NINE_TEXT_CRITERIA.map((name) => ({ name, score: 88, justification: 'contenu réellement évalué' }))), provider: 'anthropic', model: 'claude', durationMs: 10 });
      const gateway = { generateText, analyzeImage } as unknown as AiGatewayService;
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());

      expect(generateText).toHaveBeenCalledTimes(2);
      for (const name of NINE_TEXT_CRITERIA) {
        const criterion = result.criteria.find((c) => c.name === name);
        expect(criterion?.score).toBe(88);
        expect(criterion?.defect).toBeUndefined();
      }
    });

    it('1er appel réussit ET renvoie tous les critères : jamais de 2e appel (coût non gaspillé)', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      await service.judge(CTX, buildParams());

      expect((gateway.generateText as jest.Mock).mock.calls.length).toBe(1);
    });

    it('les 2 appels échouent : repli neutre sur les 9 critères comme avant, jamais plus de 2 appels texte au total', async () => {
      const analyzeImage = jest.fn(async () => ({ content: JSON.stringify({ visible: true, score: 90, reason: 'ok' }), provider: 'openai', model: 'gpt-vision', durationMs: 5 }));
      const generateText = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const gateway = { generateText, analyzeImage } as unknown as AiGatewayService;
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());

      expect(generateText).toHaveBeenCalledTimes(2);
      for (const name of NINE_TEXT_CRITERIA) {
        const criterion = result.criteria.find((c) => c.name === name);
        expect(criterion?.score).toBe(50);
        expect(criterion?.defect).toBe('Vérification indisponible');
      }
    });
  });

  describe('Mission 4 Phase D — voiceDynamism (variance RMS de la narration isolée)', () => {
    it('dynamique acoustique adéquate (fixture par défaut) : aucun défaut, mesure exposée (measurementMethod/isApproximation), jamais "EMOTION"', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'voiceDynamism');

      expect(criterion?.defect).toBeUndefined();
      expect(criterion?.measurementMethod).toBe('FFMPEG_RMS_VARIANCE');
      expect(criterion?.isApproximation).toBe(true);
      expect(criterion?.justification).toContain('ACOUSTIC_DYNAMICS_ADEQUATE');
      expect(criterion?.justification).not.toMatch(/EMOTION/);
    });

    it('TEST 10 (Mission 4 Correction 2) — dynamique acoustique basse : état ACOUSTIC_DYNAMICS_LOW, jamais EMOTION_LOW ni aucune variante EMOTION_*', async () => {
      // Fenêtres quasi identiques (écart-type ~0 dB) -> narration acoustiquement plate.
      mockRmsLines.length = 0;
      mockRmsLines.push('lavfi.astats.Overall.RMS_level=-20.0', 'lavfi.astats.Overall.RMS_level=-20.1', 'lavfi.astats.Overall.RMS_level=-19.9');
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'voiceDynamism');

      expect(criterion?.justification).toContain('ACOUSTIC_DYNAMICS_LOW');
      expect(criterion?.defect).toBe('Narration acoustiquement plate (peu de variation de volume dans le temps)');
      expect(JSON.stringify(result)).not.toMatch(/EMOTION/);
    });

    it('dynamique acoustique haute : état ACOUSTIC_DYNAMICS_HIGH, jamais EMOTION_HIGH', async () => {
      mockRmsLines.length = 0;
      mockRmsLines.push('lavfi.astats.Overall.RMS_level=-5.0', 'lavfi.astats.Overall.RMS_level=-30.0', 'lavfi.astats.Overall.RMS_level=-8.0', 'lavfi.astats.Overall.RMS_level=-28.0');
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'voiceDynamism');

      expect(criterion?.justification).toContain('ACOUSTIC_DYNAMICS_HIGH');
      expect(JSON.stringify(result)).not.toMatch(/EMOTION/);
    });

    it('narrationBuffer absent : UNAVAILABLE_DEFECT, jamais traité comme une narration plate', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams({ narrationBuffer: null }));
      const criterion = result.criteria.find((c) => c.name === 'voiceDynamism');

      expect(criterion?.defect).toBe('Vérification indisponible');
    });

    it('moins de 2 fenêtres RMS mesurables : UNAVAILABLE_DEFECT (narration trop courte pour une mesure fiable)', async () => {
      mockRmsLines.length = 0;
      mockRmsLines.push('lavfi.astats.Overall.RMS_level=-20.0');
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'voiceDynamism');

      expect(criterion?.defect).toBe('Vérification indisponible');
    });
  });

  describe('Mission 4 Phase D — voicePacing (débit de parole dérivé des TranscriptSegment, zéro appel)', () => {
    it('débit dans la cible, aucune pause : VOICE_PACING_OK, aucun défaut', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'voicePacing');

      expect(criterion?.defect).toBeUndefined();
      expect(criterion?.justification).toContain('VOICE_PACING_OK');
      expect(criterion?.measurementMethod).toBe('FFMPEG_TIMING');
    });

    it('débit trop rapide : VOICE_TOO_FAST', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      // 10 mots en 1s = 10 mots/s, largement au-dessus de VOICE_PACING_MAX_WORDS_PER_SECOND (3.5).
      const result = await service.judge(CTX, buildParams({ transcript: [{ start: 0, end: 1, text: 'un deux trois quatre cinq six sept huit neuf dix' }] }));
      const criterion = result.criteria.find((c) => c.name === 'voicePacing');

      expect(criterion?.defect).toBe('VOICE_TOO_FAST');
    });

    it('débit trop lent : VOICE_TOO_SLOW', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      // 2 mots en 4s = 0.5 mot/s, sous VOICE_PACING_MIN_WORDS_PER_SECOND (2.5).
      const result = await service.judge(CTX, buildParams({ transcript: [{ start: 0, end: 4, text: 'trop lent' }] }));
      const criterion = result.criteria.find((c) => c.name === 'voicePacing');

      expect(criterion?.defect).toBe('VOICE_TOO_SLOW');
    });

    it('ratio de pause élevé entre segments : VOICE_PAUSE_HEAVY (prioritaire sur le débit)', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      // 2 segments à débit correct chacun, séparés par un long silence : le ratio de pause sur
      // la durée totale domine le diagnostic, même si le débit PARLÉ (pauses exclues) est sain.
      const result = await service.judge(
        CTX,
        buildParams({
          transcript: [
            { start: 0, end: 1, text: 'un deux trois' },
            { start: 6, end: 7, text: 'quatre cinq six' },
          ],
        }),
      );
      const criterion = result.criteria.find((c) => c.name === 'voicePacing');

      expect(criterion?.defect).toBe('VOICE_PAUSE_HEAVY');
    });

    it('transcript absent : UNAVAILABLE_DEFECT', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams({ transcript: null }));
      const criterion = result.criteria.find((c) => c.name === 'voicePacing');

      expect(criterion?.defect).toBe('Vérification indisponible');
    });
  });

  describe('Mission 4 Phase A — formatCompliance (cropdetect ffmpeg, mesure réelle) et visualComposition (vision)', () => {
    it('cadre plein (fixture par défaut) : FULL_FRAME, score 100, confidence haute, aucun sceneRef', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'formatCompliance');

      expect(criterion?.score).toBe(100);
      expect(criterion?.defect).toBeUndefined();
      expect(criterion?.confidence).toBeGreaterThanOrEqual(0.9);
      expect(criterion?.measurementMethod).toBe('FFMPEG_CROPDETECT');
      expect(criterion?.sceneRef).toBeUndefined();
    });

    it("TEST 15 (Round 4) — défaut localisé à un seul plan, confiance haute : BORDER_DETECTED, sceneRef pointe UNIQUEMENT ce plan", async () => {
      // shot-1 = [0,5), shot-2 = [5,10) (répartition égale, durée 10s, aucun startTime/endTime
      // réel sur SHOT_1/SHOT_2 ici) : shot-1 plein cadre, shot-2 letterboxé de façon CONSTANTE.
      mockCropLines.length = 0;
      mockCropLines.push(cropLine(720, 1280, 1), cropLine(720, 1280, 2), cropLine(720, 1024, 6), cropLine(720, 1024, 7));
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'formatCompliance');

      expect(criterion?.defect).toBe('BORDER_DETECTED');
      expect(criterion?.confidence).toBeGreaterThanOrEqual(0.5);
      expect(criterion?.sceneRef).toBe('shot-2');
    });

    it("TEST 16 (Round 4) — défaut détecté sur TOUT l'échantillonnage (global), même à confiance élevée : jamais de sceneRef", async () => {
      // Ratio bas mais parfaitement CONSTANT sur toute la vidéo (shot-1 ET shot-2) — confiance
      // haute, mais le défaut n'est localisable à AUCUN plan précis en particulier.
      mockCropLines.length = 0;
      mockCropLines.push(cropLine(720, 640, 1), cropLine(720, 640, 2), cropLine(720, 640, 6), cropLine(720, 640, 7));
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'formatCompliance');

      expect(criterion?.defect).toBe('UNDERFILLED');
      expect(criterion?.confidence).toBeGreaterThanOrEqual(0.5);
      expect(criterion?.sceneRef).toBeUndefined();
    });

    it('TEST 9 (Correction 1) — détection erratique/incohérente : INCONCLUSIVE, jamais un LETTERBOX_DETECTED binaire auto-déclenché', async () => {
      mockCropLines.length = 0;
      mockCropLines.push(cropLine(720, 1152, 1), cropLine(720, 640, 2), cropLine(720, 1088, 3), cropLine(720, 384, 4));
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'formatCompliance');

      expect(criterion?.defect).toBe('INCONCLUSIVE');
      expect(criterion?.confidence).toBeLessThan(0.5);
      expect(criterion?.sceneRef).toBeUndefined();
    });

    it('moins de 3 échantillons cropdetect : UNAVAILABLE_DEFECT, jamais une classification tirée de données insuffisantes', async () => {
      mockCropLines.length = 0;
      mockCropLines.push(cropLine(720, 640, 1));
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'formatCompliance');

      expect(criterion?.defect).toBe('Vérification indisponible');
    });

    it('visualComposition : score/justification dérivés du champ "composition" du MÊME appel vision, zéro appel IA supplémentaire', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'visualComposition');

      expect(criterion?.score).toBe(88);
      expect(criterion?.justification).toBe('cadrage équilibré');
      // 2 appels vision au total (productVisibility+visualComposition, puis sceneConsistency,
      // Phase B) — jamais un 3e appel dédié à visualComposition seul (même appel que productVisibility).
      expect((gateway.analyzeImage as jest.Mock).mock.calls.length).toBe(2);
    });

    it('composition sous le plancher critique : defect renseigné', async () => {
      const gateway = buildGatewayMock({
        visionJson: JSON.stringify({ visible: true, score: 90, reason: 'ok', composition: { score: 30, reason: 'cadrage déséquilibré, produit hors-champ' } }),
      });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'visualComposition');

      expect(criterion?.score).toBe(30);
      expect(criterion?.defect).toBe('cadrage déséquilibré, produit hors-champ');
    });

    it('champ "composition" absent de la réponse vision : UNAVAILABLE_DEFECT, jamais une note inventée', async () => {
      const gateway = buildGatewayMock({ visionJson: JSON.stringify({ visible: true, score: 90, reason: 'ok' }) });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'visualComposition');

      expect(criterion?.defect).toBe('Vérification indisponible');
    });
  });

  describe('Mission 4 Phase B — sceneConsistency (cohérence inter-plans, vision groupée)', () => {
    it('aucune rupture détectée : score élevé, aucun défaut, measurementMethod VISION_MULTI_FRAME', async () => {
      const gateway = buildGatewayMock({ sceneConsistencyJson: JSON.stringify({ score: 95, confidence: 0.9, defects: [] }) });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      expect(criterion?.score).toBe(95);
      expect(criterion?.confidence).toBe(0.9);
      expect(criterion?.defect).toBeUndefined();
      expect(criterion?.defects).toEqual([]);
      expect(criterion?.measurementMethod).toBe('VISION_MULTI_FRAME');
    });

    it("TEST 12 (Correction 3, recoupe TEST 3) — un seul défaut, sceneRef unique, confiance haute : sceneRef top-level renseigné", async () => {
      const gateway = buildGatewayMock({
        sceneConsistencyJson: JSON.stringify({
          score: 54,
          confidence: 0.91,
          defects: [{ sceneRef: 'shot-2', issue: 'éclairage plus sombre que le reste', severity: 'HIGH', confidence: 0.91 }],
        }),
      });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      expect(criterion?.score).toBe(54);
      expect(criterion?.sceneRef).toBe('shot-2');
      expect(criterion?.confidence).toBe(0.91);
      expect(criterion?.defect).toBe('éclairage plus sombre que le reste');
      expect(criterion?.defects).toEqual([{ sceneRef: 'shot-2', issue: 'éclairage plus sombre que le reste', severity: 'HIGH', confidence: 0.91 }]);
    });

    it("TEST 11 (Correction 3) — défaut à confiance basse : toujours exposé dans defects[], mais AUCUN sceneRef top-level, jamais présenté comme réparable en confiance", async () => {
      const gateway = buildGatewayMock({
        sceneConsistencyJson: JSON.stringify({
          score: 54,
          confidence: undefined,
          defects: [{ sceneRef: 'shot-2', issue: 'ambigu', severity: 'MEDIUM', confidence: 0.3 }],
        }),
      });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      // Confidence top-level = confiance MINIMALE parmi les défauts (aucun `confidence` global
      // renvoyé par le modèle ici) — reste basse, ce que la Phase H utilisera pour refuser tout
      // CLIP_REGEN automatique malgré la présence d'un sceneRef.
      expect(criterion?.confidence).toBe(0.3);
      expect(criterion?.sceneRef).toBe('shot-2');
    });

    it('défaut concernant une PAIRE de plans (ambiguïté irréductible) : jamais de sceneRef top-level unique', async () => {
      const gateway = buildGatewayMock({
        sceneConsistencyJson: JSON.stringify({
          score: 50,
          confidence: 0.85,
          defects: [{ sceneRef: ['shot-1', 'shot-2'], issue: 'transition incohérente entre les deux plans', severity: 'MEDIUM', confidence: 0.85 }],
        }),
      });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      expect(criterion?.sceneRef).toBeUndefined();
      expect(criterion?.defects?.[0]?.sceneRef).toEqual(['shot-1', 'shot-2']);
    });

    it('plusieurs défauts distincts : aucun sceneRef top-level unique (ambigu à réduire), tous conservés dans defects[]', async () => {
      const gateway = buildGatewayMock({
        // Pas de "confidence" top-level ici (volontaire) : exerce le repli sur la confiance
        // MINIMALE dérivée des défauts individuels, pas une valeur globale fournie par le modèle.
        sceneConsistencyJson: JSON.stringify({
          score: 40,
          defects: [
            { sceneRef: 'shot-1', issue: 'décor incohérent', severity: 'HIGH', confidence: 0.8 },
            { sceneRef: 'shot-2', issue: 'style différent', severity: 'LOW', confidence: 0.6 },
          ],
        }),
      });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      expect(criterion?.sceneRef).toBeUndefined();
      expect(criterion?.defects).toHaveLength(2);
      expect(criterion?.defect).toBe('décor incohérent'); // le pire des deux (HIGH > LOW)
      expect(criterion?.confidence).toBe(0.6); // la plus basse des deux
    });

    describe("Audit forensique Mission 4.2 (P1-2) — résolution d'une scène coupable par corroboration entre plusieurs défauts (jamais une pure supposition)", () => {
      it("2 défauts en paire partageant la MÊME scène (shot-1/shot-2 et shot-1/shot-3) : shot-1 est le dénominateur commun, résolu en sceneRef top-level", async () => {
        const gateway = buildGatewayMock({
          sceneConsistencyJson: JSON.stringify({
            score: 40,
            defects: [
              { sceneRef: ['shot-1', 'shot-2'], issue: 'appareil différent', severity: 'HIGH', confidence: 0.8 },
              { sceneRef: ['shot-1', 'shot-3'], issue: 'appareil différent', severity: 'HIGH', confidence: 0.85 },
            ],
          }),
        });
        const service = new VideoJudgeService(gateway, promptEngine);

        const result = await service.judge(CTX, buildParams({ shotPlan: [SHOT_1, SHOT_2, SHOT_3] }));
        const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

        expect(criterion?.sceneRef).toBe('shot-1');
      });

      it("3 défauts pointant vers 3 paires disjointes (shot-1/shot-2, shot-2/shot-3, shot-1/shot-3 — cas réel campagne fb58f4cb) : aucun dénominateur commun, sceneRef top-level reste absent, jamais une résolution arbitraire", async () => {
        const gateway = buildGatewayMock({
          sceneConsistencyJson: JSON.stringify({
            score: 35,
            defects: [
              { sceneRef: ['shot-1', 'shot-2'], issue: 'appareil différent', severity: 'HIGH', confidence: 0.78 },
              { sceneRef: ['shot-1', 'shot-3'], issue: 'appareil différent', severity: 'HIGH', confidence: 0.78 },
              { sceneRef: ['shot-2', 'shot-3'], issue: 'timer graphique disparaît', severity: 'MEDIUM', confidence: 0.7 },
            ],
          }),
        });
        const service = new VideoJudgeService(gateway, promptEngine);

        const result = await service.judge(CTX, buildParams({ shotPlan: [SHOT_1, SHOT_2, SHOT_3] }));
        const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

        expect(criterion?.sceneRef).toBeUndefined();
      });

      it('un mélange défaut-paire + défaut-scène-unique partageant la même scène : dénominateur commun résolu malgré des formes de sceneRef différentes', async () => {
        const gateway = buildGatewayMock({
          sceneConsistencyJson: JSON.stringify({
            score: 45,
            defects: [
              { sceneRef: ['shot-1', 'shot-2'], issue: 'appareil différent', severity: 'HIGH', confidence: 0.8 },
              { sceneRef: 'shot-1', issue: 'éclairage incohérent avec le reste', severity: 'MEDIUM', confidence: 0.75 },
            ],
          }),
        });
        const service = new VideoJudgeService(gateway, promptEngine);

        const result = await service.judge(CTX, buildParams());
        const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

        expect(criterion?.sceneRef).toBe('shot-1');
      });
    });

    it('sceneRef renvoyé par le modèle hors de la liste des plans réels : défaut ignoré (jamais une référence inventée)', async () => {
      const gateway = buildGatewayMock({
        sceneConsistencyJson: JSON.stringify({
          score: 60,
          confidence: 0.8,
          defects: [{ sceneRef: 'shot-99', issue: 'inventé', severity: 'HIGH', confidence: 0.9 }],
        }),
      });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      expect(criterion?.defects).toEqual([]);
      expect(criterion?.defect).toBeUndefined();
    });

    it('un seul plan dans le ShotPlan : score 100, confiance 1, aucun appel vision dédié (rien à comparer)', async () => {
      const gateway = buildGatewayMock();
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams({ shotPlan: [SHOT_1], perShotQuality: new Map([['shot-1', buildQuality(90, 90)]]) }));
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      expect(criterion?.score).toBe(100);
      expect(criterion?.confidence).toBe(1);
      // 1 seul appel vision (productVisibility+visualComposition) — sceneConsistency n'en déclenche pas.
      expect((gateway.analyzeImage as jest.Mock).mock.calls.length).toBe(1);
    });

    it('échec de l\'appel vision groupé : UNAVAILABLE_DEFECT, ne lève jamais', async () => {
      const gateway = buildGatewayMock({ sceneConsistencyError: new Error('tous les fournisseurs ont échoué') });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      expect(criterion?.defect).toBe('Vérification indisponible');
    });

    it('réponse JSON non conforme : UNAVAILABLE_DEFECT, ne lève jamais', async () => {
      const gateway = buildGatewayMock({ sceneConsistencyJson: 'Désolé, je ne peux pas comparer ces images.' });
      const service = new VideoJudgeService(gateway, promptEngine);

      const result = await service.judge(CTX, buildParams());
      const criterion = result.criteria.find((c) => c.name === 'sceneConsistency');

      expect(criterion?.defect).toBe('Vérification indisponible');
    });
  });
});
