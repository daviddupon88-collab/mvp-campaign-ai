import { Injectable, Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

// Nappe sonore de fond synthétisée PROCÉDURALEMENT (sources `lavfi`, pas un fichier musical) —
// décision produit explicite : aucun fournisseur de musique/SFX n'est intégré (ni compte, ni
// clé, ni risque de facturation), et une vraie musique trouvée "à la main" par un assistant de
// code exposerait le client à un risque de droit d'auteur inacceptable. Qualité modeste assumée
// en échange d'une disponibilité totale et d'un coût nul. `synthesize()` retourne un Buffer —
// exactement le contrat qu'aurait un vrai fournisseur (octets déjà prêts) — pour que ce service
// soit le SEUL point à remplacer le jour où un vrai fournisseur musique est ajouté.
@Injectable()
export class MusicBedService {
  private readonly logger = new Logger(MusicBedService.name);

  async synthesize(durationSeconds: number): Promise<Buffer> {
    const duration = Math.max(1, durationSeconds);
    const fadeDuration = Math.min(1.5, duration / 4);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-music-'));
    const outputPath = path.join(tmpDir, `${randomUUID()}.mp3`);

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(`sine=frequency=220:duration=${duration}`)
          .inputFormat('lavfi')
          .input(`sine=frequency=330:duration=${duration}`)
          .inputFormat('lavfi')
          .complexFilter(
            [
              // Deux tons purs (220Hz/A3 + 330Hz/quinte) mixés en une nappe simple, atténuée
              // pour rester nettement sous la narration (jamais un vrai morceau, juste un fond).
              '[0:a][1:a]amix=inputs=2:duration=longest[mixed]',
              `[mixed]afade=t=in:st=0:d=${fadeDuration},afade=t=out:st=${Math.max(0, duration - fadeDuration)}:d=${fadeDuration},volume=0.12[bed]`,
            ],
            ['bed'],
          )
          .outputOptions(['-t', String(duration)])
          .audioCodec('libmp3lame')
          .on('error', (err) => reject(new Error(`Échec de la synthèse de la nappe musicale (ffmpeg) : ${err.message}`)))
          .on('end', () => resolve())
          .save(outputPath);
      });

      return fs.readFileSync(outputPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
