import { computeVoicePacing } from './voice-pacing';

describe('computeVoicePacing (Mission 4 Phase D/E)', () => {
  it('transcript vide -> null (jamais une valeur inventée)', () => {
    expect(computeVoicePacing([])).toBeNull();
  });

  it('durée de parole nulle -> null', () => {
    expect(computeVoicePacing([{ start: 0, end: 0, text: 'x' }])).toBeNull();
  });

  it('débit dans la cible, aucune pause : VOICE_PACING_OK', () => {
    const result = computeVoicePacing([{ start: 0, end: 3, text: 'Le produit reste visible même dans le noir total.' }]);
    expect(result?.diagnostic).toBe('VOICE_PACING_OK');
    expect(result?.speakingRate).toBeCloseTo(3.0, 1);
  });

  it('débit trop rapide : VOICE_TOO_FAST', () => {
    const result = computeVoicePacing([{ start: 0, end: 1, text: 'un deux trois quatre cinq six sept huit neuf dix' }]);
    expect(result?.diagnostic).toBe('VOICE_TOO_FAST');
  });

  it('débit trop lent : VOICE_TOO_SLOW', () => {
    const result = computeVoicePacing([{ start: 0, end: 4, text: 'trop lent' }]);
    expect(result?.diagnostic).toBe('VOICE_TOO_SLOW');
  });

  it('ratio de pause élevé entre segments : VOICE_PAUSE_HEAVY (prioritaire sur le débit)', () => {
    const result = computeVoicePacing([
      { start: 0, end: 1, text: 'un deux trois' },
      { start: 6, end: 7, text: 'quatre cinq six' },
    ]);
    expect(result?.diagnostic).toBe('VOICE_PAUSE_HEAVY');
  });
});
