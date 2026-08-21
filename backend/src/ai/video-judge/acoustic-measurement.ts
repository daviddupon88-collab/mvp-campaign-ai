import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

// Mission 4 Phase D — mesure de dynamique acoustique (RMS variance, ffmpeg, coût IA nul).
// Extrait de VideoJudgeService (Phase D) vers un module PARTAGÉ (Phase E) : le benchmark TTS
// isolé (mission4-tts-benchmark.ts) a besoin de la MÊME mesure pour comparer tts-1 vs
// gpt-4o-mini-tts, sans dupliquer la logique ni créer de dépendance du benchmark vers le Judge.
// Approxime la "dynamique acoustique" (le volume varie-t-il dans le temps) — PAS une détection
// d'émotion réelle, qu'aucun provider actuel ne mesure. États STRICTEMENT nommés
// ACOUSTIC_DYNAMICS_* (jamais EMOTION_*, règle absolue Mission 4).
export type AcousticDynamicsState = 'ACOUSTIC_DYNAMICS_LOW' | 'ACOUSTIC_DYNAMICS_ADEQUATE' | 'ACOUSTIC_DYNAMICS_HIGH';

export const ACOUSTIC_DYNAMICS_LOW_MAX_STDDEV = 2; // dB — sous ce seuil, narration jugée plate
export const ACOUSTIC_DYNAMICS_HIGH_MIN_STDDEV = 6; // dB — au-dessus, narration jugée très dynamique
export const ACOUSTIC_DYNAMICS_SCORE_REFERENCE_STDDEV = 4; // dB — écart-type associé à un score de 100 (seuils à recalibrer avec des données réelles)
const RMS_WINDOW_SAMPLE_RATE = 44100; // Hz — narration mp3 générée par OpenAI TTS

export function classifyAcousticDynamics(stdDev: number): AcousticDynamicsState {
  if (stdDev < ACOUSTIC_DYNAMICS_LOW_MAX_STDDEV) return 'ACOUSTIC_DYNAMICS_LOW';
  if (stdDev >= ACOUSTIC_DYNAMICS_HIGH_MIN_STDDEV) return 'ACOUSTIC_DYNAMICS_HIGH';
  return 'ACOUSTIC_DYNAMICS_ADEQUATE';
}

// Score continu (pas juste 3 paliers) : un écart-type proche de la référence (dynamique
// "adéquate") obtient le meilleur score, un écart-type très bas (plat) ou très haut
// (potentiellement erratique) est pénalisé symétriquement — évite un effet de seuil brutal.
export function scoreAcousticDynamics(stdDev: number): number {
  const reference = ACOUSTIC_DYNAMICS_SCORE_REFERENCE_STDDEV;
  if (stdDev >= reference) {
    return Math.max(40, Math.round(100 - (stdDev - reference) * 5));
  }
  return Math.round(Math.max(0, Math.min(100, (stdDev / reference) * 100)));
}

export function computeStdDev(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// Fenêtres ~1s de niveau RMS via ffmpeg (astats+ametadata, déterministe, coût IA nul) — même
// philosophie que VideoJudgeService.measureIntegratedLoudness : parsing défensif d'un flux
// stderr texte, jamais une exception non gérée qui remonterait jusqu'à l'appelant.
export function measureRmsWindows(buffer: Buffer): Promise<number[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-rms-'));
  const inputPath = path.join(tmpDir, `${randomUUID()}.mp3`);

  return new Promise((resolve, reject) => {
    fs.writeFileSync(inputPath, buffer);
    const rmsValues: number[] = [];
    ffmpeg(inputPath)
      .audioFilters([`asetnsamples=n=${RMS_WINDOW_SAMPLE_RATE}`, 'astats=metadata=1:reset=1', 'ametadata=mode=print'])
      .outputOptions(['-f', 'null'])
      .on('stderr', (line: string) => {
        const match = /lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/.exec(line);
        if (match) rmsValues.push(parseFloat(match[1]));
      })
      .on('end', () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve(rmsValues.filter((v) => Number.isFinite(v)));
      })
      .on('error', (err) => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        reject(new Error(`Mesure de dynamique vocale (ffmpeg astats) a échoué : ${err.message}`));
      })
      .save(path.join(tmpDir, 'null-output'));
  });
}
