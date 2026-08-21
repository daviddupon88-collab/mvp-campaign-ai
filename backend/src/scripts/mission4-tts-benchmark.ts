// Mission 4 Phase E ("Creative Video & Audio Intelligence", 2026-08-20, Correction obligatoire
// 5) — SCRIPT EXPÉRIMENTAL ISOLÉ, comparaison contrôlée tts-1 (défaut actuel, inchangé) vs
// gpt-4o-mini-tts + instructions (candidat), sur voiceDynamism/voicePacing/intelligibilité/
// durée/coût. INVOCATION MANUELLE UNIQUEMENT — ce fichier n'est JAMAIS importé par
// OpenAiProvider, VideoQualityLoopService ou campaign-generation.processor.ts (vérifié
// statiquement par mission4-tts-benchmark.isolation.spec.ts). Le changement de modèle par défaut
// dans OpenAiProvider.generateAudio, s'il a lieu, est un changement de code SÉPARÉ et délibéré,
// jamais un effet de bord de ce script — voir OpenAiProvider.generateAudio pour la discipline
// actuelle ("tts-1 reste le défaut tant que ce benchmark n'a pas démontré un gain mesurable").
//
// Usage (développement, via ts-node) :
//   OPENAI_API_KEY=... npx ts-node src/scripts/mission4-tts-benchmark.ts \
//     [--text "narration réelle à comparer"] [--hook "..."] [--emotion "..."] [--cta "..."]
//
// Sans --text, une narration d'exemple courte est utilisée (coût marginal, quelques centimes —
// jamais une campagne complète, cf. plan).

import { ConfigService } from '@nestjs/config';
import { OpenAiProvider } from '../ai/ai-gateway/providers/openai.provider';
import { buildVoiceDirectionInstructions } from '../ai/ai-gateway/voice-direction';
import { measureRmsWindows, computeStdDev, classifyAcousticDynamics, scoreAcousticDynamics } from '../ai/video-judge/acoustic-measurement';
import { computeVoicePacing } from '../ai/video-judge/voice-pacing';
import { resolveMediaBuffer } from '../common/http/resolve-media-buffer';
import { TranscriptSegment } from '../ai/ai-gateway/providers/ai-provider.interface';

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function buildProvider(): OpenAiProvider {
  const fakeConfig = { get: (key: string) => process.env[key] } as unknown as ConfigService;
  return new OpenAiProvider(fakeConfig);
}

interface ModelResult {
  model: string;
  costEstimate: number | undefined;
  durationMs: number;
  audioDurationSeconds: number;
  acousticState: string;
  acousticStdDev: number;
  acousticScore: number;
  voicePacing: ReturnType<typeof computeVoicePacing>;
  transcriptText: string;
}

async function measureModel(provider: OpenAiProvider, model: 'tts-1' | 'gpt-4o-mini-tts', text: string, instructions?: string): Promise<ModelResult> {
  const audio = await provider.generateAudio!({ prompt: text, model, ...(instructions ? { instructions } : {}) });
  const audioBuffer = await resolveMediaBuffer(audio.content);

  const rmsWindows = await measureRmsWindows(audioBuffer);
  const stdDev = rmsWindows.length >= 2 ? computeStdDev(rmsWindows) : 0;
  const acousticState = rmsWindows.length >= 2 ? classifyAcousticDynamics(stdDev) : 'INDISPONIBLE (narration trop courte)';
  const acousticScore = rmsWindows.length >= 2 ? scoreAcousticDynamics(stdDev) : 0;

  const transcription = await provider.transcribeAudio!({ audioBuffer, mimeType: 'audio/mpeg' });
  const segments: TranscriptSegment[] = JSON.parse(transcription.content);
  const transcriptText = segments.map((s) => s.text).join(' ');
  const voicePacing = computeVoicePacing(segments);
  const audioDurationSeconds = segments.length > 0 ? segments[segments.length - 1].end : 0;

  return {
    model,
    costEstimate: audio.costEstimate,
    durationMs: audio.durationMs,
    audioDurationSeconds,
    acousticState,
    acousticStdDev: stdDev,
    acousticScore,
    voicePacing,
    transcriptText,
  };
}

function printResult(label: string, result: ModelResult): void {
  console.log(`\n--- ${label} (${result.model}) ---`);
  console.log(`Coût estimé      : $${result.costEstimate?.toFixed(4) ?? 'n/a'}`);
  console.log(`Temps de génération : ${result.durationMs} ms`);
  console.log(`Durée audio      : ${result.audioDurationSeconds.toFixed(1)} s`);
  console.log(`Dynamique acoustique : ${result.acousticState} (écart-type RMS ${result.acousticStdDev.toFixed(2)} dB, score ${result.acousticScore})`);
  console.log(`Débit de parole  : ${result.voicePacing ? `${result.voicePacing.speakingRate.toFixed(2)} mots/s (${result.voicePacing.diagnostic})` : 'non mesurable'}`);
  console.log(`Transcription (intelligibilité, Whisper) : "${result.transcriptText}"`);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY requis.');
    process.exit(1);
  }

  const text = argValue('--text', "Votre café reste chaud pendant douze heures, où que vous soyez. Découvrez la mug qui change tout.");
  const hook = argValue('--hook', 'Et si votre café ne refroidissait jamais ?');
  const emotion = argValue('--emotion', 'chaleureux, énergique, convaincant');
  const cta = argValue('--cta', 'Commandez maintenant');

  console.log('Mission 4 Phase E — Benchmark TTS isolé (tts-1 vs gpt-4o-mini-tts)');
  console.log(`Texte comparé : "${text}"`);

  const provider = buildProvider();

  const baseline = await measureModel(provider, 'tts-1', text);
  const instructions = buildVoiceDirectionInstructions({ hook, emotionalDirection: emotion, cta });
  const candidate = await measureModel(provider, 'gpt-4o-mini-tts', text, instructions);

  printResult('DÉFAUT ACTUEL', baseline);
  printResult('CANDIDAT', candidate);

  console.log('\n--- Verdict ---');
  const dynamismGain = candidate.acousticScore - baseline.acousticScore;
  console.log(`Delta score de dynamique acoustique : ${dynamismGain >= 0 ? '+' : ''}${dynamismGain}`);
  console.log(
    dynamismGain > 5
      ? 'Gain mesurable sur la dynamique acoustique — vérifier manuellement l\'intelligibilité (transcriptions ci-dessus) avant toute décision d\'adoption.'
      : 'Aucun gain mesurable démontré — tts-1 reste le défaut recommandé (Correction obligatoire 5 : jamais de bascule sans preuve empirique).',
  );
  console.log('\nRAPPEL : ce script ne modifie AUCUN code de production. Adopter gpt-4o-mini-tts par défaut requiert un changement séparé et délibéré dans OpenAiProvider.generateAudio.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Échec du benchmark :', error);
    process.exit(1);
  });
}
