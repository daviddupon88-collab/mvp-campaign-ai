import { JudgeCriterionName, JudgeCriterionResult, UNAVAILABLE_DEFECT, WEIGHTS } from './video-judge.types';
import { QualityLoopOutcome, RepairAction } from './video-quality-loop.service';
import { classifyRepair, RepairScope, repairScopeForStrategy } from './repair-dispatch';
import { computeSeverity, computePriority, strategyCost } from './repair-priority';
import { RootCauseLevel, classifyRootCause } from './root-cause';
import { classifyMotionLevel, MotionLevel } from '../video-direction/video-analyzer.service';

// Phase F — Rapport structuré obligatoire (chantier "Moteur d'optimisation de la qualité vidéo
// — V2", 2026-08-19, spec Section 31, 21-22). Fonction PURE : dérive le rapport des données déjà
// calculées par les Phases A/B/C/D (aucune nouvelle colonne Prisma, aucun nouveau jugement —
// cf. plan, "migration-free par construction").
export interface StructuredQualityReport {
  statut: 'PASSED' | 'REPAIR_EXHAUSTED' | 'SKIPPED_NO_VIDEO';
  scorePrecedent: number | null;
  evolutionDuScore: number | null;
  meilleurScore: number;
  defauts: { critique: JudgeCriterionResult[]; important: JudgeCriterionResult[]; mineur: JudgeCriterionResult[] };
  causeRacine: string | null;
  ordreDePriorite: JudgeCriterionName[];
  reparationSelectionnee: RepairAction | null;
  gainReel: number | null;
  risqueDeRegression: boolean;
  numeroDuCycle: number;
  actionRecommandee: 'RETRY_LOCAL' | 'ESCALADE_STORYBOARD_RECOMMANDEE' | 'AUCUNE';
  // Phase Q (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19, spec Section 26) —
  // totalGenerations/totalRepairs dérivés PUREMENT de `outcome` (calculés ici, dans
  // buildQualityReport). Les autres champs exigent un contexte que cette fonction pure n'a pas
  // (escalades cumulées entre plusieurs appels à VideoQualityLoopService.run, crédits réels
  // agrégés en base, horloge murale) — laissés `undefined` ici, renseignés par l'appelant
  // (CampaignGenerationProcessor.finalizeVideoAsset) avant persistance.
  totalGenerations: number; // 1 génération initiale + chaque CLIP_REGEN appliqué (tous essais)
  totalRepairs: number; // alias de numeroDuCycle, nommage aligné sur le spec Section 26
  totalSceneRegenerations?: number;
  totalStoryboardRevisions?: number;
  totalConceptRevisions?: number;
  totalCredits?: number;
  elapsedMs?: number;
  rootCause?: RootCauseLevel | null;
  escalationLevel?: 'SCENE' | 'STORYBOARD' | 'CONCEPT';
  stopReason?: string;
  timeBudgetStatus?: TimeBudgetStatus;
  // Mission 4 Phase C — bande nommée dérivée du critère `motionDynamism` déjà jugé, absente si
  // ce critère est manquant ou marqué UNAVAILABLE_DEFECT (score alors sans signification).
  motionLevel?: MotionLevel;
  // Mission 4 — Rapport multi-composants (regroupement Voice/Audio/Subtitles explicite, section
  // 15 du spec) + repair log enrichi (section 19). Absents pour SKIPPED_NO_VIDEO (rien à dériver).
  componentScores?: ComponentScores;
  repairLog?: RepairLogEntry[];
  // Audit forensic (2026-08-20, campagne 83cbcd41) — le défaut le plus SÉVÈRE (score le plus bas
  // dans le pire panier de sévérité disponible), INDÉPENDAMMENT de sa réparabilité locale/son
  // coût. Distinct de `ordreDePriorite[0]` : celui-ci est pondéré par `computePriority` (poids ×
  // sévérité ÷ coût de réparation), donc un défaut UNREPAIRABLE (coût infini, cf.
  // repair-priority.ts::computePriority) retombe TOUJOURS à la priorité 0 et ne peut jamais
  // remonter en tête de `ordreDePriorite`, même s'il est objectivement le plus grave — exactement
  // le bug qui a fait retomber `rootCause` sur "SUBTITLE" (pacing, réparable à 8 crédits) au lieu
  // de "CONCEPT/STORYBOARD" (storytelling, score 38, UNREPAIRABLE) sur la campagne 83cbcd41.
  // `mostSevereDefect` sert de source à `classifyRootCause` dans tryEscalate
  // (campaign-generation.processor.ts) à la place de `ordreDePriorite[0]` — `ordreDePriorite`
  // reste inchangé et continue de piloter uniquement l'ORDRE d'exécution des réparations LOCALES
  // (VideoQualityLoopService.applyRepairs ne le consulte d'ailleurs pas directement : il
  // recalcule sa propre priorité via computePriority sur le groupe déjà filtré par stratégie —
  // ce champ ne change donc RIEN au dispatch de réparation, seulement au diagnostic de cause
  // racine utilisé pour décider une escalade).
  mostSevereDefect?: JudgeCriterionResult | null;
  // Audit forensique Mission 4.2 (P0-4) : une vidéo assemblée à partir de moins de plans que
  // prévu (ex. 3/4 après abandon définitif d'un plan malgré récupération, cf.
  // AiOrchestratorService.generateShotPlanVideoOrDegrade) était jusqu'ici indiscernable d'une
  // livraison complète dans tout le rapport — aucun champ ne portait ce signal. Même convention
  // que totalCredits/elapsedMs/rootCause ci-dessus : laissés `undefined` par buildQualityReport
  // (fonction pure, n'a pas accès au ShotPlan planifié), renseignés par l'appelant
  // (CampaignGenerationProcessor.finalizeVideoAsset) avant persistance.
  plannedShotCount?: number;
  deliveredShotCount?: number;
  // Audit forensique Mission 4.2 (P1-4) : chaque escalade Storyboard/Concept régénère
  // l'intégralité des plans vidéo depuis zéro (aucun réemploi possible — le Shot Plan est
  // recomposé holistiquement par le LLM, pas patché plan par plan, cf. rapport d'audit section
  // Q) — même quand un seul critère isolé, peu coûteux à réparer, a déclenché l'escalade. Compte
  // cumulé (toutes escalades de CETTE campagne) des clips vidéo déjà générés et jetés — pure
  // visibilité économique, ne change aucun comportement de génération. Même convention que
  // plannedShotCount/deliveredShotCount : laissé `undefined` par buildQualityReport (fonction
  // pure, pas de contexte d'escalade), renseigné par l'appelant.
  discardedClipsOnEscalation?: number;
}

