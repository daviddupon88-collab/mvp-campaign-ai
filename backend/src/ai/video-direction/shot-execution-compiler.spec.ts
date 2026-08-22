import { compileShotExecutionInstruction, compileShotRepairInstruction, ShotExecutionContext } from './shot-execution-compiler';
import { Shot } from './video-director.service';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { NarrativeBlueprint } from '../creative-intelligence/narrative-blueprint.types';

const SHOT: Shot = { sceneId: 'shot-1', camera: 'dolly-in', subject: 'product', motion: 'slow rotation', lighting: 'moving highlight', background: 'particles' };

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

describe('compileShotExecutionInstruction — mustObey (relocated gabarit, non-régression)', () => {
  it('reproduit la structure littérale du gabarit cinématographique (7 lignes), identique à l\'ancien serializeShotToPrompt', () => {
    const result = compileShotExecutionInstruction(SHOT, CONTEXT);

    expect(result.mustObey).toBe(
      `Create a dynamic premium product commercial.
The product remains visually identical to the reference image.
Camera: dolly-in
Motion: slow rotation
Environment: particles
Lighting: moving highlight
The movement must remain continuous throughout the entire shot.
Avoid a static camera and avoid a still-image effect.`,
    );
  });

  it('narrativeRole renseigné : préfixe le gabarit, inchangé sinon', () => {
    const result = compileShotExecutionInstruction({ ...SHOT, narrativeRole: 'hook' }, CONTEXT);
    expect(result.mustObey.startsWith('This shot is the "hook" beat of the commercial.\n')).toBe(true);
  });

  it('avec un context neutre (tous champs vides), le prompt final est strictement égal à mustObey — aucun niveau additionnel ajouté', () => {
    const result = compileShotExecutionInstruction(SHOT, CONTEXT);
    expect(result.prompt).toBe(result.mustObey + '\nAvoid any static or frozen frame — motion must be continuous throughout.\nNever render on-screen text, logos, or brand marks that are not present in the reference image.');
    expect(result.primaryVisualExecution).toEqual([]);
    expect(result.supportingDetails).toEqual([]);
    expect(result.continuity).toEqual([]);
  });
});

describe('compileShotExecutionInstruction — primaryVisualExecution', () => {
  it('cameraShot/productPresence/proofElement renseignés : une ligne chacun, jamais dans mustObey', () => {
    const shot: Shot = { ...SHOT, cameraShot: 'close-up', productPresence: 'centered, fully visible', proofElement: 'leak-proof seal under pressure' };
    const result = compileShotExecutionInstruction(shot, CONTEXT);

    expect(result.primaryVisualExecution).toEqual([
      'Shot framing: close-up',
      'Product presence: centered, fully visible',
      'Proof element to render visibly: leak-proof seal under pressure',
    ]);
    expect(result.mustObey).not.toContain('close-up focused');
    expect(result.prompt).toContain('Shot framing: close-up');
  });

  it('aucun des 3 champs renseigné : tableau vide, aucune ligne ajoutée au prompt', () => {
    const result = compileShotExecutionInstruction(SHOT, CONTEXT);
    expect(result.primaryVisualExecution).toEqual([]);
  });
});

describe('compileShotExecutionInstruction — supportingDetails', () => {
  it('location/atmosphere/visualDetails/characters renseignés : une ligne chacun', () => {
    const shot: Shot = { ...SHOT, location: 'urban rooftop at dusk', atmosphere: 'warm, energetic', visualDetails: 'condensation droplets on the surface', characters: 'one adult hand' };
    const result = compileShotExecutionInstruction(shot, CONTEXT);

    expect(result.supportingDetails).toEqual([
      'Setting: urban rooftop at dusk',
      'Atmosphere: warm, energetic',
      'Visual details: condensation droplets on the surface',
      'Characters/subjects present: one adult hand',
    ]);
  });

  it('creativeConcept.visualDirection/emotionalDirection renseignés : surfacent aussi, alors qu\'ils n\'atteignaient jamais le prompt par plan avant ce chantier', () => {
    const context: ShotExecutionContext = {
      ...CONTEXT,
      creativeConcept: { ...NEUTRAL_CONCEPT, visualDirection: 'high contrast, dark background', emotionalDirection: 'quiet confidence' },
    };
    const result = compileShotExecutionInstruction(SHOT, context);

    expect(result.supportingDetails).toContain('Overall visual direction: high contrast, dark background');
    expect(result.supportingDetails).toContain('Emotional tone for this shot: quiet confidence');
  });
});

