import { SubtitleBuilderService } from './subtitle-builder.service';

describe('SubtitleBuilderService', () => {
  const service = new SubtitleBuilderService();

  it('formate un segment unique au format .srt (index, horodatage HH:MM:SS,mmm, texte)', () => {
    const srt = service.buildSrt([{ start: 0, end: 1.5, text: 'Une photo.' }]);

    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,500\nUne photo.');
  });

  it('numérote et sépare correctement plusieurs segments, séparés par une ligne vide', () => {
    const srt = service.buildSrt([
      { start: 0, end: 1.5, text: 'Une photo.' },
      { start: 1.5, end: 3.2, text: 'Une campagne complète.' },
    ]);

    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,500\nUne photo.\n\n2\n00:00:01,500 --> 00:00:03,200\nUne campagne complète.');
  });

  it('gère les horodatages au-delà d\'une minute (heures/minutes/secondes)', () => {
    const srt = service.buildSrt([{ start: 65.25, end: 130.005, text: 'x' }]);

    expect(srt).toContain('00:01:05,250 --> 00:02:10,005');
  });

  it('tableau vide -> chaîne vide, ne plante jamais', () => {
    expect(service.buildSrt([])).toBe('');
  });

  it('découpe un segment long (≤12 mots) en plusieurs lignes de 36 caractères max, sans couper un mot', () => {
    // 12 mots exactement (≤ MAX_WORDS_PER_CUE) — teste le retour à la ligne seul, sans
    // déclencher le découpage en plusieurs légendes (couvert séparément ci-dessous).
    const longText = 'Cette phrase est volontairement bien trop longue pour tenir sur une ligne';
    const srt = service.buildSrt([{ start: 0, end: 3, text: longText }]);

    const cueText = srt.split('\n').slice(2).join('\n');
    const lines = cueText.split('\n');

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(36);
    }
    expect(lines.join(' ')).toBe(longText);
  });

  it('segment court : reste sur une seule ligne', () => {
    const srt = service.buildSrt([{ start: 0, end: 1, text: 'Court.' }]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,000\nCourt.');
  });

  it('découpe un segment de plus de 12 mots en plusieurs légendes réparties à parts égales dans le temps du segment', () => {
    // 20 mots -> 2 légendes (12 + 8), sur une fenêtre [0,10] -> 2 parts égales de 5s. Le texte
    // de chaque légende passe aussi par wrapText (retours à la ligne) : on normalise les \n en
    // espaces avant comparaison pour isoler le découpage en légendes du retour à la ligne.
    const words = Array.from({ length: 20 }, (_, i) => `m${i + 1}`);
    const srt = service.buildSrt([{ start: 0, end: 10, text: words.join(' ') }]);
    const normalize = (block: string) => block.split('\n').join(' ');

    const [block0, block1] = srt.split('\n\n');
    expect(srt.split('\n\n')).toHaveLength(2);
    expect(block0).toContain('00:00:00,000 --> 00:00:05,000');
    expect(normalize(block0)).toContain(words.slice(0, 12).join(' '));
    expect(block1).toContain('00:00:05,000 --> 00:00:10,000');
    expect(normalize(block1)).toContain(words.slice(12).join(' '));
  });

  it('segment de 12 mots exactement : une seule légende (pas de découpage au seuil)', () => {
    const words = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
    const srt = service.buildSrt([{ start: 0, end: 4, text: words.join(' ') }]);

    expect(srt.split('\n\n')).toHaveLength(1);
  });
});
