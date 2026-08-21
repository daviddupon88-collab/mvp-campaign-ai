import { buildVoiceDirectionInstructions } from './voice-direction';

describe('buildVoiceDirectionInstructions (Mission 4 Phase E)', () => {
  it('construit les instructions UNIQUEMENT à partir des champs hook/emotionalDirection/cta fournis, sans invention', () => {
    const instructions = buildVoiceDirectionInstructions({
      hook: 'Et si votre café restait chaud 12 heures ?',
      emotionalDirection: 'chaleureux, énergique',
      cta: 'Commandez maintenant',
    });

    expect(instructions).toContain('chaleureux, énergique');
    expect(instructions).toContain('Et si votre café restait chaud 12 heures ?');
    expect(instructions).toContain('Commandez maintenant');
  });

  it('est une fonction pure : même entrée -> même sortie, aucun effet de bord', () => {
    const concept = { hook: 'h', emotionalDirection: 'e', cta: 'c' };
    expect(buildVoiceDirectionInstructions(concept)).toBe(buildVoiceDirectionInstructions(concept));
  });
});
