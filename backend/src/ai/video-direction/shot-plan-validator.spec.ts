import { validateShotPlan } from './shot-plan-validator';
import { Shot, ShotPlan } from './video-director.service';

function buildShot(overrides: Partial<Shot> = {}): Shot {
  return { sceneId: 'shot-1', camera: 'travelling avant', subject: 'produit', motion: 'rotation lente', lighting: 'douce', background: 'studio', ...overrides };
}

describe('validateShotPlan', () => {
  it('plan valide (bon nombre de plans, champs requis présents, CTA présent, durée plausible) : passed=true', () => {
    const shotPlan: ShotPlan = [
      buildShot({ sceneId: 'shot-1', duration: 6 }),
      buildShot({ sceneId: 'shot-2', duration: 6, onScreenText: 'Découvrez maintenant' }),
    ];

    const result = validateShotPlan(shotPlan, { shotCount: 2 });

    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('mauvais nombre de plans : passed=false avec une raison mentionnant le compte', () => {
    const shotPlan: ShotPlan = [buildShot({ sceneId: 'shot-1', onScreenText: 'CTA' })];

    const result = validateShotPlan(shotPlan, { shotCount: 3 });

    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('nombre de plans'))).toBe(true);
  });

  it('un plan avec un champ requis manquant (camera vide) : passed=false, sceneId cité', () => {
    const shotPlan: ShotPlan = [
      buildShot({ sceneId: 'shot-1', camera: '', onScreenText: 'CTA' }),
      buildShot({ sceneId: 'shot-2' }),
    ];

    const result = validateShotPlan(shotPlan, { shotCount: 2 });

    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('shot-1'))).toBe(true);
  });

  it("aucun plan ne porte de texte à l'écran ni de voix off : passed=false", () => {
    const shotPlan: ShotPlan = [buildShot({ sceneId: 'shot-1' }), buildShot({ sceneId: 'shot-2' })];

    const result = validateShotPlan(shotPlan, { shotCount: 2 });

    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('appel à l\'action'))).toBe(true);
  });

  it('durée totale aberrante (trop longue) : passed=false', () => {
    const shotPlan: ShotPlan = [buildShot({ sceneId: 'shot-1', duration: 200, onScreenText: 'CTA' })];

    const result = validateShotPlan(shotPlan, { shotCount: 1 });

    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('durée totale'))).toBe(true);
  });

  it('plan vide : passed=false immédiatement, sans autre vérification', () => {
    const result = validateShotPlan([], { shotCount: 3 });

    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual(['le plan de tournage est vide']);
    expect(result.warnings).toEqual([]);
  });

  it('plan structurellement valide mais contenant un gabarit générique de repli (usedFallbackTemplate) : passed=true, warning explicite citant le sceneId (audit forensique Mission 4.2, P0-2)', () => {
    const shotPlan: ShotPlan = [
      buildShot({ sceneId: 'shot-1', onScreenText: 'CTA' }),
      buildShot({ sceneId: 'shot-2', usedFallbackTemplate: true }),
    ];

    const result = validateShotPlan(shotPlan, { shotCount: 2 });

    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('shot-2');
  });

  it('aucun plan de repli utilisé : warnings vide', () => {
    const shotPlan: ShotPlan = [buildShot({ sceneId: 'shot-1', onScreenText: 'CTA' })];

    const result = validateShotPlan(shotPlan, { shotCount: 1 });

    expect(result.warnings).toEqual([]);
  });
});