// Mission 4 — regroupement dérivé (calcul pur sur `criteria` déjà là, même mécanique que
// computeSubScore de VideoJudgeService) : videoScore/voiceScore/audioScore/subtitleScore sont des
// moyennes pondérées sur un sous-ensemble de critères, jamais calculées à partir d'un critère
// UNAVAILABLE_DEFECT (exclu, comme dans computeSubScore).
const VIDEO_SCORE_CRITERIA: JudgeCriterionName[] = ['productConsistency', 'motionDynamism', 'productVisibility', 'formatCompliance', 'visualComposition', 'sceneConsistency'];
const VOICE_SCORE_CRITERIA: JudgeCriterionName[] = ['voiceDynamism', 'voicePacing', 'voiceAudibility'];
const AUDIO_SCORE_CRITERIA: JudgeCriterionName[] = ['audioQuality'];
const SUBTITLE_SCORE_CRITERIA: JudgeCriterionName[] = ['textReadability', 'grammar', 'pacing'];

// Correction obligatoire 4 (Round 3) — `musicScore` ne doit JAMAIS être confondu avec un score
// sain : tant qu'aucun critère musique n'existe (portée de cette mission), la forme est
// `{status:'UNAVAILABLE', reason:...}`, jamais un nombre par défaut (ni 0, ni 100, ni une
// moyenne). Le jour où un critère musique existe, la forme devient `{status:'AVAILABLE', score}`
// — tout consommateur doit discriminer `status` avant de lire `score` (le type l'impose : `score`
// n'existe pas sur la branche UNAVAILABLE).
export type MusicScore = { status: 'AVAILABLE'; score: number } | { status: 'UNAVAILABLE'; reason: 'NO_MUSIC_CRITERION_IMPLEMENTED' };

