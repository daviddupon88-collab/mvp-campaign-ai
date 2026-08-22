import { VideoDirectorService, DEFAULT_SHOT_PLAN, Shot, GenerateShotPlanParams, linkBeatsToShots } from './video-director.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { VisualDna } from './visual-dna.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBeat, NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';
import { ShotExecutionContext } from './shot-execution-compiler';

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

// sceneId absent volontairement ici : jamais confié au modèle, toujours réassigné par index
// dans parseShotPlan (P0.3) — un SHOT "brut" comme celui-ci représente ce qu'un candidat JSON
// valide contient avant cette réassignation.
const SHOT: Shot = { sceneId: 'ignored', camera: 'dolly-in', subject: 'product', motion: 'slow rotation', lighting: 'moving highlight', background: 'particles' };

function buildConcept(scenesCount: number): CreativeConcept {
  return {
    title: 't', concept: 'c', coreMessage: 'm', hook: 'h', emotionalDirection: 'e', visualDirection: 'v',
    storytellingApproach: 's', proofStrategy: 'p', cta: 'cta', targetAudience: 'a', duration: 15, format: '9:16',
    scenesCount, qualityAlignment: '', raw: '{}',
  };
}

const BLUEPRINT: NarrativeBlueprint = {
  hook: 'Hook narratif', problem: 'Problème', tension: 'Tension', reveal: 'Révélation',
  productIntroduction: 'Introduction produit', benefit: 'Bénéfice', proof: 'Preuve', emotionalPayoff: 'Émotion',
  cta: 'CTA narratif', pacing: 'rapide', pausePoints: [], beats: [], raw: '{}',
};

// Mission 4.3 (Goal-First Quality Architecture, Phase 4) — context NEUTRE (concept/blueprint aux
// champs vides) pour serializeShotToPrompt/repairShotPrompt : ce describe teste le gabarit
// littéral relocalisé dans ShotExecutionCompiler (non-régression), pas les niveaux additionnels
// (déjà couverts par shot-execution-compiler.spec.ts) — un context non-neutre ajouterait des
// lignes supplémentaires et casserait les assertions .toBe() ci-dessous.
const NEUTRAL_CONCEPT: CreativeConcept = {
  title: '', concept: '', coreMessage: '', hook: '', emotionalDirection: '', visualDirection: '',
  storytellingApproach: '', proofStrategy: '', cta: '', targetAudience: '', duration: 15, format: '9:16',
  scenesCount: 3, qualityAlignment: '', raw: '{}',
};
const NEUTRAL_BLUEPRINT: NarrativeBlueprint = {
  hook: '', problem: '', tension: '', reveal: '', productIntroduction: '',
  benefit: '', proof: '', emotionalPayoff: '', cta: '', pacing: '', pausePoints: [], beats: [], raw: '{}',
};
const CONTEXT: ShotExecutionContext = { creativeConcept: NEUTRAL_CONCEPT, narrativeBlueprint: NEUTRAL_BLUEPRINT };

function buildParams(overrides: Partial<GenerateShotPlanParams> = {}): GenerateShotPlanParams {
  return {
    visualDna: VISUAL_DNA,
    productDescription: 'x',
    objective: 'Attirer des clients B2B',
    campaignContext: 'y',
    creativeConcept: buildConcept(3),
    narrativeBlueprint: BLUEPRINT,
    ...overrides,
  };
}

