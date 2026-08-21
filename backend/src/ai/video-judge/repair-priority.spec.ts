import { computeSeverity, computePriority, rankDefects, isRepairAllowedForSeverity, computeExpectedValue, shouldRegenerate, MIN_EXPECTED_VALUE, strategyCost } from './repair-priority';
import { PASS_THRESHOLD } from './video-judge.service';
import { CREDIT_COSTS } from '../../plans/plan-catalog';

describe('computeSeverity', () => {
  it('score=49 (sous le plancher critique 50) : CRITIQUE', () => expect(computeSeverity(49)).toBe('CRITIQUE'));
  it('score=50 (plancher critique inclus dans IMPORTANT) : IMPORTANT', () => expect(computeSeverity(50)).toBe('IMPORTANT'));
  it('score=61 (juste sous le seuil de passage 62) : IMPORTANT', () => expect(computeSeverity(61)).toBe('IMPORTANT'));
  it('score=62 (seuil de passage inclus) : MINEUR', () => expect(computeSeverity(62)).toBe('MINEUR'));
  it('score=95 : MINEUR', () => expect(computeSeverity(95)).toBe('MINEUR'));
});

describe('computePriority / rankDefects', () => {
  it('un défaut CRITIQUE à poids élevé et stratégie bon marché passe avant un défaut MINEUR à poids faible et stratégie coûteuse', () => {
    const critical = { criterion: 'productConsistency' as any, score: 30, strategy: 'SUBTITLE_ONLY' as const }; // poids 12, CRITIQUE, coût 8
    const minor = { criterion: 'grammar' as any, score: 90, strategy: 'CLIP_REGEN' as const }; // poids 2, MINEUR, coût 150 (hypothétique, pour l'ordre)

    const ranked = rankDefects([minor, critical]);

    expect(ranked[0]).toBe(critical);
  });

  it('critère publicitaire (bonus 1.5x) prioritaire sur un critère visuel de poids identique, à sévérité et stratégie égales', () => {
    const advertising = { criterion: 'hookStrength' as any, score: 40, strategy: 'AUDIO_REGEN' as const }; // poids 8, publicitaire
    const visual = { criterion: 'brandCoherence' as any, score: 40, strategy: 'AUDIO_REGEN' as const }; // poids 7, visuel — poids légèrement différent, mais l'écart de multiplicateur doit dominer

    expect(computePriority(advertising)).toBeGreaterThan(computePriority(visual));
  });

  it('coût plus élevé réduit strictement la priorité, à poids/sévérité/impact égaux', () => {
    const cheap = { criterion: 'ctaClarity' as any, score: 40, strategy: 'AUDIO_REGEN' as const };
    const expensive = { criterion: 'ctaClarity' as any, score: 40, strategy: 'CLIP_REGEN' as const };

    expect(computePriority(cheap)).toBeGreaterThan(computePriority(expensive));
  });
});

describe('isRepairAllowedForSeverity', () => {
  it('MINEUR + CLIP_REGEN : false — jamais 150 crédits pour un défaut mineur', () => {
    expect(isRepairAllowedForSeverity('MINEUR', 'CLIP_REGEN')).toBe(false);
  });

  it('MINEUR + AUDIO_REGEN : false — même un correctif bon marché reste exclu pour un défaut mineur', () => {
    expect(isRepairAllowedForSeverity('MINEUR', 'AUDIO_REGEN')).toBe(false);
  });

  it('MINEUR + SUBTITLE_ONLY : true — seul le correctif quasi gratuit reste éligible', () => {
    expect(isRepairAllowedForSeverity('MINEUR', 'SUBTITLE_ONLY')).toBe(true);
  });

  it('CRITIQUE + CLIP_REGEN : true — jamais bloqué pour un défaut critique, quel que soit le coût', () => {
    expect(isRepairAllowedForSeverity('CRITIQUE', 'CLIP_REGEN')).toBe(true);
  });

  it('IMPORTANT + CLIP_REGEN : true', () => {
    expect(isRepairAllowedForSeverity('IMPORTANT', 'CLIP_REGEN')).toBe(true);
  });
});

