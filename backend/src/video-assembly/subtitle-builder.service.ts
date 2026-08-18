import { Injectable } from '@nestjs/common';
import { TranscriptSegment } from '../ai/ai-gateway/providers/ai-provider.interface';

// Construit un fichier .srt à partir des segments horodatés renvoyés par la transcription
// (cf. OpenAiProvider.transcribeAudio) — pur formatage de chaîne, aucune I/O, aucun appel
// externe : le timing vient déjà de la transcription, ce service ne fait qu'en dériver le
// format attendu par le filtre `subtitles` de ffmpeg (cf. VideoAssemblyService).
@Injectable()
export class SubtitleBuilderService {
  // ~36 caractères/ligne : repère lisible pour une police calibrée sur une vidéo portrait
  // 720×1280 (cf. force_style dans VideoAssemblyService) — au-delà, la ligne déborde du cadre.
  private static readonly MAX_CHARS_PER_LINE = 36;

  // ~12 mots par légende : Whisper (granularité "segment", cf. OpenAiProvider.transcribeAudio)
  // ne garantit pas des segments courts — une seule phrase longue peut couvrir plusieurs
  // dizaines de secondes de narration en UN SEUL segment. Même correctement réparti en lignes
  // courtes par wrapText, un tel segment reste affiché EN BLOC pendant toute sa durée : un pavé
  // de texte occupant l'essentiel de l'écran plutôt que des légendes courtes qui s'enchaînent
  // (retour utilisateur du 2026-08-17). Découpe ces segments en plusieurs légendes de taille
  // égale (en mots), chacune occupant une fraction égale du temps du segment d'origine —
  // estimation simple (Whisper ne renvoie pas d'horodatage par mot à la granularité "segment"),
  // suffisante pour éviter le pavé, pas un chronométrage mot-à-mot exact.
  private static readonly MAX_WORDS_PER_CUE = 12;

  buildSrt(segments: TranscriptSegment[]): string {
    const cues = segments.flatMap((segment) => this.splitIntoCues(segment));
    return cues
      .map((cue, index) => {
        const wrapped = this.wrapText(cue.text, SubtitleBuilderService.MAX_CHARS_PER_LINE);
        return `${index + 1}\n${this.formatTimestamp(cue.start)} --> ${this.formatTimestamp(cue.end)}\n${wrapped}`;
      })
      .join('\n\n');
  }

  private splitIntoCues(segment: TranscriptSegment): Array<{ start: number; end: number; text: string }> {
    const words = segment.text.split(/\s+/).filter(Boolean);
    if (words.length <= SubtitleBuilderService.MAX_WORDS_PER_CUE) {
      return [{ start: segment.start, end: segment.end, text: segment.text }];
    }

    const chunks: string[][] = [];
    for (let i = 0; i < words.length; i += SubtitleBuilderService.MAX_WORDS_PER_CUE) {
      chunks.push(words.slice(i, i + SubtitleBuilderService.MAX_WORDS_PER_CUE));
    }

    const duration = segment.end - segment.start;
    return chunks.map((chunk, i) => ({
      start: segment.start + (duration * i) / chunks.length,
      end: segment.start + (duration * (i + 1)) / chunks.length,
      text: chunk.join(' '),
    }));
  }

  // Découpe un segment (potentiellement une phrase entière, cf. granularité "segment" de
  // Whisper) en plusieurs lignes sans couper un mot — libass (filtre `subtitles` de ffmpeg)
  // n'effectue aucun retour à la ligne automatique : sans ce découpage, une réplique longue
  // s'affiche en une seule ligne qui déborde du cadre vidéo (retour utilisateur du 2026-08-17).
  private wrapText(text: string, maxCharsPerLine: number): string {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxCharsPerLine && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);

    return lines.join('\n');
  }

  // Format SRT : HH:MM:SS,mmm — la virgule (pas un point) comme séparateur des millisecondes
  // est une exigence stricte du format, pas un choix stylistique.
  private formatTimestamp(seconds: number): string {
    const totalMs = Math.max(0, Math.round(seconds * 1000));
    const ms = totalMs % 1000;
    const totalSeconds = Math.floor(totalMs / 1000);
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);

    const pad = (n: number, len = 2) => String(n).padStart(len, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }
}
