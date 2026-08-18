import * as fs from 'fs';
import * as path from 'path';

// Convention Jest : les variables référencées dans une factory jest.mock() (hoistée au-dessus
// des imports) doivent être préfixées "mock" — cf. babel-plugin-jest-hoist. Ce tableau capture
// chaque commande ffmpeg factice créée, pour que les tests puissent en inspecter les appels
// après coup (filtres construits, chemin de sortie, etc.).
const mockCreatedCommands: any[] = [];
const mockProbeDurations: Record<string, number> = {};
// Contrôlé par les tests d'échec : quand non-null, la PROCHAINE commande créée déclenche
// 'error' avec ce message au lieu d'écrire un fichier de sortie et déclencher 'end'.
const mockNextFailure = { message: null as string | null };
const mockFfprobeImpl = jest.fn((filePath: string, cb: (err: any, data: any) => void) => {
  const key = Object.keys(mockProbeDurations).find((k) => filePath.includes(k));
  cb(null, { format: { duration: key ? mockProbeDurations[key] : 8 }, streams: [] });
});

jest.mock('fluent-ffmpeg', () => {
  const fn = jest.fn(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const command: any = {
      input: jest.fn(() => command),
      inputFormat: jest.fn(() => command),
      complexFilter: jest.fn((filters: string[]) => {
        command.__filters = filters;
        return command;
      }),
      outputOptions: jest.fn((opts: string[]) => {
        command.__outputOptions = opts;
        return command;
      }),
      videoCodec: jest.fn(() => command),
      audioCodec: jest.fn(() => command),
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
        fs.writeFileSync(outputPath, Buffer.from('fake-mp4-bytes'));
        setImmediate(() => handlers.end?.());
      }),
      kill: jest.fn(),
    };
    mockCreatedCommands.push(command);
    return command;
  });
  (fn as any).setFfmpegPath = jest.fn();
  (fn as any).setFfprobePath = jest.fn();
  (fn as any).ffprobe = mockFfprobeImpl;
  return fn;
});

import { VideoAssemblyService } from './video-assembly.service';

describe('VideoAssemblyService', () => {
  beforeEach(() => {
    mockCreatedCommands.length = 0;
    Object.keys(mockProbeDurations).forEach((k) => delete mockProbeDurations[k]);
    mockFfprobeImpl.mockClear();
  });

  function buildParams(overrides: Partial<Parameters<VideoAssemblyService['assemble']>[0]> = {}) {
    return {
      videoBuffer: Buffer.from('fake-video'),
      narrationBuffer: Buffer.from('fake-narration'),
      musicBuffer: Buffer.from('fake-music'),
      srtContent: null,
      ...overrides,
    };
  }

  it("assemble un fichier avec succès : mixe narration+musique, mappe [vout]/[aout], nettoie le dossier temporaire", async () => {
    mockProbeDurations['video.mp4'] = 8;
    mockProbeDurations['narration.mp3'] = 8; // même durée -> pas de pad
    const service = new VideoAssemblyService();

    const result = await service.assemble(buildParams());

    expect(result.mimeType).toBe('video/mp4');
    expect(result.durationSeconds).toBe(8);
    expect(result.buffer.toString()).toBe('fake-mp4-bytes');

    const command = mockCreatedCommands[0];
    expect(command.__outputOptions).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '[aout]', '-t', '8']));
    expect(command.__filters.some((f: string) => f.includes('amix=inputs=2:duration=first'))).toBe(true);
    // normalize=0 : sans lui, amix atténue la narration d'environ -6dB en plus de la nappe
    // musicale déjà atténuée à la source — cf. commentaire dans video-assembly.service.ts.
    expect(command.__filters.some((f: string) => f.includes('normalize=0'))).toBe(true);
    // loudnorm : normalize=0 évite une atténuation en trop mais ne corrige pas un niveau natif
    // déjà faible côté TTS (~-25 LUFS mesuré en conditions réelles) — cf. commentaire dans
    // video-assembly.service.ts.
    expect(command.__filters.some((f: string) => f.includes('loudnorm=I=-16'))).toBe(true);
    // Dossier temporaire supprimé après coup — le fichier de sortie factice ne doit plus exister.
    expect(fs.existsSync(command.__outputPath)).toBe(false);
  });

  it('vidéo plus courte que la narration : ajoute un filtre tpad (gel de la dernière image), aucun sans cela', async () => {
    mockProbeDurations['video.mp4'] = 8;
    mockProbeDurations['narration.mp3'] = 20;
    const service = new VideoAssemblyService();

    const result = await service.assemble(buildParams());

    expect(result.durationSeconds).toBe(20); // la narration fait autorité
    const command = mockCreatedCommands[0];
    expect(command.__filters.some((f: string) => f.includes('tpad=stop_mode=clone:stop_duration=12'))).toBe(true);
  });

  it('vidéo au moins aussi longue que la narration : aucun filtre tpad ajouté', async () => {
    mockProbeDurations['video.mp4'] = 10;
    mockProbeDurations['narration.mp3'] = 8;
    const service = new VideoAssemblyService();

    await service.assemble(buildParams());

    const command = mockCreatedCommands[0];
    expect(command.__filters.some((f: string) => f.includes('tpad'))).toBe(false);
  });

  it('avec un transcript (srtContent fourni) : incruste les sous-titres via le filtre subtitles', async () => {
    mockProbeDurations['video.mp4'] = 8;
    mockProbeDurations['narration.mp3'] = 8;
    const service = new VideoAssemblyService();

    await service.assemble(buildParams({ srtContent: '1\n00:00:00,000 --> 00:00:01,000\nSalut' }));

    const command = mockCreatedCommands[0];
    expect(command.__filters.some((f: string) => f.includes('subtitles=filename='))).toBe(true);
    // force_style : calibre taille de police/marges/alignement pour la résolution portrait
    // 720×1280 — sans lui, libass utilise des valeurs par défaut non calibrées à cette taille.
    expect(command.__filters.some((f: string) => f.includes("force_style='"))).toBe(true);
  });

  it('sans transcript (srtContent null) : aucun filtre subtitles ajouté', async () => {
    mockProbeDurations['video.mp4'] = 8;
    mockProbeDurations['narration.mp3'] = 8;
    const service = new VideoAssemblyService();

    await service.assemble(buildParams({ srtContent: null }));

    const command = mockCreatedCommands[0];
    expect(command.__filters.some((f: string) => f.includes('subtitles'))).toBe(false);
  });

  it('échec ffmpeg (événement error) : rejette avec un message explicite, nettoie tout de même le dossier temporaire', async () => {
    mockProbeDurations['video.mp4'] = 8;
    mockProbeDurations['narration.mp3'] = 8;
    mockNextFailure.message = 'codec introuvable';
    const service = new VideoAssemblyService();

    await expect(service.assemble(buildParams())).rejects.toThrow(/assemblage vidéo.*codec introuvable/);

    // Le dossier temporaire (contenant video.mp4/narration.mp3/music.mp3 écrits avant l'échec)
    // doit être nettoyé même sur ce chemin d'erreur — vérifié via le chemin de sortie prévu,
    // dont le dossier parent ne doit plus exister.
    const command = mockCreatedCommands[mockCreatedCommands.length - 1];
    expect(fs.existsSync(path.dirname(command.__outputPath))).toBe(false);
  });
});
