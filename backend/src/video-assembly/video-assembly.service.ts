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

interface VideoStreamInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

// Coeur ffmpeg de l'assemblage : mixe narration + nappe musicale, incruste les sous-titres si
// disponibles, aligne la durée finale sur la narration (pas sur la vidéo brute — cf. commentaire
// dans AiOrchestratorService/README sur la vidéo Veo fixée à 8s vs un script pensé pour 15-30s
// à l'oral : le temps en trop est comblé par un lent zoom avant (Ken Burns) sur la dernière
// image plutôt que tronquer la voix off).
@Injectable()
export class VideoAssemblyService {
  private readonly logger = new Logger(VideoAssemblyService.name);
  private static readonly HARD_TIMEOUT_MS = 120_000;

  // Portrait 720×1280 @ 24fps : repli utilisé UNIQUEMENT si ffprobe ne renvoie aucun flux
  // vidéo exploitable (ne devrait jamais arriver en pratique pour un clip Veo/Runway réel,
  // cf. force_style dans le filtre subtitles ci-dessous, calibré sur cette même résolution) —
  // filet de sécurité plutôt qu'un plantage de l'assemblage pour une valeur de confort.
  private static readonly FALLBACK_WIDTH = 720;
  private static readonly FALLBACK_HEIGHT = 1280;
  private static readonly FALLBACK_FPS = 24;
  // Zoom avant progressif et discret (+8% max) sur la portion gelée — remplace le gel
  // totalement statique (retour utilisateur du 2026-08-18 : la vidéo "n'a pas de caractère",
  // près de la moitié de la pub pouvait être une image figée sans aucun mouvement). Valeurs
  // calibrées visuellement (cf. test manuel _tmp-verify du 2026-08-18) pour rester perceptible
  // sans être un zoom agressif façon caméra qui se précipite.
  private static readonly KEN_BURNS_ZOOM_STEP = 0.0012;
  private static readonly KEN_BURNS_ZOOM_MAX = 1.08;

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
      const [videoInfo, narrationDuration] = await Promise.all([this.probeVideoInfo(videoPath), this.probeDuration(narrationPath)]);
      const videoDuration = videoInfo.duration;
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
        filters.push(...this.buildKenBurnsPadFilters(videoDuration, padSeconds, videoInfo));
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
      // Ducking audio (P0.8, chantier "Creative Intelligence Engine & Video Quality Loop",
      // 2026-08-18) : avant ce chantier, la musique n'était atténuée QUE de façon statique à la
      // source (volume=0.12, cf. MusicBedService) — un niveau fixe, jamais réellement adapté à
      // la présence de voix. asplit clone la narration en deux flux identiques : l'un reste
      // intact pour le mixage final ([narr_main]), l'autre sert de SIGNAL DÉCLENCHEUR
      // ([narr_sc]) à sidechaincompress, qui comprime la musique UNIQUEMENT quand ce signal est
      // présent — la voix elle-même n'est jamais touchée, seule la musique cède sous elle.
      // threshold=0.05 (sensible : la nappe étant déjà discrète, une narration même modérée doit
      // suffire à déclencher la réduction), ratio=8 (compression marquée, perceptible),
      // attack=5ms/release=300ms (réaction quasi instantanée à la voix, remontée douce après —
      // évite un "pompage" audible entre les mots). Chaîne en aval (amix normalize=0, loudnorm)
      // strictement inchangée — cf. commentaires ci-dessous, déjà validés et testés.
      filters.push('[1:a]asplit=2[narr_main][narr_sc]');
      filters.push('[2:a][narr_sc]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[music_ducked]');
      // duration=first : la narration (toujours en 1er dans amix) fait foi pour le mixage,
      // cohérent avec finalDuration. normalize=0 : le comportement par défaut d'amix
      // (normalize=1) atténue TOUS les flux d'environ -6dB dès qu'il y a 2 entrées, y compris la
      // narration — sans lui, la narration subissait cette double atténuation et ressortait
      // perceptiblement trop faible (retour utilisateur du 2026-08-17). Le ducking ci-dessus
      // réduit déjà la musique pendant la voix ; normalize=0 reste nécessaire pour ne pas
      // ATTÉNUER LA NARRATION ELLE-MÊME en plus.
      filters.push('[narr_main][music_ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixed]');
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

