import { computeStdDev, classifyAcousticDynamics, scoreAcousticDynamics } from './acoustic-measurement';

describe('acoustic-measurement pure helpers (Mission 4 Phase D/E)', () => {
  describe('computeStdDev', () => {
    it('valeurs identiques -> écart-type 0', () => {
      expect(computeStdDev([-20, -20, -20])).toBe(0);
    });

    it('valeurs dispersées -> écart-type positif', () => {
      expect(computeStdDev([-20, -10, -30])).toBeCloseTo(8.16, 1);
    });
  });

  describe('classifyAcousticDynamics', () => {
    it('écart-type bas -> ACOUSTIC_DYNAMICS_LOW (jamais EMOTION_LOW)', () => {
      expect(classifyAcousticDynamics(0.5)).toBe('ACOUSTIC_DYNAMICS_LOW');
    });

    it('écart-type moyen -> ACOUSTIC_DYNAMICS_ADEQUATE', () => {
      expect(classifyAcousticDynamics(4)).toBe('ACOUSTIC_DYNAMICS_ADEQUATE');
    });

    it('écart-type haut -> ACOUSTIC_DYNAMICS_HIGH (jamais EMOTION_HIGH)', () => {
      expect(classifyAcousticDynamics(8)).toBe('ACOUSTIC_DYNAMICS_HIGH');
    });

    it('aucun état retourné ne contient jamais la chaîne EMOTION', () => {
      for (const stdDev of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]) {
        expect(classifyAcousticDynamics(stdDev)).not.toMatch(/EMOTION/);
      }
    });
  });

  describe('scoreAcousticDynamics', () => {
    it('à la référence (4 dB) : score maximal', () => {
      expect(scoreAcousticDynamics(4)).toBe(100);
    });

    it('sous la référence : score proportionnel', () => {
      expect(scoreAcousticDynamics(2)).toBe(50);
    });

    it('au-dessus de la référence : pénalisé mais jamais sous 40', () => {
      expect(scoreAcousticDynamics(20)).toBeGreaterThanOrEqual(40);
    });
  });
});