describe('VideoDirectorService.generateShotPlan', () => {
  it('réponse avec exactement shotCount plans (dérivé de creativeConcept.scenesCount) : mappés tels quels, sceneId réassigné par index', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, buildParams());

    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual({ ...SHOT, sceneId: 'shot-1' });
    expect(plan[1].sceneId).toBe('shot-2');
    expect(plan[2].sceneId).toBe('shot-3');
  });

  it('réponse avec moins de plans que demandé : complétée depuis DEFAULT_SHOT_PLAN', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT]));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, buildParams());

    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual({ ...SHOT, sceneId: 'shot-1' });
    expect(plan[1]).toEqual({ ...DEFAULT_SHOT_PLAN[1], sceneId: 'shot-2', usedFallbackTemplate: true });
    expect(plan[2]).toEqual({ ...DEFAULT_SHOT_PLAN[2], sceneId: 'shot-3', usedFallbackTemplate: true });
  });

  it('une entrée malformée au milieu du tableau : comblée individuellement, le reste conservé, et signalée via usedFallbackTemplate (audit forensique Mission 4.2, P0-2)', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, { camera: 'orbit' }, SHOT]));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, buildParams());

    expect(plan[0]).toEqual({ ...SHOT, sceneId: 'shot-1' });
    expect(plan[1]).toEqual({ ...DEFAULT_SHOT_PLAN[1], sceneId: 'shot-2', usedFallbackTemplate: true });
    expect(plan[2]).toEqual({ ...SHOT, sceneId: 'shot-3' });
  });

  // Audit forensic (2026-08-20, campagne réelle a294054e) — le repli intégral sur
  // DEFAULT_SHOT_PLAN a été retiré : un plan ENTIÈREMENT générique n'a aucun rapport avec le
  // concept (contrairement au comblement PARTIEL ci-dessus, une seule entrée malformée au sein
  // d'une réponse par ailleurs exploitable, qui reste inchangé). Échec total -> 1 nouvelle
  // tentative (même discipline que VideoJudgeService.callTextCriteriaOnce), puis échec franc.
  describe("Audit forensic (campagne a294054e) — échec TOTAL du Shot Plan : jamais de repli générique silencieux", () => {
    it('réponse non-JSON aux 2 tentatives : lève une erreur explicite, jamais un plan générique substitué', async () => {
      const gateway = buildGatewayMock('Désolé, je ne peux pas générer de plan.');
      const service = new VideoDirectorService(gateway);

      await expect(service.generateShotPlan(CTX, buildParams())).rejects.toThrow('SHOT_PLAN_GENERATION_FAILED');
      expect(gateway.generateText).toHaveBeenCalledTimes(2); // 1 tentative + 1 nouvelle tentative avant d'abandonner
    });

    it('réponse JSON valide mais pas un tableau aux 2 tentatives : lève une erreur explicite', async () => {
      const gateway = buildGatewayMock(JSON.stringify({ not: 'an array' }));
      const service = new VideoDirectorService(gateway);

      await expect(service.generateShotPlan(CTX, buildParams())).rejects.toThrow('SHOT_PLAN_GENERATION_FAILED');
    });

    it('tableau JSON valide mais VIDE aux 2 tentatives : lève une erreur explicite (pas un plan vide silencieusement accepté)', async () => {
      const gateway = buildGatewayMock(JSON.stringify([]));
      const service = new VideoDirectorService(gateway);

      await expect(service.generateShotPlan(CTX, buildParams())).rejects.toThrow('SHOT_PLAN_GENERATION_FAILED');
    });

    it('1er essai non-JSON, 2e essai exploitable : retourne le plan de la 2e tentative, ne lève pas', async () => {
      const generateText = jest
        .fn()
        .mockResolvedValueOnce({ content: 'Désolé, je ne peux pas générer de plan.', provider: 'anthropic', model: 'claude', durationMs: 10 })
        .mockResolvedValueOnce({ content: JSON.stringify([SHOT, SHOT, SHOT]), provider: 'anthropic', model: 'claude', durationMs: 10 });
      const gateway = { generateText } as unknown as AiGatewayService;
      const service = new VideoDirectorService(gateway);

      const plan = await service.generateShotPlan(CTX, buildParams());

      expect(plan).toHaveLength(3);
      expect(plan[0]).toEqual({ ...SHOT, sceneId: 'shot-1' });
      expect(generateText).toHaveBeenCalledTimes(2);
    });

    it("l'appel de génération demande explicitement un budget de tokens plus généreux que le défaut", async () => {
      const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
      const service = new VideoDirectorService(gateway);

      await service.generateShotPlan(CTX, buildParams());

      const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
      expect(params.maxTokens).toBeGreaterThanOrEqual(8000);
    });
  });

  it('utilise bien le provider "anthropic" (raisonnement structuré), pas openai', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, buildParams());

    const [, , provider] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(provider).toBe('anthropic');
  });

  it('le prompt envoyé contient une ligne Objectif explicite (chantier prompts orientés objectif, 2026-08-18)', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, buildParams());

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

    await service.generateShotPlan(CTX, buildParams());

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('arc narratif');
    expect(params.prompt).toContain('narrativeRole');
    expect(params.prompt).toContain('progression qui se répond');
  });

  // Chantier Creative Intelligence Engine (2026-08-18, P0.3) : le Shot Plan doit désormais
  // raconter le concept publicitaire retenu, pas des paramètres bruts déconnectés.
  it('le prompt embarque le concept créatif (titre, hook, approche narrative, stratégie de preuve)', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);
    const concept = { ...buildConcept(3), title: 'Vu de loin, protégé de près', hook: 'Chantier plongé dans le noir', proofStrategy: 'Bandes réfléchissantes qui captent la lumière' };

    await service.generateShotPlan(CTX, buildParams({ creativeConcept: concept }));

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Vu de loin, protégé de près');
    expect(params.prompt).toContain('Chantier plongé dans le noir');
    expect(params.prompt).toContain('Bandes réfléchissantes qui captent la lumière');
  });

  it('shotCount dérivé de creativeConcept.scenesCount (ex: 1) est bien respecté', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT]));
    const service = new VideoDirectorService(gateway);

    const plan = await service.generateShotPlan(CTX, buildParams({ creativeConcept: buildConcept(1) }));

    expect(plan).toHaveLength(1);
  });

  // P0.4 (shot-diversity.ts) : ce champ n'est JAMAIS présent en temps normal — seulement lors
  // d'une régénération déclenchée après détection de répétition. Vérifie juste qu'il est bien
  // transmis au prompt quand fourni, sans dépendre de shot-diversity.ts lui-même (testé à part).
  it('avoidRepetitionHint, quand fourni, est injecté dans le prompt', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, buildParams({ avoidRepetitionHint: 'évite 3 plans en close-up statique' }));

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('évite 3 plans en close-up statique');
  });

  // Mission 4.3 (Goal-First Quality Architecture, Phase 3) — narrationHint (texte plat) remplacé
  // par narrativeBlueprint (structure complète) : le prompt doit refléter les champs du blueprint.
  it('la structure narrative du prompt reflète les champs du NarrativeBlueprint, pas un simple texte plat', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, buildParams());

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('Hook narratif');
    expect(params.prompt).toContain('CTA narratif');
    expect(params.prompt).toContain('rapide');
  });

  // Mission 4.3 (Goal-First Quality Architecture, Phase 4, Étape 5) — le prompt liste les beats
  // disponibles et demande explicitement narrativeBeatId, pour que ShotExecutionCompiler puisse
  // ensuite relier chaque plan à la preuve visuelle attendue par son beat.
  it('les beats du NarrativeBlueprint sont listés et narrativeBeatId est demandé au modèle', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);
    const blueprintWithBeats: NarrativeBlueprint = {
      ...BLUEPRINT,
      beats: [{ id: 'beat-1', role: 'hook', objective: 'accrocher', duration: 3, requiredVisualEvidence: 'chantier plongé dans le noir', requiredVoiceover: '', shotIds: [] }],
    };

    await service.generateShotPlan(CTX, buildParams({ narrativeBlueprint: blueprintWithBeats }));

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('beat-1');
    expect(params.prompt).toContain('chantier plongé dans le noir');
    expect(params.prompt).toContain('narrativeBeatId');
  });

  it('aucun beat dans le NarrativeBlueprint (repli neutre) : aucun bloc de beats listés dans le prompt (seule l\'instruction générale sur narrativeBeatId reste)', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, buildParams());

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).not.toContain('Beats narratifs disponibles (rattache');
  });

  // Audit forensic (2026-08-22, 2 campagnes réelles a4a1... et 208b515c...) : le Storyboard Gate a
  // rejeté deux Shot Plans distincts pour la MÊME raison structurelle — une preuve/affirmation
  // portée uniquement par la voix-off, jamais visuellement démontrée par le plan lui-même (ex.
  // "packaging reste sec" alors que la VO affirme "plongé dans le produit"), et un élément
  // distinctif confirmé de l'ADN visuel absent de tous les plans. Contraintes ajoutées en v3 pour
  // fixer la génération à la source plutôt que de compter sur le Storyboard Gate pour rattraper
  // après coup à chaque tentative.
  it('demande explicitement l\'alignement visuel/verbal, la fidélité au beat rattaché, et la complétude de l\'ADN visuel', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, buildParams());

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('DOIT être visuellement démontrée');
    expect(params.prompt).toContain('doit représenter concrètement la preuve visuelle attendue par ce beat');
    expect(params.prompt).toContain('distinctiveFeatures');
    expect(params.prompt).toContain('AU MOINS un plan');
  });

  // Audit forensic (2026-08-22) — dernier maillon de la chaîne proofToShow (CreativeIntelligence)
  // -> proofStrategy (Concept) -> requiredVisualEvidence (NarrativeBlueprint) -> proofElement
  // (Shot Plan) : seul proofElement n'avait jusqu'ici aucune consigne SHOW > TELL propre dans le
  // prompt (juste un nom de champ dans le schéma JSON).
  it('demande explicitement la règle SHOW > TELL pour proofElement', async () => {
    const gateway = buildGatewayMock(JSON.stringify([SHOT, SHOT, SHOT]));
    const service = new VideoDirectorService(gateway);

    await service.generateShotPlan(CTX, buildParams());

    const [, params] = (gateway.generateText as jest.Mock).mock.calls[0];
    expect(params.prompt).toContain('"proofElement" (règle SHOW > TELL');
    expect(params.prompt).toContain('n\'invente jamais une preuve non filmable');
  });
});

