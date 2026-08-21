import { classifySceneRisk, computeGenerationPriority, sortByGenerationPriority } from './shot-risk';
import { Shot, ShotPlan, isShotStructurallyValid } from './video-director.service';

function buildShot(overrides: Partial<Shot> = {}): Shot {
  return { sceneId: 'shot-1', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', ...overrides };
}

describe('classifySceneRisk', () => {
  it('plan simple, produit statique sans signal de complexité : FAIBLE', () => {
    const shot = buildShot({ action: 'the product sits on a table', motion: 'slow rotation' });

    expect(classifySceneRisk(shot)).toBe('FAIBLE');
  });

  it('un seul signal (plusieurs personnages via characters) : MOYEN', () => {
    const shot = buildShot({ characters: 'a man and a woman' });

    expect(classifySceneRisk(shot)).toBe('MOYEN');
  });

  it('cumul de signaux (interaction complexe + transformation + synchronisation labiale) : ÉLEVÉ', () => {
    const shot = buildShot({ action: 'a character talks to the camera while the product transforms and hands interact with it' });

    expect(classifySceneRisk(shot)).toBe('ÉLEVÉ');
  });

  it("texte à l'écran long (>60 caractères) : compte comme un signal de risque", () => {
    const shot = buildShot({ onScreenText: 'Ceci est un texte à l\'écran volontairement très long pour dépasser le seuil de risque défini' });

    expect(classifySceneRisk(shot)).toBe('MOYEN');
  });
});

describe('computeGenerationPriority / sortByGenerationPriority', () => {
  it('hook > démonstration/produit > CTA/payoff > secondaire', () => {
    const hook = buildShot({ sceneId: 'hook', narrativeRole: 'hook' });
    const demo = buildShot({ sceneId: 'demo', narrativeRole: 'demonstration of the benefit' });
    const payoff = buildShot({ sceneId: 'payoff', narrativeRole: 'payoff / brand recall' });
    const secondary = buildShot({ sceneId: 'secondary', narrativeRole: 'establishing shot' });

    expect(computeGenerationPriority(hook)).toBeGreaterThan(computeGenerationPriority(demo));
    expect(computeGenerationPriority(demo)).toBeGreaterThan(computeGenerationPriority(payoff));
    expect(computeGenerationPriority(payoff)).toBeGreaterThan(computeGenerationPriority(secondary));
  });

  it('sortByGenerationPriority réordonne le plan (hook en premier) sans muter le tableau original', () => {
    const secondary = buildShot({ sceneId: 'shot-1', narrativeRole: 'establishing shot' });
    const hook = buildShot({ sceneId: 'shot-2', narrativeRole: 'hook' });
    const original: ShotPlan = [secondary, hook];

    const sorted = sortByGenerationPriority(original);

    expect(sorted.map((s) => s.sceneId)).toEqual(['shot-2', 'shot-1']);
    expect(original.map((s) => s.sceneId)).toEqual(['shot-1', 'shot-2']); // original inchangé
  });
});

describe('Phase N — contrat de scène enrichi (additif à Shot)', () => {
  it('isShotStructurallyValid reste vrai sur un Shot sans les nouveaux champs (non-régression)', () => {
    const shot = buildShot();
    expect(isShotStructurallyValid(shot)).toBe(true);
  });

  it('isShotStructurallyValid reste vrai sur un Shot avec tous les nouveaux champs renseignés', () => {
    const shot = buildShot({
      dependencies: ['shot-0'],
      priority: 'P0',
      riskLevel: 'FAIBLE',
      generationStatus: 'SUCCEEDED',
      validationStatus: 'PASSED',
      qualityScore: 88,
    });
    expect(isShotStructurallyValid(shot)).toBe(true);
  });

  it('classifySceneRisk et computeGenerationPriority ignorent les nouveaux champs (compatibilité Phase I inchangée)', () => {
    const withNewFields = buildShot({ narrativeRole: 'hook', dependencies: ['shot-0'], priority: 'P0', generationStatus: 'PENDING' });
    const without = buildShot({ narrativeRole: 'hook' });

    expect(classifySceneRisk(withNewFields)).toBe(classifySceneRisk(without));
    expect(computeGenerationPriority(withNewFields)).toBe(computeGenerationPriority(without));
  });

  it('sortByGenerationPriority reste stable et compatible sur un plan mêlant Shots enrichis et non enrichis', () => {
    const legacy = buildShot({ sceneId: 'legacy', narrativeRole: 'establishing shot' });
    const enriched = buildShot({ sceneId: 'enriched', narrativeRole: 'hook', dependencies: [], priority: 'P0' });
    const sorted = sortByGenerationPriority([legacy, enriched]);

    expect(sorted.map((s) => s.sceneId)).toEqual(['enriched', 'legacy']);
  });
});
