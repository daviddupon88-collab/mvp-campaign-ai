import { TranscriptSegment } from '../ai-gateway/providers/ai-provider.interface';

// Mission 4 Phase D — voicePacing : PAS motsTotal/durée (mélangerait diction et pauses), dérive
// des TranscriptSegment DÉJÀ disponibles (aucun appel supplémentaire, aucune mesure ffmpeg) :
// débit de parole sur le temps réellement parlé (pauses exclues) + ratio de pause. Extrait de
// VideoJudgeService vers un module PARTAGÉ (Phase E) : le benchmark TTS isolé a besoin de la
// même mesure pour comparer tts-1 vs gpt-4o-mini-tts sans dupliquer la logique.
export type VoicePacingDiagnostic = 'VOICE_TOO_FAST' | 'VOICE_TOO_SLOW' | 'VOICE_PAUSE_HEAVY' | 'VOICE_PACING_OK';

export const VOICE_PACING_MIN_WORDS_PER_SECOND = 2.5;
export const VOICE_PACING_MAX_WORDS_PER_SECOND = 3.5;
export const VOICE_PACING_HEAVY_PAUSE_RATIO = 0.35;

export interface VoicePacingMeasurement {
  speakingRate: number; // mots/s, pauses exclues
  pauseRatio: number; // 0-1
  diagnostic: VoicePacingDiagnostic;
}

// null si le débit n'est structurellement pas mesurable (transcript vide, durée nulle) —
// distinct d'un VOICE_PACING_OK/*, jamais une valeur inventée pour combler l'absence de donnée.
export function computeVoicePacing(transcript: TranscriptSegment[]): VoicePacingMeasurement | null {
  if (transcript.length === 0) return null;

  const totalWords = transcript.reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0);
  const spokenSeconds = transcript.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  if (spokenSeconds <= 0 || totalWords === 0) return null;

  const sorted = [...transcript].sort((a, b) => a.start - b.start);
  let pauseSeconds = 0;
  for (let i = 1; i < sorted.length; i++) {
    pauseSeconds += Math.max(0, sorted[i].start - sorted[i - 1].end);
  }
  const totalSpanSeconds = Math.max(spokenSeconds, sorted[sorted.length - 1].end - sorted[0].start);
  const pauseRatio = totalSpanSeconds > 0 ? pauseSeconds / totalSpanSeconds : 0;
  const speakingRate = totalWords / spokenSeconds;

  let diagnostic: VoicePacingDiagnostic = 'VOICE_PACING_OK';
  if (pauseRatio > VOICE_PACING_HEAVY_PAUSE_RATIO) diagnostic = 'VOICE_PAUSE_HEAVY';
  else if (speakingRate > VOICE_PACING_MAX_WORDS_PER_SECOND) diagnostic = 'VOICE_TOO_FAST';
  else if (speakingRate < VOICE_PACING_MIN_WORDS_PER_SECOND) diagnostic = 'VOICE_TOO_SLOW';

  return { speakingRate, pauseRatio, diagnostic };
}