// Mission 4.3 (Goal-First Quality Architecture, Phase 4) — délègue désormais à
// ShotExecutionCompiler.compileShotExecutionInstruction (shot-execution-compiler.ts). Ce describe
// vérifie uniquement la DÉLÉGATION (le gabarit littéral historique reste identique via un context
// neutre) — la couverture exhaustive des niveaux PRIMARY/SUPPORTING/CONTINUITY/NEGATIVE vit dans
// shot-execution-compiler.spec.ts, jamais dupliquée ici.
describe('VideoDirectorService.serializeShotToPrompt', () => {
  const service = new VideoDirectorService({} as AiGatewayService);

  it('reproduit la structure littérale du gabarit cinématographique (7 lignes)', () => {
    const prompt = service.serializeShotToPrompt({
      sceneId: 'shot-1',
      camera: 'slow cinematic push-in',
      subject: 'product',
      motion: 'the product rotates slowly',
      lighting: 'a moving highlight sweeps across the product',
      background: 'subtle floating particles move through the scene',
    }, CONTEXT);

    expect(prompt).toBe(
      `Create a dynamic premium product commercial.
The product remains visually identical to the reference image.
Camera: slow cinematic push-in
Motion: the product rotates slowly
Environment: subtle floating particles move through the scene
Lighting: a moving highlight sweeps across the product
The movement must remain continuous throughout the entire shot.
Avoid a static camera and avoid a still-image effect.
Avoid any static or frozen frame — motion must be continuous throughout.
Never render on-screen text, logos, or brand marks that are not present in the reference image.`,
    );
  });

  it('subject différent de "product" est intégré dans la ligne Camera', () => {
    const prompt = service.serializeShotToPrompt({
      sceneId: 'shot-1',
      camera: 'close-up',
      subject: 'logo',
      motion: 'slight push-in',
      lighting: 'a focused highlight on the logo',
      background: 'softly blurred product surface',
    }, CONTEXT);

    expect(prompt).toContain('Camera: close-up focused on the logo');
  });

  it('subject "product" (la valeur par défaut) ne modifie pas la ligne Camera', () => {
    const prompt = service.serializeShotToPrompt(SHOT, CONTEXT);
    expect(prompt).toContain('Camera: dolly-in\n');
  });

  // Chantier Storyboard (2026-08-18) : ligne additive, jamais au prix du gabarit littéral figé.
  it('narrativeRole renseigné : ajoute une ligne de contexte narratif en tête, gabarit des 7 lignes inchangé', () => {
    const prompt = service.serializeShotToPrompt({ ...SHOT, narrativeRole: 'hook' }, CONTEXT);
    expect(prompt.startsWith(
      `This shot is the "hook" beat of the commercial.
Create a dynamic premium product commercial.
The product remains visually identical to the reference image.
Camera: dolly-in
Motion: slow rotation
Environment: particles
Lighting: moving highlight
The movement must remain continuous throughout the entire shot.
Avoid a static camera and avoid a still-image effect.`,
    )).toBe(true);
  });

  it('narrativeRole absent : sortie strictement identique à avant ce chantier (non-régression)', () => {
    const prompt = service.serializeShotToPrompt(SHOT, CONTEXT);
    expect(prompt.startsWith('Create a dynamic premium product commercial.')).toBe(true);
    expect(prompt).not.toContain('beat of the commercial');
  });

  describe('Audit forensique Mission 4.2 (P0-6) — action/cameraMovement/productBenefit atteignent enfin le prompt vidéo', () => {
    it('les 3 champs renseignés : 3 lignes additives après Lighting, gabarit des 7 lignes inchangé', () => {
      const prompt = service.serializeShotToPrompt({
        ...SHOT,
        action: 'the hand reaches for the bottle and lifts it',
        cameraMovement: 'slow dolly-in with a slight tilt up',
        productBenefit: 'shows the leak-proof cap under pressure',
      }, CONTEXT);

      expect(prompt.startsWith(
        `Create a dynamic premium product commercial.
The product remains visually identical to the reference image.
Camera: dolly-in
Motion: slow rotation
Environment: particles
Lighting: moving highlight
Action: the hand reaches for the bottle and lifts it
Camera movement: slow dolly-in with a slight tilt up
What this shot must convey: shows the leak-proof cap under pressure
The movement must remain continuous throughout the entire shot.
Avoid a static camera and avoid a still-image effect.`,
      )).toBe(true);
    });

    it('aucun des 3 champs renseigné : aucune ligne ajoutée, gabarit strictement identique (non-régression)', () => {
      const prompt = service.serializeShotToPrompt(SHOT, CONTEXT);
      expect(prompt).not.toContain('Action:');
      expect(prompt).not.toContain('Camera movement:');
      expect(prompt).not.toContain('What this shot must convey:');
    });

    it('un seul des 3 champs renseigné (action) : une seule ligne ajoutée', () => {
      const prompt = service.serializeShotToPrompt({ ...SHOT, action: 'the cap lights up' }, CONTEXT);
      expect(prompt).toContain('Action: the cap lights up');
      expect(prompt).not.toContain('Camera movement:');
      expect(prompt).not.toContain('What this shot must convey:');
    });
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
    }, CONTEXT);

    expect(prompt).toContain('too static');
    expect(prompt).not.toContain('did not accurately match');
    expect(prompt.startsWith(service.serializeShotToPrompt(SHOT, CONTEXT))).toBe(true); // base inchangée, instructions ajoutées à la suite
  });

  it('échec fidélité seul : ajoute une instruction de fidélité incluant les raisons précises, pas de mouvement', () => {
    const prompt = service.repairShotPrompt(SHOT, {
      passed: false,
      qualityScore: 40,
      motionQuality: { ...PASSING, freezeRatio: 0 },
      visualFidelity: { passed: false, score: 30, reasons: ['couleur incorrecte', 'logo absent'] },
      reasons: ['couleur incorrecte', 'logo absent'],
    }, CONTEXT);

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
    }, CONTEXT);

    expect(prompt).toContain('too static');
    expect(prompt).toContain('did not accurately match');
  });

  // P0.6 (repair-dispatch.ts, chantier Creative Intelligence Engine) : branche transition,
  // déclenchée par le Video Judge sur la vidéo finale assemblée, pas par VideoAnalyzerService.
  it('additionalDefect de type transition : ajoute une instruction de raccord, cumulable avec mouvement/fidélité', () => {
    const prompt = service.repairShotPrompt(
      SHOT,
      { passed: true, qualityScore: 90, motionQuality: { ...PASSING, freezeRatio: 0 }, visualFidelity: { ...PASSING }, reasons: [] },
      CONTEXT,
      { type: 'transition', description: 'le plan suivant démarre sur un angle opposé' },
    );

    expect(prompt).toContain('transitions smoothly into the next shot');
    expect(prompt).toContain('le plan suivant démarre sur un angle opposé');
  });

  // Phase B (chantier V2, 2026-08-19) : escalation présente uniquement quand l'historique
  // anti-boucle montre qu'une correction précédente sur ce défaut a eu un résultat FAIBLE.
  it('escalation renseignée : ajoute un correctif renforcé distinct, cumulable avec mouvement/fidélité', () => {
    const prompt = service.repairShotPrompt(
      SHOT,
      { passed: false, qualityScore: 40, motionQuality: { passed: false, score: 20, reasons: ['quasi-statique'], freezeRatio: 0.5 }, visualFidelity: { ...PASSING }, reasons: ['quasi-statique'] },
      CONTEXT,
      undefined,
      { priorFailureReason: 'toujours trop statique' },
    );

    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('toujours trop statique');
    expect(prompt).toContain('too static'); // le correctif mouvement normal reste présent, cumulé
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
      }, CONTEXT),
    ).not.toThrow();
  });
});

