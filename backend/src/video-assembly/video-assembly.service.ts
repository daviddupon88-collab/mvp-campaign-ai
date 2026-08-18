import { Injectable, Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

export interface AssembleParams {
  videoBuffer: Buffer;
  narrationBuffer: Buffer;
  musicBuffer: Buffer;
  srtContent: string | null; // null = pas de sous-titres à incruster (transcript indisponible)
}

export interface AssembleResult {
  buffer: Buffer;
  mimeType: 'video/mp4';
  durationSeconds: number;
}

// Coeur ffmpeg de l'assemblage : mixe narration + nappe musicale, incruste les sous-titres si
// disponibles, aligne la durée finale sur la narration (pas sur la vidéo brute — cf. commentaire
// dans AiOrchestratorService/README sur la vidéo Veo fixée à 8s vs un script pensé pour 15-30s
// à l'oral : la vidéo est gelée sur sa dernière image plutôt que tronquer la voix off).
@Injectable()
export class VideoAssemblyService {
  private readonly logger = new Logger(VideoAssemblyService.name);
  private static readonly HARD_TIMEOUT_MS = 120_000;

  async assemble(params: AssembleParams): Promise<AssembleResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-assembly-'));
    const videoPath = path.join(tmpDir, 'video.mp4');
    const narrationPath = path.join(tmpDir, 'narration.mp3');
    const musicPath = path.join(tmpDir, 'music.mp3');
    const outputPath = path.join(tmpDir, `${randomUUID()}.mp4`);

    try {
      fs.writeFileSync(videoPath, params.videoBuffer);
      fs.writeFileSync(narrationPath, params.narrationBuffer);
      fs.writeFileSync(musicPath, params.musicBuffer);

      // La narration fait AUTORITÉ pour la durée finale (décision produit, cf. plan) — pas la
      // vidéo brute Veo (fixe, 8s) ni le script (texte, pas un vrai minutage).
      const [videoDuration, narrationDuration] = await Promise.all([this.probeDuration(videoPath), this.probeDuration(narrationPath)]);
      const finalDuration = narrationDuration;
      const padSeconds = Math.max(0, finalDuration - videoDuration);

      let srtPath: string | null = null;
      if (params.srtContent) {
        srtPath = path.join(tmpDir, 'subtitles.srt');
        fs.writeFileSync(srtPath, params.srtContent, 'utf-8');
      }

      const filters: string[] = [];
      let videoLabel = '[0:v]';
      if (padSeconds > 0) {
        // clone = fige la dernière image plutôt que d'insérer du noir — le compromis visible
        // documenté dans le plan, gratuit, pas d'appel IA supplémentaire.
        filters.push(`${videoLabel}tpad=stop_mode=clone:stop_duration=${padSeconds}[padded]`);
        videoLabel = '[padded]';
      }
      if (srtPath) {
        // force_style calibré pour une sortie portrait 720×1280 (9:16, cf. RunwayProvider /
        // GoogleVeoProvider) — sans lui, libass retombe sur des styles par défaut non calibrés
        // à cette résolution, avec des marges/tailles de police qui laissent le texte déborder
        // du cadre sur les répliques longues (retour utilisateur du 2026-08-17). Complète le
        // découpage en lignes fait par SubtitleBuilderService.
        const subtitleStyle =
          'FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H99000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=80,MarginL=60,MarginR=60';
        filters.push(`${videoLabel}subtitles=filename='${this.escapeFilterPath(srtPath)}':force_style='${subtitleStyle}'[subtitled]`);
        videoLabel = '[subtitled]';
      }
      // `null` = filtre vidéo passthrough : garantit toujours un label [vout] stable à mapper en
      // sortie, que la vidéo ait été retouchée (pad/sous-titres) ou non.
      filters.push(`${videoLabel}null[vout]`);
      // duration=first : la narration (second input, index 1) est listée en premier dans amix
      // pour que ce soit SA durée qui fasse foi pour le mixage, cohérent avec finalDuration.
      // normalize=0 : le comportement par défaut d'amix (normalize=1) atténue TOUS les flux
      // d'environ -6dB dès qu'il y a 2 entrées, y compris la narration — alors que la nappe
      // musicale est déjà atténuée à la source (volume=0.12, cf. MusicBedService) précisément
      // pour rester sous la narration. Sans normalize=0, la narration subissait cette double
      // atténuation et ressortait perceptiblement trop faible (retour utilisateur du 2026-08-17).
      filters.push('[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixed]');
      // loudnorm (EBU R128) : même après normalize=0, le niveau NATIF de la narration TTS
      // (OpenAI) reste bas (~-25 LUFS mesuré en conditions réelles le 2026-08-17, perçu comme
      // "son pas fort" par l'utilisateur) — normalize=0 évite une atténuation EN TROP, mais ne
      // corrige pas un niveau de départ déjà faible. -16 LUFS : cible standard pour du contenu
      // mobile/réseaux sociaux (plus fort que le -23 LUFS broadcast TV, cohérent avec un usage
      // casque/haut-parleur de téléphone en environnement bruyant).
      filters.push('[amixed]loudnorm=I=-16:TP=-1.5:LRA=11[aout]');

      await this.runFfmpeg(videoPath, narrationPath, musicPath, filters, finalDuration, outputPath);

      const outputBuffer = fs.readFileSync(outputPath);
      return { buffer: outputBuffer, mimeType: 'video/mp4', durationSeconds: finalDuration };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private runFfmpeg(videoPath: string, narrationPath: string, musicPath: string, filters: string[], finalDuration: number, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const command = ffmpeg()
        .input(videoPath)
        .input(narrationPath)
        .input(musicPath)
        .complexFilter(filters)
        .outputOptions(['-map', '[vout]', '-map', '[aout]', '-t', String(finalDuration), '-pix_fmt', 'yuv420p'])
        .videoCodec('libx264')
        .audioCodec('aac')
        .on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          reject(new Error(`Échec de l'assemblage vidéo (ffmpeg) : ${err.message}`));
        })
        .on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          resolve();
        });

      // Filet de sécurité : un process ffmpeg qui reste bloqué (I/O, filtre pathologique) ne
      // doit jamais bloquer indéfiniment un worker BullMQ — cf. le même principe déjà appliqué
      // aux appels HTTP sortants via fetchWithTimeout.
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        command.kill('SIGKILL');
        reject(new Error("Échec de l'assemblage vidéo (ffmpeg) : délai dépassé, processus interrompu."));
      }, VideoAssemblyService.HARD_TIMEOUT_MS);

      command.save(outputPath);
    });
  }

  private probeDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) return reject(err);
        resolve(data.format.duration ?? 0);
      });
    });
  }

  // Le filtre `subtitles` de ffmpeg interprète `:` comme séparateur d'options — un chemin
  // Windows ("C:/Users/...") le fait échouer silencieusement sans cet échappement. Barres
  // obliques normalisées en plus (ffmpeg ne gère pas les `\` dans ce contexte).
  private escapeFilterPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/:/g, '\\:');
  }
}
