import { Injectable, Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeStatic from 'ffprobe-static';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

export interface VideoQcResult {
  passed: boolean;
  reasons: string[];
  durationSeconds: number;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  fileSizeBytes: number;
}

// Contrôle qualité PUREMENT TECHNIQUE (ffprobe — déterministe) sur le fichier final assemblé :
// intégrité du fichier, présence des deux flux, durée cohérente. Volontairement distinct de
// ModerationService/BrandConsistencyService (jugement sémantique via LLM) — un fichier vidéo
// corrompu ou muet n'est pas un problème de contenu, c'est un problème technique, jamais détecté
// par une vérification à base de prompt.
@Injectable()
export class VideoQcService {
  private readonly logger = new Logger(VideoQcService.name);
  private static readonly DURATION_TOLERANCE_SECONDS = 1.5;
  private static readonly MIN_FILE_SIZE_BYTES = 1024; // en dessous, quasi certainement un fichier vide/corrompu

  async validate(buffer: Buffer, context: { expectedDurationSeconds: number }): Promise<VideoQcResult> {
    const reasons: string[] = [];
    const fileSizeBytes = buffer.length;

    if (fileSizeBytes < VideoQcService.MIN_FILE_SIZE_BYTES) {
      reasons.push(`Fichier anormalement petit (${fileSizeBytes} octets)`);
      return { passed: false, reasons, durationSeconds: 0, hasVideoStream: false, hasAudioStream: false, fileSizeBytes };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-qc-'));
    const tmpPath = path.join(tmpDir, `${randomUUID()}.mp4`);

    try {
      fs.writeFileSync(tmpPath, buffer);

      const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
        ffmpeg.ffprobe(tmpPath, (err, data) => (err ? reject(err) : resolve(data)));
      });

      const durationSeconds = metadata.format.duration ?? 0;
      const hasVideoStream = metadata.streams.some((s) => s.codec_type === 'video');
      const hasAudioStream = metadata.streams.some((s) => s.codec_type === 'audio');

      if (durationSeconds <= 0) reasons.push('Durée nulle ou invalide');
      if (!hasVideoStream) reasons.push('Aucun flux vidéo détecté');
      if (!hasAudioStream) reasons.push('Aucun flux audio détecté');

      const durationDelta = Math.abs(durationSeconds - context.expectedDurationSeconds);
      if (durationDelta > VideoQcService.DURATION_TOLERANCE_SECONDS) {
        reasons.push(`Durée finale (${durationSeconds.toFixed(1)}s) trop éloignée de la durée attendue (${context.expectedDurationSeconds.toFixed(1)}s)`);
      }

      return { passed: reasons.length === 0, reasons, durationSeconds, hasVideoStream, hasAudioStream, fileSizeBytes };
    } catch (error) {
      this.logger.error(`Échec de la vérification QC (ffprobe) : ${error}`);
      return { passed: false, reasons: [`ffprobe a échoué : ${error}`], durationSeconds: 0, hasVideoStream: false, hasAudioStream: false, fileSizeBytes };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
