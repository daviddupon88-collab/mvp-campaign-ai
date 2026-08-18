import * as fs from 'fs';

const mockCreatedCommands: any[] = [];

jest.mock('fluent-ffmpeg', () => {
  const fn = jest.fn(() => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const command: any = {
      input: jest.fn(() => command),
      inputFormat: jest.fn(() => command),
      complexFilter: jest.fn((filters: string[], map?: string[]) => {
        command.__filters = filters;
        command.__map = map;
        return command;
      }),
      outputOptions: jest.fn((opts: string[]) => {
        command.__outputOptions = opts;
        return command;
      }),
      audioCodec: jest.fn(() => command),
      on: jest.fn((event: string, cb: (...args: any[]) => void) => {
        handlers[event] = cb;
        return command;
      }),
      save: jest.fn((outputPath: string) => {
        command.__outputPath = outputPath;
        fs.writeFileSync(outputPath, Buffer.from('fake-mp3-bytes'));
        setImmediate(() => handlers.end?.());
      }),
    };
    mockCreatedCommands.push(command);
    return command;
  });
  (fn as any).setFfmpegPath = jest.fn();
  (fn as any).setFfprobePath = jest.fn();
  return fn;
});

import { MusicBedService } from './music-bed.service';

describe('MusicBedService', () => {
  beforeEach(() => {
    mockCreatedCommands.length = 0;
  });

  it('synthétise une nappe sonore : deux sources lavfi mixées, fondu entrée/sortie, volume atténué', async () => {
    const service = new MusicBedService();

    const buffer = await service.synthesize(10);

    expect(buffer.toString()).toBe('fake-mp3-bytes');
    const command = mockCreatedCommands[0];
    expect(command.input).toHaveBeenCalledWith(expect.stringContaining('sine=frequency=220:duration=10'));
    expect(command.input).toHaveBeenCalledWith(expect.stringContaining('sine=frequency=330:duration=10'));
    expect(command.__filters.some((f: string) => f.includes('amix=inputs=2'))).toBe(true);
    expect(command.__filters.some((f: string) => f.includes('volume=0.12'))).toBe(true);
  });

  it('nettoie le dossier temporaire après génération — le fichier de sortie ne survit pas à l\'appel', async () => {
    const service = new MusicBedService();

    await service.synthesize(10);

    const command = mockCreatedCommands[0];
    expect(fs.existsSync(command.__outputPath)).toBe(false);
  });

  it('durée minimale d\'une seconde même si un appelant demande moins (0 ou négatif)', async () => {
    const service = new MusicBedService();

    await service.synthesize(0);

    const command = mockCreatedCommands[0];
    expect(command.input).toHaveBeenCalledWith(expect.stringContaining('duration=1'));
  });
});
