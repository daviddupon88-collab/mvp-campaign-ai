const mockProbeResult: { err: any; data: any } = { err: null, data: null };

jest.mock('fluent-ffmpeg', () => {
  const fn = jest.fn();
  (fn as any).setFfmpegPath = jest.fn();
  (fn as any).setFfprobePath = jest.fn();
  (fn as any).ffprobe = jest.fn((_filePath: string, cb: (err: any, data: any) => void) => cb(mockProbeResult.err, mockProbeResult.data));
  return fn;
});

import { VideoQcService } from './video-qc.service';

describe('VideoQcService', () => {
  const service = new VideoQcService();

  beforeEach(() => {
    mockProbeResult.err = null;
    mockProbeResult.data = null;
  });

  it('fichier valide (durée cohérente, flux vidéo+audio présents) : passed = true, aucune raison', async () => {
    mockProbeResult.data = { format: { duration: 10.2 }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] };

    const result = await service.validate(Buffer.alloc(2048, 1), { expectedDurationSeconds: 10 });

    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.hasVideoStream).toBe(true);
    expect(result.hasAudioStream).toBe(true);
  });

  it("fichier anormalement petit : rejeté SANS même appeler ffprobe", async () => {
    const result = await service.validate(Buffer.alloc(10), { expectedDurationSeconds: 10 });

    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toContain('anormalement petit');
  });

  it('aucun flux audio détecté : rejeté avec la raison explicite', async () => {
    mockProbeResult.data = { format: { duration: 10 }, streams: [{ codec_type: 'video' }] };

    const result = await service.validate(Buffer.alloc(2048, 1), { expectedDurationSeconds: 10 });

    expect(result.passed).toBe(false);
    expect(result.hasAudioStream).toBe(false);
    expect(result.reasons.some((r) => r.includes('flux audio'))).toBe(true);
  });

  it('aucun flux vidéo détecté : rejeté avec la raison explicite', async () => {
    mockProbeResult.data = { format: { duration: 10 }, streams: [{ codec_type: 'audio' }] };

    const result = await service.validate(Buffer.alloc(2048, 1), { expectedDurationSeconds: 10 });

    expect(result.passed).toBe(false);
    expect(result.hasVideoStream).toBe(false);
  });

  it('durée trop éloignée de la durée attendue : rejeté, dans la tolérance : accepté', async () => {
    mockProbeResult.data = { format: { duration: 15 }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] };

    const tropLoin = await service.validate(Buffer.alloc(2048, 1), { expectedDurationSeconds: 10 });
    expect(tropLoin.passed).toBe(false);
    expect(tropLoin.reasons.some((r) => r.includes('Durée finale'))).toBe(true);

    mockProbeResult.data = { format: { duration: 10.3 }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] };
    const dansLaTolerance = await service.validate(Buffer.alloc(2048, 1), { expectedDurationSeconds: 10 });
    expect(dansLaTolerance.passed).toBe(true);
  });

  it('ffprobe échoue (fichier corrompu) : rejeté proprement, ne lève jamais d\'exception', async () => {
    mockProbeResult.err = new Error('Invalid data found when processing input');

    const result = await service.validate(Buffer.alloc(2048, 1), { expectedDurationSeconds: 10 });

    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toContain('ffprobe a échoué');
  });
});
