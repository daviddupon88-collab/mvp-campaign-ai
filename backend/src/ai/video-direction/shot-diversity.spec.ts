import { detectShotRepetition, shouldRegeneratePlan, buildAvoidRepetitionHint } from './shot-diversity';
import { Shot } from './video-director.service';

function shot(overrides: Partial<Shot> & { sceneId: string }): Shot {
  return { camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', ...overrides };
}

describe('detectShotRepetition', () => {
  it('aucune répétition (3 plans tous différents) : aucun avertissement', () => {
    const plan = [
      shot({ sceneId: 'shot-1', cameraShot: 'close-up', cameraMovement: 'push-in', action: 'holds the product' }),
      shot({ sceneId: 'shot-2', cameraShot: 'wide', cameraMovement: 'orbit', action: 'walks past the product' }),
      shot({ sceneId: 'shot-3', cameraShot: 'medium', cameraMovement: 'static', action: 'points at the product' }),
    ];

    expect(detectShotRepetition(plan)).toEqual([]);
  });

  it('2 plans partageant EXACTEMENT le même (cameraShot, cameraMovement, action) : 1 avertissement listant les 2 sceneId', () => {
    const plan = [
      shot({ sceneId: 'shot-1', cameraShot: 'close-up', cameraMovement: 'push-in', action: 'holds the product' }),
      shot({ sceneId: 'shot-2', cameraShot: 'close-up', cameraMovement: 'push-in', action: 'holds the product' }),
      shot({ sceneId: 'shot-3', cameraShot: 'wide', cameraMovement: 'orbit', action: 'walks past the product' }),
    ];

    const warnings = detectShotRepetition(plan);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sceneIds).toEqual(['shot-1', 'shot-2']);
  });

  it('normalisation : espaces/majuscules différents restent considérés comme identiques', () => {
    const plan = [
      shot({ sceneId: 'shot-1', cameraShot: 'Close-Up', cameraMovement: ' push-in ', action: 'Holds The Product' }),
      shot({ sceneId: 'shot-2', cameraShot: 'close-up', cameraMovement: 'push-in', action: 'holds the product' }),
    ];

    expect(detectShotRepetition(plan)).toHaveLength(1);
  });

  it("plans SANS ces champs (ancien format, tous vides) : jamais un faux positif de répétition", () => {
    const plan = [shot({ sceneId: 'shot-1' }), shot({ sceneId: 'shot-2' }), shot({ sceneId: 'shot-3' })];

    expect(detectShotRepetition(plan)).toEqual([]);
  });

  it('un seul champ différent (action différente) : ne compte pas comme répétition', () => {
    const plan = [
      shot({ sceneId: 'shot-1', cameraShot: 'close-up', cameraMovement: 'push-in', action: 'holds the product' }),
      shot({ sceneId: 'shot-2', cameraShot: 'close-up', cameraMovement: 'push-in', action: 'opens the product' }),
    ];

    expect(detectShotRepetition(plan)).toEqual([]);
  });
});

describe('shouldRegeneratePlan', () => {
  it('un groupe couvrant au moins la moitié des plans (2 sur 3) : régénération déclenchée', () => {
    const warnings = [{ sceneIds: ['shot-1', 'shot-2'], cameraShot: 'close-up', cameraMovement: 'push-in', action: 'x' }];
    expect(shouldRegeneratePlan(warnings, 3)).toBe(true);
  });

  it('un groupe couvrant moins de la moitié des plans (2 sur 5) : pas de régénération', () => {
    const warnings = [{ sceneIds: ['shot-1', 'shot-2'], cameraShot: 'close-up', cameraMovement: 'push-in', action: 'x' }];
    expect(shouldRegeneratePlan(warnings, 5)).toBe(false);
  });

  it('aucun avertissement : pas de régénération', () => {
    expect(shouldRegeneratePlan([], 3)).toBe(false);
  });
});

describe('buildAvoidRepetitionHint', () => {
  it('liste concrètement les combinaisons répétées, pas une consigne vague', () => {
    const hint = buildAvoidRepetitionHint([{ sceneIds: ['shot-1', 'shot-2'], cameraShot: 'close-up', cameraMovement: 'push-in', action: 'holds the product' }]);

    expect(hint).toContain('close-up');
    expect(hint).toContain('push-in');
    expect(hint).toContain('holds the product');
    expect(hint).toContain('2 plans identiques');
  });
});
