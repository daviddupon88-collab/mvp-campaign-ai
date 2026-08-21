import { MockWebResearchProvider } from './mock-web-research.provider';
import { SourceType } from './web-research.types';

// P1.3 — Mock Web Research Provider. Couvre les cas du brief : search/fetch/extract
// fonctionnent, ET toute donnée renvoyée reste clairement identifiable comme MOCK — jamais
// confondue avec une donnée web réelle, même si ce provider était injecté par erreur ailleurs.
describe('MockWebResearchProvider', () => {
  it('isMock=true, name="mock" — jamais présenté comme un fournisseur réel', () => {
    const provider = new MockWebResearchProvider();

    expect(provider.isMock).toBe(true);
    expect(provider.name).toBe('mock');
  });

  it('search() renvoie des résultats clairement étiquetés [MOCK] et sourceType MOCK', async () => {
    const provider = new MockWebResearchProvider();

    const results = await provider.search('casque audio sans fil');

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.title).toContain('[MOCK]');
      expect(result.sourceType).toBe(SourceType.MOCK);
    }
  });

  it('fetch() renvoie une page clairement étiquetée [MOCK CONTENT]', async () => {
    const provider = new MockWebResearchProvider();

    const page = await provider.fetch('https://example.com/produit');

    expect(page.url).toBe('https://example.com/produit');
    expect(page.html).toContain('[MOCK CONTENT]');
    expect(page.fetchedAt).toBeInstanceOf(Date);
  });

  it('extract() renvoie du texte et des claims clairement étiquetés [MOCK]', async () => {
    const provider = new MockWebResearchProvider();
    const page = await provider.fetch('https://example.com/produit');

    const extracted = await provider.extract(page);

    expect(extracted.text).toContain('[MOCK');
    expect(extracted.claims.length).toBeGreaterThan(0);
    expect(extracted.claims[0].claim).toContain('[MOCK CLAIM]');
  });
});