// Mission 4.3 (Goal-First Quality Architecture, Phase 4, Étape 5).
describe('linkBeatsToShots', () => {
  const BEAT_A: NarrativeBeat = { id: 'beat-1', role: 'hook', objective: 'accrocher', duration: 3, requiredVisualEvidence: 'chantier sombre', requiredVoiceover: '', shotIds: [] };
  const BEAT_B: NarrativeBeat = { id: 'beat-2', role: 'proof', objective: 'démontrer', duration: 4, requiredVisualEvidence: 'bandes réfléchissantes', requiredVoiceover: '', shotIds: [] };

  it('regroupe les shots par narrativeBeatId, dans l\'ordre du Shot Plan', () => {
    const shotPlan: Shot[] = [
      { ...SHOT, sceneId: 'shot-1', narrativeBeatId: 'beat-1' },
      { ...SHOT, sceneId: 'shot-2', narrativeBeatId: 'beat-2' },
      { ...SHOT, sceneId: 'shot-3', narrativeBeatId: 'beat-1' },
    ];
    const blueprint: NarrativeBlueprint = { ...BLUEPRINT, beats: [BEAT_A, BEAT_B] };

    const result = linkBeatsToShots(shotPlan, blueprint);

    expect(result.beats.find((b) => b.id === 'beat-1')!.shotIds).toEqual(['shot-1', 'shot-3']);
    expect(result.beats.find((b) => b.id === 'beat-2')!.shotIds).toEqual(['shot-2']);
  });

  it('aucun shot ne référence un beat donné : shotIds reste [] pour ce beat, jamais une erreur', () => {
    const shotPlan: Shot[] = [{ ...SHOT, sceneId: 'shot-1', narrativeBeatId: 'beat-1' }];
    const blueprint: NarrativeBlueprint = { ...BLUEPRINT, beats: [BEAT_A, BEAT_B] };

    const result = linkBeatsToShots(shotPlan, blueprint);

    expect(result.beats.find((b) => b.id === 'beat-2')!.shotIds).toEqual([]);
  });

  it('un shot référence un narrativeBeatId inconnu du blueprint : ignoré silencieusement, jamais une erreur', () => {
    const shotPlan: Shot[] = [{ ...SHOT, sceneId: 'shot-1', narrativeBeatId: 'beat-inconnu' }];
    const blueprint: NarrativeBlueprint = { ...BLUEPRINT, beats: [BEAT_A] };

    expect(() => linkBeatsToShots(shotPlan, blueprint)).not.toThrow();
    expect(linkBeatsToShots(shotPlan, blueprint).beats[0].shotIds).toEqual([]);
  });

  it('aucun shot ne porte de narrativeBeatId : tous les beats gardent shotIds: []', () => {
    const shotPlan: Shot[] = [{ ...SHOT, sceneId: 'shot-1' }];
    const blueprint: NarrativeBlueprint = { ...BLUEPRINT, beats: [BEAT_A] };

    const result = linkBeatsToShots(shotPlan, blueprint);

    expect(result.beats[0].shotIds).toEqual([]);
  });
});
