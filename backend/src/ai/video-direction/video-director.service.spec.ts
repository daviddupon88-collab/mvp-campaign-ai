import { VideoDirectorService, DEFAULT_SHOT_PLAN, Shot } from './video-director.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { VisualDna } from './visual-dna.service';

function buildGatewayMock(generateTextContent: string) {
  return {
    generateText: jest.fn(async () => ({
      content: generateTextContent,
      provider: 'anthropic',
      model: 'claude',
      durationMs: 10,
    })),
  } as unknown as AiGatewayService;
}

const CTX = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };
const VISUAL_DNA: VisualDna = {
  productCategory: 'chaussures',
  colors: ['bleu'],
  materials: ['mesh'],
  shape: 'basse',
  distinctiveFeatures: [],
  logoOrBrandMarks: null,
  raw: '{}',
};

const SHOT: Shot = { camera: 'dolly-in', subject: 'product', motion: 'slow rotation', lighting: 'moving highlight', background: 'particles' };

describe('VideoDirectorService.generateShotPlan', () => {
  it('réponse avec exactement shotCount plans : mappés tels quels', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' }, 3);

    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual(SHOT);
  });

  it('réponse avec moins de plans que demandé : complétée depuis DEFAULT_SHOT_PLAN', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT]));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' }, 3);

    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual(SHOT);
    expect(plan[1]).toEqual(DEFAULT_SHOT_PLAN[1]);
    expect(plan[2]).toEqual(DEFAULT_SHOT_PLAN[2]);
  });

  it('une entrée malformée au milieu du tableau : comblée individuellement, le reste conservé', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, { camera: 'orbit' }, SHOT]));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' }, 3);

    expect(plan[0]).toEqual(SHOT);
    expect(plan[1]).toEqual(DEFAULT_SHOT_PLAN[1]);
    expect(plan[2]).toEqual(SHOT);
  });

  it('réponse non-JSON : repli intégral sur DEFAULT_SHOT_PLAN, ne lève jamais', async () => {
    const gateway = buildGatewayMock('Désolé, je ne peux pas générer de plan.');
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' }, 3);

    expect(plan).toEqual([DEFAULT_SHOT_PLAN[0], DEFAULT_SHOT_PLAN[1], DEFAULT_SHOT_PLAN[2]]);
  });

  it('réponse JSON valide mais pas un tableau : repli intégral sur DEFAULT_SHOT_PLAN', async () => {
    const gateway = buildGatewayMock(JSON.stringify({ not: 'an array' }));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' }, 3);

    expect(plan).toEqual([DEFAULT_SHOT_PLAN[0], DEFAULT_SHOT_PLAN[1], DEFAULT_SHOT_PLAN[2]]);
  });

  it('utilise bien le provider "anthropic" (raisonnement structuré), pas openai', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' }, 3);

    const [, , provider] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(provider).toBe('anthropic');
  });

  it('le prompt envoyé contient une ligne Objectif explicite (chantier prompts orientés objectif, 2026-08-18)', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(
      CTX,
      { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' },
      3,
    );

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Objectif de la campagne : Attirer des clients B2B');
  });

  // Chantier Storyboard (2026-08-18) : avant ce chantier, rien ne demandait à Claude de
  // concevoir un arc narratif entre les plans — 3 angles esthétiques indépendants, jamais une
  // vraie progression. Verrouille que le prompt demande explicitement l'arc + le champ
  // narrativeRole par plan.
  it("le prompt demande explicitement un arc narratif et le champ narrativeRole par plan (chantier Storyboard, 2026-08-18)", async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' }, 3);

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('arc narratif');
    expect(params.prompt).toContain('narrativeRole');
    expect(params.prompt).toContain('progression qui se répond');
  });

  it('shotCount personnalisé (ex: 1) est bien respecté', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT]));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, { visualDna: VISUAL_DNA, productDescription: 'x', objective: 'Attirer des clients B2B', campaignContext: 'y' }, 1);

    expect(plan).toHaveLength(1);
  });
});

