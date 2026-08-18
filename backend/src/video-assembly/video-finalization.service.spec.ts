// Mock du module de concaténation ffmpeg (couvert par son propre spec, cf.
// common/media/concatenate-video-clips.spec.ts) — ce fichier vérifie seulement que
// VideoFinalizationService.concatenateClips() résout bien chaque clip puis délègue à cette
// fonction, pas le comportement ffmpeg lui-même.
const mockConcatenateVideoClips = jest.fn();
jest.mock('../common/media/concatenate-video-clips', () => ({
  concatenateVideoClips: (...args: unknown[]) => mockConcatenateVideoClips(...args),
}));

import { VideoFinalizationService } from './video-finalization.service';

function buildService(overrides?: {
  fetchImpl?: jest.Mock;
  buildSrt?: jest.Mock;
  synthesize?: jest.Mock;
  assemble?: jest.Mock;
  validate?: jest.Mock;
}) {
  const subtitleBuilder = { buildSrt: overrides?.buildSrt ?? jest.fn().mockReturnValue('1\n00:00:00,000 --> 00:00:01,000\nSalut') } as any;
  const musicBed = { synthesize: overrides?.synthesize ?? jest.fn().mockResolvedValue(Buffer.from('music')) } as any;
  const videoAssembly = {
    assemble: overrides?.assemble ?? jest.fn().mockResolvedValue({ buffer: Buffer.from('final-video'), mimeType: 'video/mp4', durationSeconds: 12 }),
  } as any;
  const videoQc = { validate: overrides?.validate ?? jest.fn().mockResolvedValue({ passed: true, reasons: [] }) } as any;

  global.fetch = overrides?.fetchImpl ?? (jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.from('raw-video').buffer }) as any);

  const service = new VideoFinalizationService(subtitleBuilder, musicBed, videoAssembly, videoQc);
  return { service, subtitleBuilder, musicBed, videoAssembly, videoQc };
}

const NARRATION_DATA_URI = `data:audio/mpeg;base64,${Buffer.from('fake-audio').toString('base64')}`;

describe('VideoFinalizationService', () => {
  it('narration = simple URL (mode mock, pas un data URI réel) : status "skipped", aucun appel à l\'assemblage', async () => {
    const { service, videoAssembly } = buildService();

    const result = await service.finalize({
      rawVideoUrl: 'https://example.com/video.mp4',
      narrationDataUri: 'https://example.com/mock-narration.mp3',
      transcript: null,
    });

    expect(result).toEqual({ status: 'skipped', reason: expect.stringContaining('mode mock') });
    expect(videoAssembly.assemble).not.toHaveBeenCalled();
  });

  it('narration réelle (data URI) + transcript : construit le SRT, synthétise la musique, assemble, valide QC', async () => {
    const { service, subtitleBuilder, musicBed, videoAssembly, videoQc } = buildService();
    const transcript = [{ start: 0, end: 1, text: 'Salut' }];

    const result = await service.finalize({
      rawVideoUrl: 'https://example.com/video.mp4',
      narrationDataUri: NARRATION_DATA_URI,
      transcript,
    });

    expect(result.status).toBe('assembled');
    expect(subtitleBuilder.buildSrt).toHaveBeenCalledWith(transcript);
    expect(musicBed.synthesize).toHaveBeenCalledWith(35);
    expect(videoAssembly.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ srtContent: '1\n00:00:00,000 --> 00:00:01,000\nSalut' }),
    );
    expect(videoQc.validate).toHaveBeenCalledWith(Buffer.from('final-video'), { expectedDurationSeconds: 12 });
  });

  it('sans transcript : assemble quand même, avec srtContent=null (pas de sous-titres, pas une erreur)', async () => {
    const { service, subtitleBuilder, videoAssembly } = buildService();

    const result = await service.finalize({ rawVideoUrl: 'https://example.com/video.mp4', narrationDataUri: NARRATION_DATA_URI, transcript: null });

    expect(result.status).toBe('assembled');
    expect(subtitleBuilder.buildSrt).not.toHaveBeenCalled();
    expect(videoAssembly.assemble).toHaveBeenCalledWith(expect.objectContaining({ srtContent: null }));
  });

  it('échec du téléchargement de la vidéo brute : lève une exception explicite', async () => {
    const { service } = buildService({ fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 404 }) });

    // Message générique de resolveMediaBuffer() (utilitaire partagé avec la concaténation
    // multi-plans, cf. AiOrchestratorService) — plus le message dédié "vidéo brute" d'avant
    // cette factorisation, mais le comportement (rejet explicite avec le code HTTP) est inchangé.
    await expect(
      service.finalize({ rawVideoUrl: 'https://example.com/video.mp4', narrationDataUri: NARRATION_DATA_URI, transcript: null }),
    ).rejects.toThrow(/récupérer le média.*404/);
  });

  it('échec du contrôle qualité : lève une exception listant les raisons, ne renvoie jamais "assembled"', async () => {
    const { service } = buildService({
      validate: jest.fn().mockResolvedValue({ passed: false, reasons: ['Aucun flux audio détecté'] }),
    });

    await expect(
      service.finalize({ rawVideoUrl: 'https://example.com/video.mp4', narrationDataUri: NARRATION_DATA_URI, transcript: null }),
    ).rejects.toThrow(/contrôle qualité.*Aucun flux audio détecté/);
  });
});