describe('computeExpectedValue', () => {
  it('décroît strictement quand attemptsRemaining décroît, à priorité égale (pénalise les cycles tardifs)', () => {
    const high = computeExpectedValue({ priority: 1, attemptsRemaining: 2, currentScore: 90, hasCriticalDefect: false });
    const mid = computeExpectedValue({ priority: 1, attemptsRemaining: 1, currentScore: 90, hasCriticalDefect: false });
    const low = computeExpectedValue({ priority: 1, attemptsRemaining: 0, currentScore: 90, hasCriticalDefect: false });

    expect(high).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(low);
  });

  it('reste strictement positif même à 0 tentative restante (la priorité brute seule reste le signal)', () => {
    expect(computeExpectedValue({ priority: 1, attemptsRemaining: 0, currentScore: 90, hasCriticalDefect: false })).toBeGreaterThan(0);
  });
});

describe('shouldRegenerate', () => {
  it('REGENERATE toujours si un défaut critique est présent, même score élevé et gain attendu nul', () => {
    const result = shouldRegenerate({ priority: 0, attemptsRemaining: 0, currentScore: 99, hasCriticalDefect: true });
    expect(result.decision).toBe('REGENERATE');
  });

  it('DO_NOT_REGENERATE si le score est déjà au seuil de passage, aucun défaut critique, et le gain attendu est faible', () => {
    const result = shouldRegenerate({ priority: 0.1, attemptsRemaining: 1, currentScore: PASS_THRESHOLD + 13, hasCriticalDefect: false });
    expect(computeExpectedValue({ priority: 0.1, attemptsRemaining: 1, currentScore: 0, hasCriticalDefect: false })).toBeLessThan(MIN_EXPECTED_VALUE);
    expect(result.decision).toBe('DO_NOT_REGENERATE');
  });

  it('REGENERATE si le score est déjà au seuil de passage mais le gain attendu reste élevé', () => {
    const result = shouldRegenerate({ priority: 5, attemptsRemaining: 2, currentScore: PASS_THRESHOLD, hasCriticalDefect: false });
    expect(computeExpectedValue({ priority: 5, attemptsRemaining: 2, currentScore: 0, hasCriticalDefect: false })).toBeGreaterThanOrEqual(MIN_EXPECTED_VALUE);
    expect(result.decision).toBe('REGENERATE');
  });

  it('REGENERATE si le score est encore sous le seuil de passage, quel que soit le gain attendu', () => {
    const result = shouldRegenerate({ priority: 0.01, attemptsRemaining: 0, currentScore: PASS_THRESHOLD - 1, hasCriticalDefect: false });
    expect(result.decision).toBe('REGENERATE');
  });
});

// Mission 4 — Test économique (section 22 du spec) : comparaison des constantes CREDIT_COSTS
// RÉELLES (plan-catalog.ts), jamais une mesure inventée — vérifie que la réparation ciblée
// (AUDIO_REGEN/SUBTITLE_ONLY) conserve bien l'avantage économique attendu face à une
// régénération complète de plan (CLIP_REGEN).
describe('Mission 4 — strategyCost (test économique, section 22 du spec)', () => {
  it("AUDIO_REGEN (générer la voix seule) coûte la MÊME chose, que le défaut soit voiceDynamism/voicePacing (Mission 4) ou audioQuality/voiceAudibility (existant) — un seul tarif generateAudio, jamais dupliqué", () => {
    expect(strategyCost('AUDIO_REGEN')).toBe(CREDIT_COSTS.campaign_generation.generateAudio);
  });

  it('CLIP_REGEN (régénérer un plan vidéo complet) coûte le tarif generateVideo réel', () => {
    expect(strategyCost('CLIP_REGEN')).toBe(CREDIT_COSTS.campaign_generation.generateVideo);
  });

  it('SUBTITLE_ONLY coûte le tarif generateText réel', () => {
    expect(strategyCost('SUBTITLE_ONLY')).toBe(CREDIT_COSTS.campaign_generation.generateText);
  });

  it("UNREPAIRABLE a un coût infini par construction (jamais sélectionné par une comparaison de coût)", () => {
    expect(strategyCost('UNREPAIRABLE')).toBe(Infinity);
  });

  it('AUDIO_REGEN reste NETTEMENT moins coûteux que CLIP_REGEN (au moins 10x) — la réparation ciblée conserve son avantage économique, même pour les nouveaux critères Mission 4 (voiceDynamism/voicePacing)', () => {
    const ratio = strategyCost('CLIP_REGEN') / strategyCost('AUDIO_REGEN');
    expect(ratio).toBeGreaterThanOrEqual(10);
  });

  it("SUBTITLE_ONLY reste NETTEMENT moins coûteux que CLIP_REGEN (au moins 10x)", () => {
    const ratio = strategyCost('CLIP_REGEN') / strategyCost('SUBTITLE_ONLY');
    expect(ratio).toBeGreaterThanOrEqual(10);
  });
});
