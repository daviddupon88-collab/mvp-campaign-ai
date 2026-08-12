// Diff mécanique (pas d'appel IA) entre deux textes — volontairement simple : ensemble de
// mots plutôt qu'un diff positionnel, suffisant pour détecter des signaux répétés ("l'IA
// écrit X, l'utilisateur le retire systématiquement") sans le coût ni la latence d'un appel
// AI Gateway à chaque édition. Une vraie extraction sémantique de pattern reste une évolution
// V3 possible (cf. rapport d'audit) — ici on capture le fait brut, l'IA n'est jamais impliquée.
const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'au', 'aux', 'ce', 'ces',
  'cet', 'cette', 'son', 'sa', 'ses', 'notre', 'votre', 'leur', 'leurs', 'pour', 'dans', 'sur',
  'avec', 'par', 'est', 'sont', 'plus', 'tres', 'que', 'qui', 'quoi', 'mais', 'donc',
  'car', 'pas', 'vous', 'nous', 'ils', 'elles', 'elle', 'en',
  'ont', 'etre', 'avoir', 'vos', 'nos', 'tout', 'tous', 'toute', 'toutes',
]);

// Plage Unicode "Combining Diacritical Marks" (0x0300-0x036F) construite à partir des codes
// numériques plutôt que d'un littéral regex — un caractère combinant tapé directement dans le
// code source serait lui-même invisible et non fiable selon l'éditeur/encodage.
const COMBINING_MARKS_START = 0x0300;
const COMBINING_MARKS_END = 0x036f;
const ACCENT_MARKS_RE = new RegExp(
  `[${String.fromCharCode(COMBINING_MARKS_START)}-${String.fromCharCode(COMBINING_MARKS_END)}]`,
  'g',
);

export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(ACCENT_MARKS_RE, '') // accents
    .replace(/[^a-z0-9]/g, '');
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .split(/\s+/)
      .map(normalizeWord)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

export interface WordDiff {
  removed: string[];
  added: string[];
}

// Mots significatifs présents dans `before` mais absents de `after` (removed) et l'inverse
// (added) — les mots courts et les mots-outils sont filtrés pour ne garder que des signaux
// exploitables (adjectifs, superlatifs, termes marketing...), pas du bruit grammatical.
export function diffWords(before: string, after: string): WordDiff {
  const beforeWords = tokenize(before);
  const afterWords = tokenize(after);

  const removed = [...beforeWords].filter((w) => !afterWords.has(w)).sort();
  const added = [...afterWords].filter((w) => !beforeWords.has(w)).sort();

  return { removed, added };
}
