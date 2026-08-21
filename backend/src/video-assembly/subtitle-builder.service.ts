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

  // ~5 mots par légende (6 jusqu'au 2026-08-18 : 12) : à 12 mots, wrapText (36 car./ligne)
  // produisait encore 4 à 6 lignes empilées sur un segment Whisper typique — un pavé de texte
  // qui déborde du cadre et se chevauche (constaté en conditions réelles le 2026-08-18, cf.
  // captures d'écran), pas le rythme "punchline courte qui s'enchaîne" recherché pour une pub
  // verticale. 5 mots tient sur 1-2 lignes courtes à cette largeur de police, au prix de cues
  // plus nombreuses et donc plus rapides à l'écran — cohérent avec le rythme d'une pub sociale.
  // Whisper (granularité "segment", cf. OpenAiProvider.transcribeAudio) ne garantit pas des
  // segments courts — une seule phrase longue peut couvrir plusieurs dizaines de secondes de
  // narration en UN SEUL segment. Découpe ces segments en plusieurs légendes de taille égale
  // (en mots), chacune occupant une fraction égale du temps du segment d'origine — estimation
  // simple (Whisper ne renvoie pas d'horodatage par mot à la granularité "segment"), suffisante
  // pour éviter le pavé, pas un chronométrage mot-à-mot exact.
  private static readonly MAX_WORDS_PER_CUE = 5;

  // Fenêtre de tolérance (en mots) autour de MAX_WORDS_PER_CUE dans laquelle on cherche une
  // frontière sémantique (ponctuation, puis conjonction) avant de replier sur la coupure
  // mécanique — Mission 4 Phase F : la segmentation par bloc fixe de 5 mots coupait parfois au
  // milieu d'une proposition ("le produit qui / change tout"), une coupure artificielle que
  // cette fenêtre permet d'éviter sans dérégler le rythme des cues.
  private static readonly CUT_SEARCH_WINDOW = 2;

  // Ponctuation "forte" marquant une frontière de sens ; coupe juste après le mot qui la porte.
  private static readonly PUNCTUATION_END = /[,;:.!?…]$/;

  // Conjonctions de coordination courantes ; coupe juste avant, la conjonction ouvre la cue
  // suivante ("le produit / et son prix"). Liste volontairement restreinte (FR) — un faux
  // négatif (fallback mécanique) est sans conséquence, un faux positif casserait un sens.
  private static readonly CONJUNCTIONS = new Set(['et', 'mais', 'ou', 'donc', 'car', 'or', 'puis', 'alors']);

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

    const chunks = this.chunkWords(words);
    const duration = segment.end - segment.start;
    const totalWords = words.length;

    let wordsConsumed = 0;
    return chunks.map((chunk) => {
      const start = segment.start + (duration * wordsConsumed) / totalWords;
      wordsConsumed += chunk.length;
      const end = segment.start + (duration * wordsConsumed) / totalWords;
      return { start, end, text: chunk.join(' ') };
    });
  }

  // Découpe la liste de mots en chunks proches de MAX_WORDS_PER_CUE, en préférant une coupure
  // sur une frontière sémantique trouvée dans CUT_SEARCH_WINDOW autour du budget ; sans
  // frontière pertinente, replie sur la coupure mécanique au budget exact (comportement
  // historique, toujours disponible comme filet de sécurité).
  private chunkWords(words: string[]): string[][] {
    const chunks: string[][] = [];
    let remaining = words;

    while (remaining.length > SubtitleBuilderService.MAX_WORDS_PER_CUE) {
      const cutLength = this.findNaturalCut(remaining);
      chunks.push(remaining.slice(0, cutLength));
      remaining = remaining.slice(cutLength);
    }
    if (remaining.length > 0) chunks.push(remaining);

    return chunks;
  }

  private findNaturalCut(words: string[]): number {
    const budget = SubtitleBuilderService.MAX_WORDS_PER_CUE;
    const window = SubtitleBuilderService.CUT_SEARCH_WINDOW;
    const lo = Math.max(1, budget - window);
    const hi = Math.min(words.length - 1, budget + window);

    const candidates: number[] = [];
    for (let i = lo; i <= hi; i++) candidates.push(i);
    candidates.sort((a, b) => Math.abs(a - budget) - Math.abs(b - budget));

    for (const i of candidates) {
      if (SubtitleBuilderService.PUNCTUATION_END.test(words[i - 1])) return i;
    }
    for (const i of candidates) {
      const bare = words[i].toLowerCase().replace(/[,;:.!?…]/g, '');
      if (SubtitleBuilderService.CONJUNCTIONS.has(bare)) return i;
    }
    return budget;
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