// Utilisé par AiOrchestratorService.generateMultiShotVideoOrDegrade pour obtenir une vidéo
// dynamique (un clip par plan du script) plutôt qu'un clip unique figé — cf. le correctif du
// 2026-08-16.
describe('VideoFinalizationService.concatenateClips', () => {
  beforeEach(() => {
    mockConcatenateVideoClips.mockReset();
  });

  it('résout chaque clip (data URI ou URL) avant de les passer à concatenateVideoClips, dans l\'ordre', async () => {
    mockConcatenateVideoClips.mockResolvedValue({ buffer: Buffer.from('combined'), durationSeconds: 15 });
    // new Uint8Array(urlBytes).buffer, pas urlBytes.buffer : Buffer.from(string) alloue
    // souvent depuis le pool interne de Node (mémoire partagée avec d'autres buffers créés
    // entre-temps) — .buffer expose ce pool entier, dont le contenu peut changer avant
    // l'exécution asynchrone de arrayBuffer(). new Uint8Array(...) sur un TypedArray COPIE les
    // valeurs dans un ArrayBuffer neuf et indépendant, immunisé contre cette réutilisation.
    const urlBytes = Buffer.from('clip-url');
    const clipDataUri = `data:video/mp4;base64,${Buffer.from('clip-data-uri').toString('base64')}`;
    // fetchImpl EN PASSANT PAR buildService(), pas en assignant global.fetch avant : buildService()
    // écrase inconditionnellement global.fetch avec son propre mock par défaut si aucun
    // fetchImpl n'est fourni — un global.fetch défini juste avant l'appel serait sinon
    // silencieusement remplacé (bug constaté ici même, à corriger une fois pour ne pas le
    // reproduire dans un futur test de ce fichier).
    const { service } = buildService({
      fetchImpl: jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array(urlBytes).buffer }),
    });

    await service.concatenateClips([clipDataUri, 'https://example.com/clip.mp4']);

    const [resolvedBuffers] = mockConcatenateVideoClips.mock.calls[0];
    expect(resolvedBuffers).toEqual([Buffer.from('clip-data-uri'), Buffer.from('clip-url')]);
  });

  it('renvoie le résultat combiné encodé en data URI', async () => {
    mockConcatenateVideoClips.mockResolvedValue({ buffer: Buffer.from('combined-bytes'), durationSeconds: 15 });
    const { service } = buildService();
    const clipDataUri = `data:video/mp4;base64,${Buffer.from('clip').toString('base64')}`;

    const result = await service.concatenateClips([clipDataUri, clipDataUri]);

    expect(result).toBe(`data:video/mp4;base64,${Buffer.from('combined-bytes').toString('base64')}`);
  });
});
