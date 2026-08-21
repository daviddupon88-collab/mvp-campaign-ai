import { parseAiJson, stripJsonCodeFence } from './parse-ai-json';

describe('stripJsonCodeFence', () => {
  it('retire une enveloppe ```json ... ``` complète', () => {
    const wrapped = '```json\n{"a":1}\n```';
    expect(stripJsonCodeFence(wrapped)).toBe('{"a":1}');
  });

  it('retire une enveloppe ``` ... ``` sans le mot "json"', () => {
    const wrapped = '```\n{"a":1}\n```';
    expect(stripJsonCodeFence(wrapped)).toBe('{"a":1}');
  });

  it('laisse un JSON déjà brut inchangé (comportement historique, cas le plus fréquent)', () => {
    expect(stripJsonCodeFence('{"a":1}')).toBe('{"a":1}');
  });

  it('gère les espaces/retours à la ligne superflus autour de la réponse', () => {
    expect(stripJsonCodeFence('  \n```json\n{"a":1}\n```  \n')).toBe('{"a":1}');
  });
});

describe('parseAiJson', () => {
  it('parse correctement une réponse enveloppée dans un bloc markdown — le bug réel corrigé le 2026-08-19', () => {
    const wrapped = '```json\n{"hook":"vrai hook","cta":"vrai cta"}\n```';
    expect(parseAiJson(wrapped)).toEqual({ hook: 'vrai hook', cta: 'vrai cta' });
  });

  it('parse toujours correctement un JSON brut (comportement historique inchangé)', () => {
    expect(parseAiJson('{"x":true}')).toEqual({ x: true });
  });

  it('un JSON réellement invalide (pas juste enveloppé) continue de lever — le repli neutre reste la responsabilité de chaque appelant', () => {
    expect(() => parseAiJson('ceci n\'est pas du JSON')).toThrow();
  });
});
