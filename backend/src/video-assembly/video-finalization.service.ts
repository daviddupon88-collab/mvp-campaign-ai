import { Injectable, Logger } from '@nestjs/common';
import { resolveMediaBuffer } from '../common/http/resolve-media-buffer';
import { concatenateVideoClips } from '../common/media/concatenate-video-clips';
import { TranscriptSegment } from '../ai/ai-gateway/providers/ai-provider.interface';
import { SubtitleBuilderService } from './subtitle-builder.service';
import { MusicBedService } from './music-bed.service';
import { VideoAssemblyService } from './video-assembly.service';
import { VideoQcService } from './video-qc.service';

export interface FinalizeParams {
  rawVideoUrl: string;
  narrationDataUri: string;
  transcript: TranscriptSegment[] | null;
}

export type FinalizeResult =
  | { status: 'assembled'; buffer: Buffer; mimeType: 'video/mp4'; durationSeconds: number }
  | { status: 'skipped'; reason: string };

// Coordinateur du module — ne fait aucun traitement lui-même, délègue à chaque service
// spécialisé. Décode la narration en Buffer ; si ce n'est pas un vrai data URI (mode mock,
// MockProvider.generateAudio renvoie une simple URL factice, pas de l'audio réel), dégrade
// proprement plutôt que d'échouer — rien de réel à assembler dans ce cas, même philosophie que
// le reste du pipeline en mode mock (generateVideoOrDegrade, uploadFromUrl -> null).
@Injectable()
export class VideoFinalizationService {
  private readonly logger = new Logger(VideoFinalizationService.name);
  // Le script TikTok source demande "15 à 30 secondes à l'oral" (cf. AiOrchestratorService,
  // buildChannelPrompt, cas 'tiktok') — 35s de marge pour la nappe musicale synthétisée ; la
  // durée finale réelle reste bornée par la narration effective, retrouvée précisément par
  // VideoAssemblyService via ffprobe, pas par cette constante.
  private static readonly MUSIC_BED_MAX_SECONDS = 35;

  constructor(
    private readonly subtitleBuilder: SubtitleBuilderService,
    private readonly musicBed: MusicBedService,
    private readonly videoAssembly: VideoAssemblyService,
    private readonly videoQc: VideoQcService,
  ) {}

  async finalize(params: FinalizeParams): Promise<FinalizeResult> {
    const narrationMatch = /^data:(.+?);base64,(.+)$/.exec(params.narrationDataUri);
    if (!narrationMatch) {
      return { status: 'skipped', reason: 'Narration non disponible sous forme de média réel (mode mock ou fournisseur alternatif).' };
    }
    const [, , narrationBase64] = narrationMatch;
    const narrationBuffer = Buffer.from(narrationBase64, 'base64');

    const videoBuffer = await resolveMediaBuffer(params.rawVideoUrl);

    const [musicBuffer, srtContent] = await Promise.all([
      this.musicBed.synthesize(VideoFinalizationService.MUSIC_BED_MAX_SECONDS),
      Promise.resolve(params.transcript ? this.subtitleBuilder.buildSrt(params.transcript) : null),
    ]);

    const assembled = await this.videoAssembly.assemble({ videoBuffer, narrationBuffer, musicBuffer, srtContent });

    // Vérifie que le fichier RÉELLEMENT produit correspond à ce que ffmpeg était censé produire
    // (cf. VideoQcService) — un fichier final cassé ne doit jamais atteindre la revue humaine,
    // l'exception se propage naturellement vers le mécanisme d'échec du processor.
    const qc = await this.videoQc.validate(assembled.buffer, { expectedDurationSeconds: assembled.durationSeconds });
    if (!qc.passed) {
      throw new Error(`Échec du contrôle qualité de la vidéo finale : ${qc.reasons.join('; ')}`);
    }

    return { status: 'assembled', buffer: assembled.buffer, mimeType: assembled.mimeType, durationSeconds: assembled.durationSeconds };
  }

  // Enchaîne plusieurs clips vidéo bruts (un par plan du script, cf.
  // AiOrchestratorService.generateMultiShotVideoOrDegrade) en une seule séquence dynamique —
  // plutôt qu'un clip unique figé sur sa dernière image pendant le reste de la narration (cf.
  // filtre tpad dans VideoAssemblyService.assemble(), qui continue de s'appliquer normalement
  // ensuite au reliquat de durée entre cette séquence combinée et la narration complète).
  // Chaque entrée de `clipContents` suit le même contrat que `rawVideoUrl` dans finalize()
  // ci-dessus (data URI ou URL HTTP) — les clips d'un même appel peuvent provenir de
  // fournisseurs différents si l'un a basculé sur un repli en cours de route (cf.
  // AiGatewayService.buildAttemptOrder). Exposé ici (plutôt que dans AiOrchestratorService
  // directement) pour garder tout accès ffmpeg/réseau réel encapsulé dans ce module, mockable
  // en un seul point dans les tests de l'Orchestrator.
  async concatenateClips(clipContents: string[]): Promise<string> {
    const buffers = await Promise.all(clipContents.map((content) => resolveMediaBuffer(content)));
    const { buffer } = await concatenateVideoClips(buffers);
    return `data:video/mp4;base64,${buffer.toString('base64')}`;
  }
}
