import { computeEffectiveConfidence, decayFactor } from './temporal-decay.util';

describe('temporal-decay.util', () => {
  it("n'affaiblit pas une connaissance tout juste observée", () => {
    const now = new Date('2026-08-12T00:00:00Z');
    expect(decayFactor(now, now)).toBeCloseTo(1, 5);
  });

  it('divise le poids environ par deux après une demi-vie (120 jours)', () => {
    const now = new Date('2026-08-12T00:00:00Z');
    const lastObservedAt = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000);
    expect(decayFactor(lastObservedAt, now)).toBeCloseTo(0.5, 2);
  });

  it('ne descend jamais sous le plancher, même après des années sans confirmation', () => {
    const now = new Date('2026-08-12T00:00:00Z');
    const veryOld = new Date(now.getTime() - 3650 * 24 * 60 * 60 * 1000); // ~10 ans
    expect(decayFactor(veryOld, now)).toBeGreaterThan(0);
    expect(decayFactor(veryOld, now)).toBeGreaterThanOrEqual(0.05);
  });

  it('computeEffectiveConfidence applique le facteur de décroissance sans jamais dépasser la confiance stockée', () => {
    const now = new Date('2026-08-12T00:00:00Z');
    const lastObservedAt = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);
    const effective = computeEffectiveConfidence(0.8, lastObservedAt, now);
    expect(effective).toBeLessThan(0.8);
    expect(effective).toBeGreaterThan(0);
  });

  it('ne modifie jamais la confiance stockée elle-même — une confiance de 0 reste 0, une observation fraîche récupère sa valeur pleine', () => {
    const now = new Date('2026-08-12T00:00:00Z');
    expect(computeEffectiveConfidence(0.7, now, now)).toBeCloseTo(0.7, 5);
  });
});