describe('VideoDirectorService.serializeShotToPrompt', () => {
  const service = new VideoDirectorService({} as AiGatewayService);

  it('reproduit la structure littérale du gabarit cinématographique (7 lignes)', () => {
    const prompt = service.serializeShotToPrompt({
      camera: 'slow cinematic push-in',
      subject: 'product',
      motion: 'the product rotates slowly',
      lighting: 'a moving highlight sweeps across the product',
      background: 'subtle floating particles move through the scene',
    });

    expect(prompt).toBe(
      `Create a dynamic premium product commercial.
The product remains visually identical to the reference image.
Camera: slow cinematic push-in
Motion: the product rotates slowly
Environment: subtle floating particles move through the scene
Lighting: a moving highlight sweeps across the product
The movement must remain continuous throughout the entire shot.
Avoid a static camera and avoid a still-image effect.`,
    );
  });

  it('subject différent de "product" est intégré dans la ligne Camera', () => {
    const prompt = service.serializeShotToPrompt({
      camera: 'close-up',
      subject: 'logo',
      motion: 'slight push-in',
      lighting: 'a focused highlight on the logo',
      background: 'softly blurred product surface',
    });

    expect(prompt).toContain('Camera: close-up focused on the logo');
  });

  it('subject "product" (la valeur par défaut) ne modifie pas la ligne Camera', () => {
    const prompt = service.serializeShotToPrompt(SHOT);
    expect(prompt).toContain('Camera: dolly-in\n');
  });

  // Chantier Storyboard (2026-08-18) : ligne additive, jamais au prix du gabarit littéral figé.
  it('narrativeRole renseigné : ajoute une ligne de contexte narratif en tête, gabarit des 7 lignes inchangé', () => {
    const prompt = service.serializeShotToPrompt({ ...SHOT, narrativeRole: 'hook' });
    expect(prompt).toBe(
      `This shot is the "hook" beat of the commercial.
Create a dynamic premium product commercial.
The product remains visually identical to the reference image.
Camera: dolly-in
Motion: slow rotation
Environment: particles
Lighting: moving highlight
The movement must remain continuous throughout the entire shot.
Avoid a static camera and avoid a still-image effect.`,
    );
  });

  it('narrativeRole absent : sortie strictement identique à avant ce chantier (non-régression)', () => {
    const prompt = service.serializeShotToPrompt(SHOT);
    expect(prompt.startsWith('Create a dynamic premium product commercial.')).toBe(true);
    expect(prompt).not.toContain('beat of the commercial');
  });
});

describe('VideoDirectorService.repairShotPrompt', () => {
  const service = new VideoDirectorService({} as AiGatewayService);
  const PASSING = { passed: true, score: 90, reasons: [] };

  it('échec mouvement seul : ajoute une instruction de mouvement, pas de fidélité', () => {
    const prompt = service.repairShotPrompt(SHOT, {
      passed: false,
      qualityScore: 40,
      motionQuality: { passed: false, score: 20, reasons: ['quasi-statique'], freezeRatio: 0.5 },
      visualFidelity: { ...PASSING },
      reasons: ['quasi-statique'],
    });

    expect(prompt).toContain('too static');
    expect(prompt).not.toContain('did not accurately match');
    expect(prompt.startsWith(service.serializeShotToPrompt(SHOT))).toBe(true); // base inchangée, instructions ajoutées à la suite
  });

  it('échec fidélité seul : ajoute une instruction de fidélité incluant les raisons précises, pas de mouvement', () => {
    const prompt = service.repairShotPrompt(SHOT, {
      passed: false,
      qualityScore: 40,
      motionQuality: { ...PASSING, freezeRatio: 0 },
      visualFidelity: { passed: false, score: 30, reasons: ['couleur incorrecte', 'logo absent'] },
      reasons: ['couleur incorrecte', 'logo absent'],
    });

    expect(prompt).toContain('did not accurately match');
    expect(prompt).toContain('couleur incorrecte');
    expect(prompt).toContain('logo absent');
    expect(prompt).not.toContain('too static');
  });

  it('échec des deux : les deux instructions sont présentes', () => {
    const prompt = service.repairShotPrompt(SHOT, {
      passed: false,
      qualityScore: 10,
      motionQuality: { passed: false, score: 10, reasons: ['quasi-statique'], freezeRatio: 0.8 },
      visualFidelity: { passed: false, score: 20, reasons: ['produit différent'] },
      reasons: ['quasi-statique', 'produit différent'],
    });

    expect(prompt).toContain('too static');
    expect(prompt).toContain('did not accurately match');
  });

  it('aucun appel IA : pure construction de texte (aucune dépendance à un AiGatewayService fonctionnel)', () => {
    // service construit avec un gateway factice ({} as AiGatewayService, ligne 116) — si
    // repairShotPrompt appelait le moindre generateText/generateImage, ce test lèverait.
    expect(() =>
      service.repairShotPrompt(SHOT, {
        passed: false,
        qualityScore: 40,
        motionQuality: { passed: false, score: 20, reasons: [], freezeRatio: 0.5 },
        visualFidelity: { ...PASSING },
        reasons: [],
      }),
    ).not.toThrow();
  });
});