  private probeVideoInfo(filePath: string): Promise<VideoStreamInfo> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) return reject(err);
        const videoStream = data.streams?.find((s: { codec_type?: string }) => s.codec_type === 'video');
        // r_frame_rate arrive au format "24/1" (fraction), pas un nombre — Number("24/1")
        // vaudrait NaN, d'où le parsing manuel du numérateur/dénominateur.
        const fps = this.parseFrameRate(videoStream?.r_frame_rate) ?? VideoAssemblyService.FALLBACK_FPS;
        resolve({
          duration: data.format.duration ?? 0,
          width: videoStream?.width ?? VideoAssemblyService.FALLBACK_WIDTH,
          height: videoStream?.height ?? VideoAssemblyService.FALLBACK_HEIGHT,
          fps,
        });
      });
    });
  }

  private parseFrameRate(rFrameRate: string | undefined): number | null {
    if (!rFrameRate) return null;
    const [num, den] = rFrameRate.split('/').map(Number);
    if (!num || !den) return null;
    return num / den;
  }

  // Comble le temps en trop (narration plus longue que le clip Veo/Runway, fixé à quelques
  // secondes) par un lent zoom avant sur la dernière image plutôt qu'un gel totalement
  // statique (cf. commentaire de classe + retour utilisateur du 2026-08-18). Isolé dans sa
  // propre méthode pour rester testable indépendamment du reste de la construction du filtre.
  private buildKenBurnsPadFilters(videoDuration: number, padSeconds: number, videoInfo: VideoStreamInfo): string[] {
    const { width, height, fps } = videoInfo;
    const frameDuration = 1 / fps;
    // Point de départ du trim = juste avant la toute dernière image — une fenêtre de 2 frames
    // (pas 1) donne une marge de sécurité contre l'arrondi flottant de `videoDuration` (mesuré
    // par ffprobe) sans changer le résultat perçu : zoompan tient de toute façon la MÊME image
    // gelée pendant toute la durée du pad, qu'on lui fournisse 1 ou 2 frames sources.
    const lastFrameStart = Math.max(0, videoDuration - frameDuration);
    const padFrameCount = Math.max(1, Math.round(padSeconds * fps));

    return [
      `[0:v]trim=start=0:duration=${videoDuration},setpts=PTS-STARTPTS[kbmain]`,
      `[0:v]trim=start=${lastFrameStart}:duration=${frameDuration * 2},setpts=PTS-STARTPTS[kblast]`,
      // scale ×2 avant zoompan : réduit le flou/les artefacts de recadrage que zoompan produit
      // sur une image figée agrandie directement à sa résolution native (technique standard du
      // filtre, validée visuellement en conditions réelles le 2026-08-18).
      `[kblast]scale=${width * 2}:${height * 2},zoompan=z='min(zoom+${VideoAssemblyService.KEN_BURNS_ZOOM_STEP},${VideoAssemblyService.KEN_BURNS_ZOOM_MAX})':d=${padFrameCount}:s=${width}x${height}:fps=${fps}[kbtail]`,
      '[kbmain][kbtail]concat=n=2:v=1:a=0[padded]',
    ];
  }

  // Le filtre `subtitles` de ffmpeg interprète `:` comme séparateur d'options — un chemin
  // Windows ("C:/Users/...") le fait échouer silencieusement sans cet échappement. Barres
  // obliques normalisées en plus (ffmpeg ne gère pas les `\` dans ce contexte).
  private escapeFilterPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/:/g, '\\:');
  }
}
