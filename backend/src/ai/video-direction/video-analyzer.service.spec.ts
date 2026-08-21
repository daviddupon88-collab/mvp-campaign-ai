import * as fs from 'fs';
import * as path from 'path';

// Convention Jest de ce projet (cf. video-assembly.service.spec.ts) : les variables référencées
// dans une factory jest.mock() (hoistée au-dessus des imports) doivent être préfixées "mock".
// Étend le pattern existant avec la capture des lignes `stderr` (freezedetect n'a pas d'autre
// canal de sortie que le texte stderr d'ffmpeg — jamais parsé ailleurs dans ce projet jusqu'ici).
const mockCreatedCommands: any[] = [];
const mockFreezeLines: string[] = [];
const mockNextFailure = { message: null as string | null };
const mockFfprobeDuration = { value: 6 };
const mockFfprobeImpl = jest.fn((filePath: string, cb: (err: any, data: any) => void) => {
  cb(null, { format: { duration: mockFfprobeDuration.value }, streams: [] });
});

jest.mock('fluent-ffmpeg', () => {
  const fn = jest.fn(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    let isFreezeDetect = false;
    const command: any = {
      videoFilters: jest.fn(() => {
        isFreezeDetect = true;
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
        if (isFreezeDetect) {
          mockFreezeLines.forEach((line) => handlers.stderr?.(line));
        }
        fs.writeFileSync(outputPath, Buffer.from('fake-frame-bytes'));
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

import { VideoAnalyzerService, classifyMotionLevel } from './video-analyzer.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { VisualDna } from './visual-dna.service';

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };
const VISUAL_DNA: VisualDna = {
  productCategory: 'chaussures',
  colors: ['bleu'],
  materials: ['mesh'],
  shape: 'basse',
  distinctiveFeatures: [],
  logoOrBrandMarks: null,
  raw: '{}',
};

function buildGatewayMock(analyzeImageContent: string | Error) {
  return {
    analyzeImage:
      analyzeImageContent instanceof Error
        ? jest.fn().mockRejectedValue(analyzeImageContent)
        : jest.fn(async () => ({ content: analyzeImageContent, provider: 'openai', model: 'gpt-vision', durationMs: 5 })),
  } as unknown as AiGatewayService;
}

describe('VideoAnalyzerService.analyze', () => {
  beforeEach(() => {
    mockCreatedCommands.length = 0;
    mockFreezeLines.length = 0;
    mockNextFailure.message = null;
    mockFfprobeDuration.value = 6;
    mockFfprobeImpl.mockClear();
  });

  it("ADN visuel de repli (isFallback=true) : fidélité neutre, dataAvailable=false, AUCUN appel de vérification déclenché (audit forensique Mission 4.2, P0-1)", async () => {
    const gateway = buildGatewayMock(JSON.stringify({ matches: true, score: 90, mismatches: [] }));
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: { ...VISUAL_DNA, isFallback: true } });

    expect(result.visualFidelity.dataAvailable).toBe(false);
    expect(result.visualFidelity.passed).toBe(true); // ne bloque jamais la génération sur une panne sans rapport
    expect(result.passed).toBe(true);
    expect(gateway.analyzeImage).not.toHaveBeenCalled(); // pas de comparaison hallucinatoire contre un ADN vide
  });

  it('aucun gel détecté + fidélité élevée : passed=true, qualityScore proche de 100', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ matches: true, score: 90, mismatches: [] }));
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: VISUAL_DNA });

    expect(result.passed).toBe(true);
    expect(result.motionQuality.passed).toBe(true);
    expect(result.motionQuality.freezeRatio).toBe(0);
    expect(result.visualFidelity.passed).toBe(true);
    expect(result.qualityScore).toBeGreaterThanOrEqual(90);
  });

  it('gel prolongé détecté (freeze_duration cumulé > 30% de la durée) : motionQuality.passed=false', async () => {
    mockFreezeLines.push('[Parsed_freezedetect_0] freeze_duration: 3.0');
    const gateway = buildGatewayMock(JSON.stringify({ matches: true, score: 90, mismatches: [] }));
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: VISUAL_DNA });

    expect(result.motionQuality.passed).toBe(false);
    expect(result.motionQuality.freezeRatio).toBeCloseTo(0.5);
    expect(result.passed).toBe(false);
    expect(result.motionQuality.reasons[0]).toContain('quasi-statique');
  });

  it('léger gel sous le seuil (< 30%) : motionQuality.passed=true', async () => {
    mockFreezeLines.push('[Parsed_freezedetect_0] freeze_duration: 1.0');
    const gateway = buildGatewayMock(JSON.stringify({ matches: true, score: 90, mismatches: [] }));
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: VISUAL_DNA });

    expect(result.motionQuality.passed).toBe(true);
  });

  it('vision renvoie matches=false : visualFidelity.passed=false même avec un score élevé', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ matches: false, score: 85, mismatches: ['couleur différente'] }));
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: VISUAL_DNA });

    expect(result.visualFidelity.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('vision renvoie un score bas : visualFidelity.passed=false', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ matches: true, score: 40, mismatches: ['forme différente'] }));
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: VISUAL_DNA });

    expect(result.visualFidelity.passed).toBe(false);
    expect(result.visualFidelity.score).toBe(40);
  });

  it('erreur ffmpeg (freezedetect) : résultat passed=false proprement renvoyé, jamais d\'exception levée', async () => {
    mockNextFailure.message = 'codec introuvable';
    const gateway = buildGatewayMock(JSON.stringify({ matches: true, score: 90, mismatches: [] }));
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: VISUAL_DNA });

    expect(result.passed).toBe(false);
    expect(result.qualityScore).toBe(0);
  });

  it('erreur analyzeImage (tous fournisseurs vision indisponibles) : résultat passed=false proprement renvoyé', async () => {
    const gateway = buildGatewayMock(new Error('tous les fournisseurs ont échoué'));
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: VISUAL_DNA });

    expect(result.passed).toBe(false);
  });

  it('réponse vision non conforme au JSON attendu : visualFidelity.passed=false, ne lève pas', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas comparer ces images.');
    const service = new VideoAnalyzerService(gateway);

    const result = await service.analyze(CTX, 'data:video/mp4;base64,ZmFrZQ==', { visualDna: VISUAL_DNA });

    expect(result.visualFidelity.passed).toBe(false);
  });
});

describe('Mission 4 Phase C — classifyMotionLevel (bandes nommées sur le score de mouvement déjà mesuré)', () => {
  it.each([
    [0, 'STATIC'],
    [19, 'STATIC'],
    [20, 'LOW'],
    [49, 'LOW'],
    [50, 'ADEQUATE'],
    [84, 'ADEQUATE'],
    [85, 'HIGH'],
    [94, 'HIGH'],
    [95, 'EXCESSIVE'],
    [100, 'EXCESSIVE'],
  ] as const)('score %i -> %s', (score, level) => {
    expect(classifyMotionLevel(score)).toBe(level);
  });

  it('borne les scores hors [0,100] plutôt que de planter', () => {
    expect(classifyMotionLevel(-10)).toBe('STATIC');
    expect(classifyMotionLevel(150)).toBe('EXCESSIVE');
  });
});
