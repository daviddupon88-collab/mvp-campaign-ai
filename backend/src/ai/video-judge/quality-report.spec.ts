import { buildQualityReport, computeTimeBudgetStatus } from './quality-report';
import { QualityLoopOutcome } from './video-quality-loop.service';
import { VideoJudgeResult, UNAVAILABLE_DEFECT } from './video-judge.types';

function buildJudge(criteria: { name: string; score: number; defect?: string; justification?: string }[], globalScore: number): VideoJudgeResult {
  return {
    criteria: criteria.map((c) => ({ name: c.name as any, score: c.score, justification: c.justification ?? 'x', defect: c.defect })),
    globalScore,
    visualQuality: { score: globalScore, criteria: [] },
    advertisingEffectiveness: { score: globalScore, criteria: [] },
    verdict: 'REPAIR_REQUIRED',
  };
}

const FINALIZED = { status: 'assembled' as const, buffer: Buffer.from('x'), mimeType: 'video/mp4' as const, durationSeconds: 10 };

describe('buildQualityReport', () => {
  it('PASSED avec lastJudge=null (mode mock/narration indisponible) : statut SKIPPED_NO_VIDEO', () => {
    const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: null, attempts: [], transcript: null };

    const report = buildQualityReport(outcome);

    expect(report.statut).toBe('SKIPPED_NO_VIDEO');
    expect(report.actionRecommandee).toBe('AUCUNE');
  });

  it('PASSED avec un vrai jugement : statut PASSED, meilleurScore = score du jugement final, aucune action recommandée', () => {
    const judge = buildJudge([{ name: 'productConsistency', score: 90 }], 85);
    const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

    const report = buildQualityReport(outcome);

    expect(report.statut).toBe('PASSED');
    expect(report.meilleurScore).toBe(85);
    expect(report.actionRecommandee).toBe('AUCUNE');
  });

  it("REPAIR_EXHAUSTED avec un ECHEC dans l'historique : actionRecommandee=ESCALADE_STORYBOARD_RECOMMANDEE, causeRacine cite le défaut critique, defauts classés par sévérité", () => {
    const judge = buildJudge(
      [
        { name: 'productConsistency', score: 30, defect: 'produit méconnaissable', justification: 'produit méconnaissable' },
        { name: 'grammar', score: 65, defect: 'petite faute' },
      ],
      40,
    );
    const outcome: QualityLoopOutcome = {
      status: 'REPAIR_EXHAUSTED',
      lastJudge: judge,
      attempts: [{ attempt: 1, judge, repairsApplied: [{ criterion: 'productConsistency' as any, strategy: 'CLIP_REGEN', sceneId: 'shot-2', reason: 'x' }] }],
      bestAttempt: { judge, attemptNumber: 1 },
      history: [{ criterion: 'productConsistency' as any, sceneId: 'shot-2', strategy: 'CLIP_REGEN', scoreDelta: -10, outcome: 'ECHEC' }],
    };

    const report = buildQualityReport(outcome);

    expect(report.statut).toBe('REPAIR_EXHAUSTED');
    expect(report.actionRecommandee).toBe('ESCALADE_STORYBOARD_RECOMMANDEE');
    expect(report.causeRacine).toBe('produit méconnaissable');
    expect(report.defauts.critique).toHaveLength(1);
    expect(report.defauts.mineur).toHaveLength(1); // grammar à 65 (>=62) est MINEUR
    expect(report.gainReel).toBe(-10);
    expect(report.meilleurScore).toBe(40);
  });

  it("REPAIR_EXHAUSTED sans ECHEC dans l'historique : actionRecommandee=RETRY_LOCAL (pas d'escalade prématurée)", () => {
    const judge = buildJudge([{ name: 'productConsistency', score: 30, defect: 'x', justification: 'x' }], 40);
    const outcome: QualityLoopOutcome = {
      status: 'REPAIR_EXHAUSTED',
      lastJudge: judge,
      attempts: [{ attempt: 1, judge, repairsApplied: [{ criterion: 'productConsistency' as any, strategy: 'CLIP_REGEN', sceneId: 'shot-2', reason: 'x' }] }],
      bestAttempt: { judge, attemptNumber: 1 },
      history: [{ criterion: 'productConsistency' as any, sceneId: 'shot-2', strategy: 'CLIP_REGEN', scoreDelta: 8, outcome: 'SIGNIFICANT' }],
    };

    const report = buildQualityReport(outcome);

    expect(report.actionRecommandee).toBe('RETRY_LOCAL');
  });

  it('bestAttempt différent du dernier jugement : meilleurScore reflète bestAttempt, pas outcome.lastJudge', () => {
    const bestJudge = buildJudge([{ name: 'productConsistency', score: 80 }], 70);
    const lastJudge = buildJudge([{ name: 'productConsistency', score: 40, defect: 'x' }], 45);
    const outcome: QualityLoopOutcome = {
      status: 'REPAIR_EXHAUSTED',
      lastJudge,
      attempts: [{ attempt: 1, judge: bestJudge, repairsApplied: [] }, { attempt: 2, judge: lastJudge, repairsApplied: [], reverted: true }],
      bestAttempt: { judge: bestJudge, attemptNumber: 1 },
      history: [],
    };

    const report = buildQualityReport(outcome);

    expect(report.meilleurScore).toBe(70);
    expect(report.risqueDeRegression).toBe(true);
  });

  describe('Phase Q — totalGenerations / totalRepairs', () => {
    it('SKIPPED_NO_VIDEO : totalGenerations=0, totalRepairs=0 (rien n\'a été jugé)', () => {
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: null, attempts: [], transcript: null };
      const report = buildQualityReport(outcome);
      expect(report.totalGenerations).toBe(0);
      expect(report.totalRepairs).toBe(0);
    });

    it('PASSED au 1er jugement (aucune réparation) : totalGenerations=1 (génération initiale seule), totalRepairs=0', () => {
      const judge = buildJudge([{ name: 'productConsistency', score: 90 }], 85);
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };
      const report = buildQualityReport(outcome);
      expect(report.totalGenerations).toBe(1);
      expect(report.totalRepairs).toBe(1); // numeroDuCycle = attempts.length, même sans réparation appliquée
    });

    it('2 CLIP_REGEN appliqués sur 2 tentatives : totalGenerations=3 (1 initiale + 2 CLIP_REGEN)', () => {
      const judge = buildJudge([{ name: 'motionDynamism', score: 40, defect: 'x' }], 50);
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge,
        attempts: [
          { attempt: 1, judge, repairsApplied: [{ criterion: 'motionDynamism' as any, strategy: 'CLIP_REGEN', sceneId: 'shot-1', reason: 'x' }] },
          { attempt: 2, judge, repairsApplied: [{ criterion: 'motionDynamism' as any, strategy: 'CLIP_REGEN', sceneId: 'shot-1', reason: 'x' }] },
        ],
        bestAttempt: { judge, attemptNumber: 2 },
        history: [],
      };
      const report = buildQualityReport(outcome);
      expect(report.totalGenerations).toBe(3);
      expect(report.totalRepairs).toBe(2);
    });

    it('SUBTITLE_ONLY/AUDIO_REGEN appliqués (aucun CLIP_REGEN) : totalGenerations reste à 1 (aucun clip vidéo régénéré)', () => {
      const judge = buildJudge([{ name: 'grammar', score: 40, defect: 'x' }], 50);
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge,
        attempts: [{ attempt: 1, judge, repairsApplied: [{ criterion: 'grammar' as any, strategy: 'SUBTITLE_ONLY', reason: 'x' }] }],
        bestAttempt: { judge, attemptNumber: 1 },
        history: [],
      };
      const report = buildQualityReport(outcome);
      expect(report.totalGenerations).toBe(1);
      expect(report.totalRepairs).toBe(1);
    });
  });

  describe('Phase Q — computeTimeBudgetStatus', () => {
    it('ON_TRACK sous 70% du budget', () => {
      expect(computeTimeBudgetStatus(1000, 10_000)).toBe('ON_TRACK');
    });

    it('AT_RISK entre 70% et 100% du budget', () => {
      expect(computeTimeBudgetStatus(7_000, 10_000)).toBe('AT_RISK');
      expect(computeTimeBudgetStatus(9_999, 10_000)).toBe('AT_RISK');
    });

    it('TIME_BUDGET_EXCEEDED dès 100% du budget atteint ou dépassé', () => {
      expect(computeTimeBudgetStatus(10_000, 10_000)).toBe('TIME_BUDGET_EXCEEDED');
      expect(computeTimeBudgetStatus(15_000, 10_000)).toBe('TIME_BUDGET_EXCEEDED');
    });
  });

  describe('Mission 4 Phase C — motionLevel dérivé de motionDynamism', () => {
    it('PASSED avec motionDynamism sain : motionLevel dérivé du score (bande nommée, pas le chiffre brut)', () => {
      const judge = buildJudge([{ name: 'motionDynamism', score: 90 }], 90);
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.motionLevel).toBe('HIGH');
    });

    it('REPAIR_EXHAUSTED avec motionDynamism bas : motionLevel dérivé du bestAttempt', () => {
      const judge = buildJudge([{ name: 'motionDynamism', score: 10, defect: 'quasi figé' }], 40);
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge,
        attempts: [{ attempt: 1, judge, repairsApplied: [] }],
        bestAttempt: { judge, attemptNumber: 1 },
        history: [],
      };

      const report = buildQualityReport(outcome);

      expect(report.motionLevel).toBe('STATIC');
    });

    it('motionDynamism marqué UNAVAILABLE_DEFECT (échec de mesure) : motionLevel absent, jamais dérivé d\'un score sans signification', () => {
      const judge = buildJudge([{ name: 'motionDynamism', score: 50, defect: UNAVAILABLE_DEFECT }], 50);
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.motionLevel).toBeUndefined();
    });

    it('critère motionDynamism absent des criteria : motionLevel absent, ne plante pas', () => {
      const judge = buildJudge([{ name: 'productConsistency', score: 90 }], 90);
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.motionLevel).toBeUndefined();
    });
  });

  describe('Mission 4 — Rapport multi-composants (componentScores)', () => {
    it('TEST 13 (Correction 4) — musicScore.status est TOUJOURS UNAVAILABLE (aucun critère musique implémenté), jamais un score inventé', () => {
      const judge = buildJudge([{ name: 'productConsistency', score: 90 }], 90);
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.componentScores?.musicScore).toEqual({ status: 'UNAVAILABLE', reason: 'NO_MUSIC_CRITERION_IMPLEMENTED' });
      // TypeScript empêche `report.componentScores.musicScore.score` sans discriminer `status`
      // d'abord (le type MusicScore n'expose `score` que sur la branche AVAILABLE) — vérifié à
      // la compilation, cf. video-judge/quality-report.ts.
    });

    it('videoScore/voiceScore/audioScore/subtitleScore : moyenne pondérée sur le sous-ensemble de critères concerné, critères UNAVAILABLE_DEFECT exclus', () => {
      const judge = buildJudge(
        [
          { name: 'productConsistency', score: 80 },
          { name: 'formatCompliance', score: 100 },
          { name: 'voiceDynamism', score: 60 },
          { name: 'voiceAudibility', score: 90 },
          { name: 'audioQuality', score: 70 },
          { name: 'textReadability', score: 50 },
          // Marqué UNAVAILABLE_DEFECT : ne doit JAMAIS entrer dans la moyenne voiceScore.
          { name: 'voicePacing', score: 0, defect: UNAVAILABLE_DEFECT },
        ],
        75,
      );
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.componentScores?.videoScore).toBeGreaterThan(0);
      expect(report.componentScores?.voiceScore).toBeGreaterThan(0);
      // voicePacing (score 0, UNAVAILABLE_DEFECT) exclu -> voiceScore reflète UNIQUEMENT
      // voiceDynamism(60)/voiceAudibility(90), jamais tiré vers 0 par le critère indisponible.
      expect(report.componentScores?.voiceScore).toBeGreaterThan(50);
      expect(report.componentScores?.audioScore).toBe(70); // 1 seul critère dans ce groupe -> égal à son score
      expect(report.componentScores?.subtitleScore).toBe(50); // 1 seul critère présent (textReadability) dans ce groupe
    });

    it('aucun critère du groupe présent : repli neutre (50), jamais un plantage', () => {
      const judge = buildJudge([{ name: 'productConsistency', score: 90 }], 90);
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.componentScores?.subtitleScore).toBe(50); // aucun critère sous-titre dans ce jugement minimal
    });

    it('SKIPPED_NO_VIDEO : componentScores absent (rien n\'a été jugé)', () => {
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: null, attempts: [], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.componentScores).toBeUndefined();
    });
  });

  describe('Mission 4 — Repair log enrichi (repairLog)', () => {
    it('1 CLIP_REGEN appliqué : entrée avec repairScope=SCENE_ONLY, rootCause dérivé, beforeScore/afterScore mesurés, estimatedCost non nul', () => {
      const judge1 = buildJudge([{ name: 'motionDynamism', score: 30, defect: 'trop statique' }], 40);
      const judge2 = buildJudge([{ name: 'motionDynamism', score: 85 }], 85);
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge2,
        attempts: [
          { attempt: 1, judge: judge1, repairsApplied: [{ criterion: 'motionDynamism' as any, strategy: 'CLIP_REGEN', sceneId: 'shot-2', reason: 'trop statique' }] },
          { attempt: 2, judge: judge2, repairsApplied: [] },
        ],
        bestAttempt: { judge: judge2, attemptNumber: 2 },
        history: [],
      };

      const report = buildQualityReport(outcome);

      expect(report.repairLog).toHaveLength(1);
      const entry = report.repairLog![0];
      expect(entry.criterion).toBe('motionDynamism');
      expect(entry.repairScope).toBe('SCENE_ONLY');
      expect(entry.beforeScore).toBe(30);
      expect(entry.afterScore).toBe(85);
      expect(entry.estimatedCost).toBeGreaterThan(0);
    });

    it('1 SUBTITLE_ONLY appliqué : repairScope=SCENE_GROUP (portée globale, pas de scène)', () => {
      const judge1 = buildJudge([{ name: 'grammar', score: 40, defect: 'faute' }], 50);
      const judge2 = buildJudge([{ name: 'grammar', score: 90 }], 90);
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge2,
        attempts: [
          { attempt: 1, judge: judge1, repairsApplied: [{ criterion: 'grammar' as any, strategy: 'SUBTITLE_ONLY', reason: 'faute' }] },
          { attempt: 2, judge: judge2, repairsApplied: [] },
        ],
        bestAttempt: { judge: judge2, attemptNumber: 2 },
        history: [],
      };

      const report = buildQualityReport(outcome);

      expect(report.repairLog![0].repairScope).toBe('SCENE_GROUP');
      expect(report.repairLog![0].beforeScore).toBe(40);
      expect(report.repairLog![0].afterScore).toBe(90);
    });

    it('aucune réparation appliquée : repairLog vide, jamais un plantage', () => {
      const judge = buildJudge([{ name: 'productConsistency', score: 90 }], 90);
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.repairLog).toEqual([]);
    });

    it('SKIPPED_NO_VIDEO : repairLog absent (rien n\'a été jugé, rien n\'a pu être réparé)', () => {
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: null, attempts: [], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.repairLog).toBeUndefined();
    });

    it("n'invente jamais de coût : estimatedCost dérive UNIQUEMENT de CREDIT_COSTS (repair-priority.ts::strategyCost), jamais un chiffre différent entre AUDIO_REGEN et CLIP_REGEN par hasard", () => {
      const judge1 = buildJudge([{ name: 'audioQuality', score: 30, defect: 'x' }], 40);
      const judge2 = buildJudge([{ name: 'audioQuality', score: 90 }], 90);
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge2,
        attempts: [
          { attempt: 1, judge: judge1, repairsApplied: [{ criterion: 'audioQuality' as any, strategy: 'AUDIO_REGEN', reason: 'x' }] },
          { attempt: 2, judge: judge2, repairsApplied: [] },
        ],
        bestAttempt: { judge: judge2, attemptNumber: 2 },
        history: [],
      };

      const report = buildQualityReport(outcome);

      // AUDIO_REGEN (generateAudio, quelques crédits) doit rester nettement moins cher qu'un
      // CLIP_REGEN complet (150 crédits/plan, cf. TEST économique) — vérifié via le rapport lui-même.
      expect(report.repairLog![0].estimatedCost).toBeLessThan(150);
    });
  });

  describe('Audit forensic (campagne 83cbcd41) — mostSevereDefect (indépendant du coût de réparation)', () => {
    it("un défaut UNREPAIRABLE (storytelling, score 38) est désigné le plus sévère face à un défaut moins grave mais moins cher à réparer (pacing, score 48, SUBTITLE_ONLY) — reproduit exactement le cas réel de la campagne 83cbcd41", () => {
      // Reprend les scores réels de l'audit : storytelling(38, UNREPAIRABLE) est objectivement
      // plus grave que pacing(48, SUBTITLE_ONLY à 8 crédits), mais `ordreDePriorite` (pondéré par
      // computePriority, qui donne priorité 0 à un coût infini) plaçait pacing en tête — c'est
      // précisément le bug corrigé : `mostSevereDefect` doit ignorer le coût de réparation.
      const judge = buildJudge(
        [
          { name: 'storytelling', score: 38, defect: 'Voix off explicative et répétitive qui contredit le concept', justification: 'x' },
          { name: 'pacing', score: 48, defect: 'Surcharge informationnelle', justification: 'x' },
          { name: 'brandCoherence', score: 40, defect: 'Ton en décalage', justification: 'x' },
        ],
        60,
      );
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge,
        attempts: [{ attempt: 1, judge, repairsApplied: [] }],
        bestAttempt: { judge, attemptNumber: 1 },
        history: [],
      };

      const report = buildQualityReport(outcome);

      // Confirme le bug historique : ordreDePriorite[0] reste "pacing" (le moins cher à réparer).
      expect(report.ordreDePriorite[0]).toBe('pacing');
      // Mais mostSevereDefect désigne bien le plus grave par score, peu importe la réparabilité.
      expect(report.mostSevereDefect?.name).toBe('storytelling');
      expect(report.mostSevereDefect?.score).toBe(38);
    });

    it('sans défaut CRITIQUE, replie sur le défaut IMPORTANT le plus bas', () => {
      const judge = buildJudge(
        [
          { name: 'hookStrength', score: 55, defect: 'x', justification: 'x' }, // IMPORTANT
          { name: 'ctaClarity', score: 58, defect: 'y', justification: 'y' }, // IMPORTANT
        ],
        56,
      );
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge,
        attempts: [{ attempt: 1, judge, repairsApplied: [] }],
        bestAttempt: { judge, attemptNumber: 1 },
        history: [],
      };

      const report = buildQualityReport(outcome);

      expect(report.mostSevereDefect?.name).toBe('hookStrength'); // 55 < 58
    });

    it('sans défaut CRITIQUE ni IMPORTANT, replie sur le défaut MINEUR le plus bas', () => {
      const judge = buildJudge([{ name: 'grammar', score: 65, defect: 'faute', justification: 'x' }], 65);
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge,
        attempts: [{ attempt: 1, judge, repairsApplied: [] }],
        bestAttempt: { judge, attemptNumber: 1 },
        history: [],
      };

      const report = buildQualityReport(outcome);

      expect(report.mostSevereDefect?.name).toBe('grammar');
    });

    it('aucun défaut du tout : mostSevereDefect est null, ne plante pas', () => {
      const judge = buildJudge([{ name: 'productConsistency', score: 90, justification: 'ok' }], 90);
      const outcome: QualityLoopOutcome = {
        status: 'REPAIR_EXHAUSTED',
        lastJudge: judge,
        attempts: [{ attempt: 1, judge, repairsApplied: [] }],
        bestAttempt: { judge, attemptNumber: 1 },
        history: [],
      };

      const report = buildQualityReport(outcome);

      expect(report.mostSevereDefect).toBeNull();
    });

    it('PASSED : mostSevereDefect est absent (jamais consulté par tryEscalate dans ce cas)', () => {
      const judge = buildJudge([{ name: 'productConsistency', score: 90, justification: 'ok' }], 90);
      const outcome: QualityLoopOutcome = { status: 'PASSED', finalized: FINALIZED, lastJudge: judge, attempts: [{ attempt: 1, judge, repairsApplied: [] }], transcript: null };

      const report = buildQualityReport(outcome);

      expect(report.mostSevereDefect).toBeUndefined();
    });
  });
});
