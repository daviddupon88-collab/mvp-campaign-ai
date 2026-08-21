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

  it('découpe un segment long (≤5 mots) en plusieurs lignes de 36 caractères max, sans couper un mot', () => {
    // 5 mots exactement (≤ MAX_WORDS_PER_CUE) — teste le retour à la ligne seul, sans
    // déclencher le découpage en plusieurs légendes (couvert séparément ci-dessous).
    const longText = 'Cette phrase-là est volontairement longue';
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

  it('découpe un segment de plus de 5 mots en plusieurs légendes réparties à parts égales dans le temps du segment', () => {
    // 20 mots -> 4 légendes (5 + 5 + 5 + 5), sur une fenêtre [0,10] -> 4 parts égales de 2,5s.
    // Le texte de chaque légende passe aussi par wrapText (retours à la ligne) : on normalise
    // les \n en espaces avant comparaison pour isoler le découpage en légendes du retour à la ligne.
    const words = Array.from({ length: 20 }, (_, i) => `m${i + 1}`);
    const srt = service.buildSrt([{ start: 0, end: 10, text: words.join(' ') }]);
    const normalize = (block: string) => block.split('\n').join(' ');

    const blocks = srt.split('\n\n');
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toContain('00:00:00,000 --> 00:00:02,500');
    expect(normalize(blocks[0])).toContain(words.slice(0, 5).join(' '));
    expect(blocks[3]).toContain('00:00:07,500 --> 00:00:10,000');
    expect(normalize(blocks[3])).toContain(words.slice(15).join(' '));
  });

  it('segment de 5 mots exactement : une seule légende (pas de découpage au seuil)', () => {
    const words = Array.from({ length: 5 }, (_, i) => `m${i + 1}`);
    const srt = service.buildSrt([{ start: 0, end: 4, text: words.join(' ') }]);

    expect(srt.split('\n\n')).toHaveLength(1);
  });

  describe('Mission 4 Phase F — segmentation sémantique (préfère ponctuation/conjonction à la coupure mécanique)', () => {
    it('coupe après une ponctuation forte trouvée dans la fenêtre autour du budget, plutôt qu\'au mot 5 exact', () => {
      const text = 'Un produit qui change, vraiment tout le quotidien';
      const srt = service.buildSrt([{ start: 0, end: 8, text }]);
      const normalize = (block: string) => block.split('\n').slice(2).join(' ');
      const blocks = srt.split('\n\n');

      expect(blocks).toHaveLength(2);
      expect(normalize(blocks[0])).toBe('Un produit qui change,');
      expect(normalize(blocks[1])).toBe('vraiment tout le quotidien');
      expect(blocks[0]).toContain('00:00:00,000 --> 00:00:04,000');
      expect(blocks[1]).toContain('00:00:04,000 --> 00:00:08,000');
    });

    it('à défaut de ponctuation, coupe avant une conjonction trouvée dans la fenêtre', () => {
      const text = "Le produit est robuste et fiable aujourd'hui";
      const srt = service.buildSrt([{ start: 0, end: 7, text }]);
      const normalize = (block: string) => block.split('\n').slice(2).join(' ');
      const blocks = srt.split('\n\n');

      expect(blocks).toHaveLength(2);
      expect(normalize(blocks[0])).toBe('Le produit est robuste');
      expect(normalize(blocks[1])).toBe("et fiable aujourd'hui");
    });

    it('sans frontière sémantique dans la fenêtre, replie sur la coupure mécanique au budget (comportement historique)', () => {
      // Reprend le fixture existant (20 mots neutres) : confirme explicitement le filet de
      // sécurité de la Phase F, pas seulement l'ancien comportement mécanique par défaut.
      const words = Array.from({ length: 12 }, (_, i) => `mot${i + 1}`);
      const srt = service.buildSrt([{ start: 0, end: 12, text: words.join(' ') }]);
      const normalize = (block: string) => block.split('\n').slice(2).join(' ');
      const blocks = srt.split('\n\n');

      expect(blocks).toHaveLength(3);
      expect(normalize(blocks[0])).toBe(words.slice(0, 5).join(' '));
      expect(normalize(blocks[1])).toBe(words.slice(5, 10).join(' '));
      expect(normalize(blocks[2])).toBe(words.slice(10).join(' '));
    });
  });
});
