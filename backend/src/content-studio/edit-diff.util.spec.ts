import { diffWords, normalizeWord } from './edit-diff.util';

describe('normalizeWord', () => {
  it('met en minuscules et retire les accents', () => {
    expect(normalizeWord('Révolutionnaire')).toBe('revolutionnaire');
    expect(normalizeWord('Découvrez')).toBe('decouvrez');
  });

  it('retire la ponctuation', () => {
    expect(normalizeWord('incroyable!')).toBe('incroyable');
    expect(normalizeWord('« produit »')).toBe('produit');
  });
});

describe('diffWords', () => {
  it("détecte un mot retiré (exemple de la Phase 4 : adjectif marketing excessif)", () => {
    const { removed, added } = diffWords('Découvrez notre solution révolutionnaire.', 'Découvrez notre solution.');
    expect(removed).toEqual(['revolutionnaire']);
    expect(added).toEqual([]);
  });

  it('détecte un mot ajouté', () => {
    const { removed, added } = diffWords('Achetez maintenant.', 'Achetez notre produit maintenant.');
    expect(added).toEqual(['produit']);
    expect(removed).toEqual([]);
  });

  it('filtre les mots-outils et les mots courts (bruit grammatical)', () => {
    const { removed, added } = diffWords('Le produit est là.', 'Un produit est ici.');
    // "le"/"un"/"là"/"ici" sont soit des mots-outils soit trop courts — seul un vrai
    // changement lexical significatif doit ressortir.
    expect(removed).not.toContain('le');
    expect(added).not.toContain('un');
  });

  it('ne signale rien quand les textes sont identiques', () => {
    const { removed, added } = diffWords('Texte identique.', 'Texte identique.');
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  });

  it("ignore l'ordre des mots — seule la présence/absence compte", () => {
    const { removed, added } = diffWords('Produit rapide et fiable', 'Fiable et rapide produit');
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  });
});
