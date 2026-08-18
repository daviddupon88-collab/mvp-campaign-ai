import * as fs from 'fs';

// Même pattern de mock que VideoAssemblyService.spec.ts (module frère) : capture chaque
// commande ffmpeg factice créée pour inspecter les filtres construits après coup.
const mockCreatedCommands: any[] = [];
const mockProbeDurations: Record<string, number> = {};
const mockNextFailure = { message: null as string | null };
const mockFfprobeImpl = jest.fn((filePath: string, cb: (err: any, data: any) => void) => {
  const key = Object.keys(mockProbeDurations).find((k) => filePath.includes(k));
  cb(null, { format: { duration: key ? mockProbeDurations[key] : 5 }, streams: [] });
});

jest.mock('fluent-ffmpeg', () => {
  const fn = jest.fn(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const command: any = {
      input: jest.fn(() => command),
      complexFilter: jest.fn((filters: string[]) => {
        command.__filters = filters;
        return command;
      }),
      outputOptions: jest.fn((opts: string[]) => {
        command.__outputOptions = opts;
        return command;
      }),
      videoCodec: jest.fn(() => command),
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
        fs.writeFileSync(outputPath, Buffer.from('fake-concatenated-mp4'));
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

import { concatenateVideoClips } from './concatenate-video-clips';

describe('concatenateVideoClips', () => {
  beforeEach(() => {
    mockCreatedCommands.length = 0;
    Object.keys(mockProbeDurations).forEach((k) => delete mockProbeDurations[k]);
    mockFfprobeImpl.mockClear();
  });

  it('un seul clip : le renvoie tel quel, aucun appel ffmpeg de concaténation', async () => {
    const clip = Buffer.from('clip-unique');

    const result = await concatenateVideoClips([clip]);

    expect(result.buffer).toBe(clip);
    expect(mockCreatedCommands.length).toBe(0);
  });

  it('plusieurs clips : construit un filtre concat avec un input par clip, dans l\'ordre', async () => {
    const clips = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    mockProbeDurations['clip-0'] = 5;

    await concatenateVideoClips(clips);

    const command = mockCreatedCommands[0];
    expect(command.input).toHaveBeenCalledTimes(3);
    expect(command.__filters[0]).toBe('[0:v][1:v][2:v]concat=n=3:v=1:a=0[vout]');
    expect(command.__outputOptions).toEqual(expect.arrayContaining(['-map', '[vout]']));
  });

  it('renvoie le buffer réellement produit par ffmpeg et sa durée mesurée', async () => {
    const clips = [Buffer.from('a'), Buffer.from('b')];
    mockProbeDurations['clip-0'] = 5;
    // La durée finale est celle du fichier de SORTIE (probée après écriture), pas la somme
    // arithmétique des durées d'entrée — mockFfprobeImpl renvoie 5 par défaut faute de clé
    // correspondant au chemin de sortie (UUID aléatoire).

    const result = await concatenateVideoClips(clips);

    expect(result.buffer.toString()).toBe('fake-concatenated-mp4');
    expect(result.durationSeconds).toBe(5);
  });

  it('échec ffmpeg : rejette avec un message explicite', async () => {
    mockNextFailure.message = 'filtre concat incompatible';

    await expect(concatenateVideoClips([Buffer.from('a'), Buffer.from('b')])).rejects.toThrow(/concaténation vidéo.*filtre concat incompatible/);
  });

  it('aucun clip : rejette immédiatement sans invoquer ffmpeg', async () => {
    await expect(concatenateVideoClips([])).rejects.toThrow(/aucun clip fourni/);
    expect(mockCreatedCommands.length).toBe(0);
  });
});