describe('compileShotExecutionInstruction — continuity', () => {
  it('transition renseigné : une ligne', () => {
    const shot: Shot = { ...SHOT, transition: 'match cut on product silhouette' };
    const result = compileShotExecutionInstruction(shot, CONTEXT);
    expect(result.continuity).toEqual(['Transition intent: match cut on product silhouette']);
  });

  it('narrativeBeatId correspond à un beat du blueprint : la preuve visuelle attendue par CE beat devient une instruction pour CE plan', () => {
    const blueprint: NarrativeBlueprint = {
      ...NEUTRAL_BLUEPRINT,
      beats: [{ id: 'beat-1', role: 'proof', objective: 'démontrer', duration: 4, requiredVisualEvidence: 'the cap withstands pressure without leaking', requiredVoiceover: '', shotIds: [] }],
    };
    const context: ShotExecutionContext = { ...CONTEXT, narrativeBlueprint: blueprint };
    const shot: Shot = { ...SHOT, narrativeBeatId: 'beat-1' };

    const result = compileShotExecutionInstruction(shot, context);

    expect(result.continuity).toContain('This shot must visually prove: the cap withstands pressure without leaking');
  });

  it('narrativeBeatId ne correspond à AUCUN beat (blueprint désynchronisé) : ignoré silencieusement, jamais une erreur', () => {
    const shot: Shot = { ...SHOT, narrativeBeatId: 'beat-inconnu' };
    expect(() => compileShotExecutionInstruction(shot, CONTEXT)).not.toThrow();
    expect(compileShotExecutionInstruction(shot, CONTEXT).continuity).toEqual([]);
  });

  it('aucun narrativeBeatId : continuity ne contient aucune ligne de preuve visuelle', () => {
    const result = compileShotExecutionInstruction(SHOT, CONTEXT);
    expect(result.continuity.some((l) => l.startsWith('This shot must visually prove'))).toBe(false);
  });
});

describe('compileShotExecutionInstruction — negativeConstraints', () => {
  it('toujours présentes (plancher déterministe), même avec un shot/context entièrement neutre', () => {
    const result = compileShotExecutionInstruction(SHOT, CONTEXT);
    expect(result.negativeConstraints.length).toBeGreaterThan(0);
    expect(result.prompt).toContain('Never render on-screen text, logos, or brand marks');
  });
});

describe('compileShotExecutionInstruction — onScreenText/voiceover/soundDesign restent hors périmètre', () => {
  it('renseignés sur le shot, ils n\'apparaissent jamais dans le prompt (Veo ne rend pas de texte de façon fiable)', () => {
    const shot: Shot = { ...SHOT, onScreenText: '50% OFF TODAY', voiceover: 'Get yours now', soundDesign: 'upbeat synth' };
    const result = compileShotExecutionInstruction(shot, CONTEXT);

    expect(result.prompt).not.toContain('50% OFF TODAY');
    expect(result.prompt).not.toContain('Get yours now');
    expect(result.prompt).not.toContain('upbeat synth');
  });
});

describe('compileShotRepairInstruction', () => {
  const PASSING = { passed: true, score: 90, reasons: [] };

  it('cumule les correctifs sur la base compilée (mustObey + niveaux), même comportement que l\'ancien repairShotPrompt', () => {
    const prompt = compileShotRepairInstruction(
      SHOT,
      { passed: false, qualityScore: 40, motionQuality: { passed: false, score: 20, reasons: ['quasi-statique'], freezeRatio: 0.5 }, visualFidelity: { ...PASSING }, reasons: ['quasi-statique'] },
      CONTEXT,
    );

    expect(prompt.startsWith(compileShotExecutionInstruction(SHOT, CONTEXT).prompt)).toBe(true);
    expect(prompt).toContain('too static');
  });

  it('additionalDefect transition + escalation : cumulables avec le correctif mouvement/fidélité', () => {
    const prompt = compileShotRepairInstruction(
      SHOT,
      { passed: false, qualityScore: 10, motionQuality: { passed: false, score: 10, reasons: [], freezeRatio: 0.8 }, visualFidelity: { ...PASSING }, reasons: [] },
      CONTEXT,
      { type: 'transition', description: 'le plan suivant démarre sur un angle opposé' },
      { priorFailureReason: 'toujours trop statique' },
    );

    expect(prompt).toContain('too static');
    expect(prompt).toContain('transitions smoothly into the next shot');
    expect(prompt).toContain('CRITICAL');
  });
});