export interface ComponentScores {
  videoScore: number;
  voiceScore: number;
  audioScore: number;
  subtitleScore: number;
  musicScore: MusicScore;
}

const COMPONENT_NEUTRAL_SCORE = 50; // repli si le groupe n'a AUCUN critère exploitable — même convention que computeSubScore (video-judge.service.ts)

function computeComponentScore(criteria: JudgeCriterionResult[], group: JudgeCriterionName[]): number {
  const groupCriteria = criteria.filter((c) => group.includes(c.name) && c.defect !== UNAVAILABLE_DEFECT);
  const totalWeight = groupCriteria.reduce((sum, c) => sum + (WEIGHTS[c.name] ?? 0), 0);
  const weightedSum = groupCriteria.reduce((sum, c) => sum + c.score * (WEIGHTS[c.name] ?? 0), 0);
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : COMPONENT_NEUTRAL_SCORE;
}

function deriveComponentScores(criteria: JudgeCriterionResult[]): ComponentScores {
  return {
    videoScore: computeComponentScore(criteria, VIDEO_SCORE_CRITERIA),
    voiceScore: computeComponentScore(criteria, VOICE_SCORE_CRITERIA),
    audioScore: computeComponentScore(criteria, AUDIO_SCORE_CRITERIA),
    subtitleScore: computeComponentScore(criteria, SUBTITLE_SCORE_CRITERIA),
    musicScore: { status: 'UNAVAILABLE', reason: 'NO_MUSIC_CRITERION_IMPLEMENTED' },
  };
}

// Mission 4 — repair log enrichi (section 19 du spec) : synthèse dérivée de `attempts[]`
// (calcul PUR, aucune nouvelle donnée live à faire transiter dans la boucle). `rootCause` est
// calculé avec l'historique COMPLET (outcome.history), pas l'historique "au moment de CETTE
// réparation" (non reconstituable précisément depuis les données actuellement conservées) —
// approximation documentée, acceptable pour un journal d'observabilité a posteriori : les
// décisions de réparation RÉELLES ont déjà été prises correctement en direct (cf.
// VideoQualityLoopService.applyRepairs/tryEscalate), ce journal ne fait que les relater.
export interface RepairLogEntry {
  repairScope: RepairScope;
  rootCause: RootCauseLevel;
  criterion: JudgeCriterionName;
  beforeScore: number | null;
  afterScore: number | null;
  estimatedCost: number;
  confidence?: number;
}

function buildRepairLog(outcome: QualityLoopOutcome): RepairLogEntry[] {
  if (outcome.status === 'PASSED' && outcome.lastJudge === null) return [];

  const log: RepairLogEntry[] = [];
  const attempts = outcome.attempts;
  const finalJudge = outcome.status === 'PASSED' ? outcome.lastJudge : outcome.bestAttempt.judge;
  // PASSED ne porte pas d'historique (jamais eu de réparation ECHEC/FAIBLE à consulter pour
  // désambiguïser storyboard/concept) — repli sur [] plutôt qu'un accès invalide.
  const history = outcome.status === 'REPAIR_EXHAUSTED' ? outcome.history : [];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const nextJudge = attempts[i + 1]?.judge ?? finalJudge;
    for (const action of attempt.repairsApplied) {
      const beforeCriterion = attempt.judge.criteria.find((c) => c.name === action.criterion);
      const afterCriterion = nextJudge?.criteria.find((c) => c.name === action.criterion);
      log.push({
        repairScope: repairScopeForStrategy(action.strategy),
        rootCause: classifyRootCause(action.criterion, { sceneRef: action.sceneId, history, allCriteria: attempt.judge.criteria }),
        criterion: action.criterion,
        beforeScore: beforeCriterion?.score ?? null,
        afterScore: afterCriterion?.score ?? null,
        estimatedCost: strategyCost(action.strategy),
        ...(beforeCriterion?.confidence !== undefined ? { confidence: beforeCriterion.confidence } : {}),
      });
    }
  }
  return log;
}

export type TimeBudgetStatus = 'ON_TRACK' | 'AT_RISK' | 'TIME_BUDGET_EXCEEDED';

