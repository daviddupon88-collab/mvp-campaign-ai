import { Injectable, Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { resolveMediaBuffer } from '../../common/http/resolve-media-buffer';
import { VisualDna } from './visual-dna.service';
import { PROMPT_VERSIONS } from '../prompt-versions';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobeStatic?.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

export interface MotionQualityResult {
  passed: boolean;
  score: number; // 0-100, 100 = aucun gel détecté
  reasons: string[];
  freezeRatio: number; // secondes figées / durée totale du clip
}
export interface VisualFidelityResult {
  passed: boolean;
  score: number; // 0-100
  reasons: string[];
}
export interface ShotQualityResult {
  passed: boolean; // motionQuality.passed && visualFidelity.passed
  qualityScore: number; // 0-100, combiné — informatif/traçabilité, jamais le seul critère de décision
  motionQuality: MotionQualityResult;
  visualFidelity: VisualFidelityResult;
  reasons: string[];
}

const FAILED_MOTION: MotionQualityResult = { passed: false, score: 0, reasons: ["Vérification du mouvement impossible"], freezeRatio: 1 };
const FAILED_FIDELITY: VisualFidelityResult = { passed: false, score: 0, reasons: ["Vérification de fidélité impossible"] };

// Video Analyzer : dernière étape de l'architecture Shot Plan, avant livraison d'un clip généré
// par Veo. Deux vérifications combinées, volontairement de nature différente :
// - Motion Quality : PUREMENT DÉTERMINISTE (ffmpeg, aucun appel IA) — même philosophie que
//   VideoQcService (cf. backend/src/video-assembly/video-qc.service.ts) : un plan quasi figé
//   est un problème mesurable objectivement, pas un jugement à faire trancher par un modèle.
// - Visual Fidelity : forcément un jugement IA (vision) — comparer une frame générée à l'ADN
//   visuel du produit est une question sémantique, aucune métrique déterministe n'y répond.
// Ne lève JAMAIS — une erreur interne (ffmpeg, appel IA) devient un résultat `passed:false`,
// qui déclenche simplement le chemin de régénération côté AiOrchestratorService, ne bloque
// jamais toute la campagne (cf. generateShotPlanVideoOrDegrade).
@Injectable()
export class VideoAnalyzerService {
  private readonly logger = new Logger(VideoAnalyzerService.name);
  private static readonly FREEZE_RATIO_THRESHOLD = 0.3;
  private static readonly FIDELITY_SCORE_THRESHOLD = 70;

  constructor(private readonly aiGateway: AiGatewayService) {}

  async analyze(ctx: AiCallContext, clipContent: string, params: { visualDna: VisualDna }): Promise<ShotQualityResult> {
    try {
      const buffer = await resolveMediaBuffer(clipContent);
      const [motionQuality, visualFidelity] = await Promise.all([
        this.checkMotionQuality(buffer),
        this.checkVisualFidelity(ctx, buffer, params.visualDna),
      ]);

      // Pondération : la fidélité (le clip montre-t-il vraiment le bon produit ?) pèse plus
      // lourd que le mouvement (le clip est-il dynamique ?) — un clip dynamique mais infidèle
      // au produit est un échec plus grave qu'un clip fidèle mais un peu trop statique.
      const qualityScore = Math.round(motionQuality.score * 0.4 + visualFidelity.score * 0.6);

      return {
        passed: motionQuality.passed && visualFidelity.passed,
        qualityScore,
        motionQuality,
        visualFidelity,
        reasons: [...motionQuality.reasons, ...visualFidelity.reasons],
      };
    } catch (error) {
      this.logger.warn(`Analyse du plan vidéo échouée, résultat dégradé (déclenche une régénération) : ${error}`);
      return {
        passed: false,
        qualityScore: 0,
        motionQuality: FAILED_MOTION,
        visualFidelity: FAILED_FIDELITY,
        reasons: [`Analyse indisponible : ${error}`],
      };
    }
  }

  // Filtre ffmpeg `freezedetect` — conçu spécifiquement pour détecter les plans figés, zéro
  // nouvelle dépendance (le projet n'a que fluent-ffmpeg/ffmpeg-static/ffprobe-static, aucune
  // bibliothèque de décodage d'image pour un diff pixel-à-pixel maison).
  private async checkMotionQuality(buffer: Buffer): Promise<MotionQualityResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-motion-'));
    const inputPath = path.join(tmpDir, `${randomUUID()}.mp4`);

    try {
      fs.writeFileSync(inputPath, buffer);

      const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, data) => (err ? reject(err) : resolve(data)));
      });
      const durationSeconds = metadata.format.duration ?? 0;
      if (durationSeconds <= 0) {
        return { passed: false, score: 0, reasons: ['Durée de clip nulle ou invalide'], freezeRatio: 1 };
      }

      const freezeDurations = await this.runFreezeDetect(inputPath);
      const totalFrozen = freezeDurations.reduce((sum, d) => sum + d, 0);
      const freezeRatio = Math.min(1, totalFrozen / durationSeconds);
      const score = Math.round((1 - freezeRatio) * 100);
      const passed = freezeRatio <= VideoAnalyzerService.FREEZE_RATIO_THRESHOLD;

      return {
        passed,
        score,
        freezeRatio,
        reasons: passed ? [] : [`Vidéo quasi-statique : ${totalFrozen.toFixed(1)}s sur ${durationSeconds.toFixed(1)}s sans mouvement détecté`],
      };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private runFreezeDetect(inputPath: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const freezeDurations: number[] = [];
      ffmpeg(inputPath)
        .videoFilters('freezedetect=n=0.004:d=0.5')
        .outputOptions(['-f', 'null'])
        .on('stderr', (line: string) => {
          const match = /freeze_duration:\s*([\d.]+)/.exec(line);
          if (match) freezeDurations.push(parseFloat(match[1]));
        })
        .on('end', () => resolve(freezeDurations))
        .on('error', (err) => reject(new Error(`freezedetect (ffmpeg) a échoué : ${err.message}`)))
        .save(path.join(path.dirname(inputPath), 'null-output'));
    });
  }

  // Extrait une frame représentative (~40% de la durée — assez loin du 1er plan pour refléter
  // le mouvement réellement généré, pas juste l'image de départ) et la fait juger par vision
  // contre l'ADN visuel du produit.
  private async checkVisualFidelity(ctx: AiCallContext, buffer: Buffer, visualDna: VisualDna): Promise<VisualFidelityResult> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ai-fidelity-'));
    const inputPath = path.join(tmpDir, `${randomUUID()}.mp4`);
    const framePath = path.join(tmpDir, `${randomUUID()}.jpg`);

    try {
      fs.writeFileSync(inputPath, buffer);

      const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, data) => (err ? reject(err) : resolve(data)));
      });
      const durationSeconds = metadata.format.duration ?? 0;
      const seekSeconds = durationSeconds > 0 ? durationSeconds * 0.4 : 0;

      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .seekInput(seekSeconds)
          .frames(1)
          .on('end', () => resolve())
          .on('error', (err) => reject(new Error(`Extraction de frame (ffmpeg) a échoué : ${err.message}`)))
          .save(framePath);
      });

      const frameBase64 = fs.readFileSync(framePath).toString('base64');
      const frameDataUri = `data:image/jpeg;base64,${frameBase64}`;

      const prompt = `Compare cette image extraite d'une vidéo publicitaire à l'identité visuelle de référence du produit :
${JSON.stringify(visualDna)}

La vidéo montre-t-elle bien CE produit (mêmes couleurs, matières, forme, éléments distinctifs, logo) ?
Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
{"matches":true|false,"score":0-100,"mismatches":["...","..."]}`;

      const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl: frameDataUri }, 'openai', PROMPT_VERSIONS.visualFidelity);
      return this.parseFidelityResult(result.content);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private parseFidelityResult(raw: string): VisualFidelityResult {
    try {
      const parsed = JSON.parse(raw);
      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 0;
      const matches = parsed.matches !== false;
      const passed = matches && score >= VideoAnalyzerService.FIDELITY_SCORE_THRESHOLD;
      const mismatches = Array.isArray(parsed.mismatches) ? parsed.mismatches : [];

      return { passed, score, reasons: passed ? [] : [`Fidélité visuelle insuffisante (score ${score}/100)`, ...mismatches] };
    } catch (error) {
      this.logger.warn(`Réponse de vérification de fidélité non conforme au format JSON attendu: ${error}`);
      return { ...FAILED_FIDELITY, reasons: ['Réponse de vérification non exploitable'] };
    }
  }
}
