import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

export interface ConcatenatedVideo {
  buffer: Buffer;
  durationSeconds: number;
}

const HARD_TIMEOUT_MS = 120_000;

// Enchaîne plusieurs clips vidéo bruts en une seule séquence — utilisé pour obtenir une vidéo
// réellement dynamique (un plan généré par étape du script, cf. AiOrchestratorService) plutôt
// qu'un seul clip figé sur sa dernière image pendant le reste de la narration (cf.
// VideoAssemblyService, filtre tpad). Filtre `concat` (pas le démuxeur `-f concat`) : plus lent
// (ré-encodage systématique) mais tolère des clips de fournisseurs différents — résolution/codec
// non garantis identiques entre deux appels generateVideo, potentiellement deux fournisseurs
// différents si l'un a basculé sur un repli en cours de route (cf. AiGatewayService).
export async function concatenateVideoClips(clipBuffers: Buffer[]): Promise<ConcatenatedVideo> {
  if (clipBuffers.length === 0) throw new Error('concatenateVideoClips: aucun clip fourni');
  if (clipBuffers.length === 1) {
    return { buffer: clipBuffers[0], durationSeconds: await probeDurationFromBuffer(clipBuffers[0]) };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-concat-'));
  const outputPath = path.join(tmpDir, `${randomUUID()}.mp4`);

  try {
    const clipPaths = clipBuffers.map((buffer, index) => {
      const clipPath = path.join(tmpDir, `clip-${index}.mp4`);
      fs.writeFileSync(clipPath, buffer);
      return clipPath;
    });

    await runConcat(clipPaths, outputPath);

    const buffer = fs.readFileSync(outputPath);
    const durationSeconds = await probeDuration(outputPath);
    return { buffer, durationSeconds };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runConcat(clipPaths: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const command = ffmpeg();
    clipPaths.forEach((clipPath) => command.input(clipPath));

    // Vidéo uniquement (v=1:a=0) : aucun clip source n'a de piste audio à ce stade
    // (generateAudio:false côté Veo, Runway en image-to-video ne produit jamais de son) —
    // narration/musique sont mixées plus tard par VideoAssemblyService.assemble().
    const inputs = clipPaths.map((_, index) => `[${index}:v]`).join('');
    const filter = `${inputs}concat=n=${clipPaths.length}:v=1:a=0[vout]`;

    command
      .complexFilter([filter])
      .outputOptions(['-map', '[vout]', '-pix_fmt', 'yuv420p'])
      .videoCodec('libx264')
      .on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(new Error(`Échec de la concaténation vidéo (ffmpeg) : ${err.message}`));
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve();
      });

    // Même filet de sécurité que VideoAssemblyService.runFfmpeg — un process ffmpeg bloqué ne
    // doit jamais bloquer indéfiniment le worker BullMQ.
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      command.kill('SIGKILL');
      reject(new Error('Échec de la concaténation vidéo (ffmpeg) : délai dépassé, processus interrompu.'));
    }, HARD_TIMEOUT_MS);

    command.save(outputPath);
  });
}

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

async function probeDurationFromBuffer(buffer: Buffer): Promise<number> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-probe-'));
  const tmpPath = path.join(tmpDir, `${randomUUID()}.mp4`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    return await probeDuration(tmpPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