// Valeur de départ documentée (même convention que WEIGHTS/MIN_EXPECTED_VALUE, cf.
// video-judge.types.ts/repair-priority.ts) — 20 minutes couvre une génération avec 1 escalade
// storyboard OU concept (chacune relance la Quality Loop au complet) sans être punitif pour le
// cas courant (1 seul passage). À recalibrer après le premier passage E2E réel avec escalade.
export const TIME_BUDGET_MS = 20 * 60 * 1000;

// AT_RISK dès 70% du budget consommé SANS PASS — signal précoce avant le dépassement dur,
// jamais bloquant en lui-même (seul TIME_BUDGET_EXCEEDED interrompt réellement, cf. l'appelant).
const AT_RISK_THRESHOLD_RATIO = 0.7;

export function computeTimeBudgetStatus(elapsedMs: number, budgetMs: number = TIME_BUDGET_MS): TimeBudgetStatus {
  if (elapsedMs >= budgetMs) return 'TIME_BUDGET_EXCEEDED';
  if (elapsedMs >= budgetMs * AT_RISK_THRESHOLD_RATIO) return 'AT_RISK';
  return 'ON_TRACK';
}

export function buildQualityReport(outcome: QualityLoopOutcome): StructuredQualityReport {
  if (outcome.status === 'PASSED' && outcome.lastJudge === null) {
    // Mode mock/narration indisponible (VideoFinalizationService) — rien n'a été jugé.
    return {
      statut: 'SKIPPED_NO_VIDEO', scorePrecedent: null, evolutionDuScore: null, meilleurScore: 0,
      defauts: { critique: [], important: [], mineur: [] }, causeRacine: null, ordreDePriorite: [],
      reparationSelectionnee: null, gainReel: null, risqueDeRegression: false, numeroDuCycle: 0, actionRecommandee: 'AUCUNE',
      totalGenerations: 0, totalRepairs: 0,
    };
  }

  const referenceJudge = outcome.status === 'PASSED' ? outcome.lastJudge! : outcome.bestAttempt.judge;
  const defauts = classifyDefects(referenceJudge.criteria);
  const ordreDePriorite = rankDefectNames(referenceJudge.criteria);
  const motionLevel = deriveMotionLevel(referenceJudge.criteria);
  const componentScores = deriveComponentScores(referenceJudge.criteria);
  const repairLog = buildRepairLog(outcome);
  const numeroDuCycle = outcome.attempts.length;
  const lastAttempt = outcome.attempts[outcome.attempts.length - 1];
  const previousAttempt = outcome.attempts[outcome.attempts.length - 2];
  // 1 génération initiale (la vidéo brute déjà assemblée avant le 1er jugement) + chaque
  // CLIP_REGEN effectivement appliqué (tous essais confondus) — SUBTITLE_ONLY/AUDIO_REGEN ne
  // regénèrent aucun clip vidéo, jamais comptés ici.
  const totalGenerations = 1 + outcome.attempts.flatMap((a) => a.repairsApplied).filter((r) => r.strategy === 'CLIP_REGEN').length;
  const totalRepairs = numeroDuCycle;

  if (outcome.status === 'PASSED') {
    return {
      statut: 'PASSED',
      scorePrecedent: previousAttempt?.judge.globalScore ?? null,
      evolutionDuScore: previousAttempt ? referenceJudge.globalScore - previousAttempt.judge.globalScore : null,
      meilleurScore: referenceJudge.globalScore,
      defauts, causeRacine: null, ordreDePriorite,
      reparationSelectionnee: null, gainReel: null, risqueDeRegression: outcome.attempts.some((a) => a.reverted), numeroDuCycle, actionRecommandee: 'AUCUNE',
      totalGenerations, totalRepairs, motionLevel, componentScores, repairLog,
    };
  }

  // REPAIR_EXHAUSTED — spec Section 22 : classifier l'échec, ne jamais le déclarer réussi.
  const causeRacine = defauts.critique[0]?.justification ?? defauts.important[0]?.justification ?? null;
  const mostSevereDefect = findMostSevereDefect(defauts);
  const reparationSelectionnee = lastAttempt?.repairsApplied[lastAttempt.repairsApplied.length - 1] ?? null;
  const gainReel = reparationSelectionnee
    ? outcome.history.find((h) => h.criterion === reparationSelectionnee.criterion && h.sceneId === reparationSelectionnee.sceneId)?.scoreDelta ?? null
    : null;
  // Escalade recommandée (spec Section 4, "2e réparation inefficace -> arrêter la régénération
  // locale automatique") si l'historique montre au moins un ECHEC — détection seulement, jamais
  // exécutée automatiquement (cf. hors périmètre du plan).
  const actionRecommandee = outcome.history.some((h) => h.outcome === 'ECHEC') ? 'ESCALADE_STORYBOARD_RECOMMANDEE' : outcome.attempts.length > 0 ? 'RETRY_LOCAL' : 'AUCUNE';

  return {
    statut: 'REPAIR_EXHAUSTED',
    scorePrecedent: previousAttempt?.judge.globalScore ?? null,
    evolutionDuScore: previousAttempt ? outcome.lastJudge.globalScore - previousAttempt.judge.globalScore : null,
    meilleurScore: outcome.bestAttempt.judge.globalScore,
    defauts, causeRacine, ordreDePriorite, reparationSelectionnee, gainReel,
    risqueDeRegression: outcome.attempts.some((a) => a.reverted), numeroDuCycle, actionRecommandee,
    totalGenerations, totalRepairs, motionLevel, componentScores, repairLog, mostSevereDefect,
  };
}

// Audit forensic (campagne 83cbcd41) — sélectionne le défaut le plus grave PAR SÉVÈRITE SEULE :
// préfère le panier CRITIQUE (déjà calculé par classifyDefects), puis à l'intérieur du panier le
// score le PLUS BAS — jamais pondéré par le coût/la stratégie de réparation, contrairement à
// `ordreDePriorite` (computePriority). Un défaut UNREPAIRABLE grave doit pouvoir être désigné
// "le plus sévère" même s'il n'a mécaniquement aucune réparation locale possible.
function findMostSevereDefect(defauts: { critique: JudgeCriterionResult[]; important: JudgeCriterionResult[]; mineur: JudgeCriterionResult[] }): JudgeCriterionResult | null {
  const bucket = defauts.critique.length > 0 ? defauts.critique : defauts.important.length > 0 ? defauts.important : defauts.mineur;
  if (bucket.length === 0) return null;
  return [...bucket].sort((a, b) => a.score - b.score)[0];
}

// Mission 4 Phase C — dérive la bande nommée depuis le critère `motionDynamism` déjà jugé.
// Absent si le critère est manquant ou marqué UNAVAILABLE_DEFECT (échec de mesure, pas un
// vrai signal de mouvement — même discipline que le reste du rapport, cf. Mission 3).
function deriveMotionLevel(criteria: JudgeCriterionResult[]): MotionLevel | undefined {
  const motion = criteria.find((c) => c.name === 'motionDynamism');
  if (!motion || motion.defect === UNAVAILABLE_DEFECT) return undefined;
  return classifyMotionLevel(motion.score);
}

function classifyDefects(criteria: JudgeCriterionResult[]): { critique: JudgeCriterionResult[]; important: JudgeCriterionResult[]; mineur: JudgeCriterionResult[] } {
  const withDefect = criteria.filter((c) => Boolean(c.defect));
  const critique: JudgeCriterionResult[] = [];
  const important: JudgeCriterionResult[] = [];
  const mineur: JudgeCriterionResult[] = [];
  for (const c of withDefect) {
    const severity = computeSeverity(c.score);
    if (severity === 'CRITIQUE') critique.push(c);
    else if (severity === 'IMPORTANT') important.push(c);
    else mineur.push(c);
  }
  return { critique, important, mineur };
}

function rankDefectNames(criteria: JudgeCriterionResult[]): JudgeCriterionName[] {
  const withDefect = criteria.filter((c) => Boolean(c.defect));
  return [...withDefect]
    .sort((a, b) => computePriority({ criterion: b.name, score: b.score, strategy: classifyRepair(b.name) }) - computePriority({ criterion: a.name, score: a.score, strategy: classifyRepair(a.name) }))
    .map((c) => c.name);
}
