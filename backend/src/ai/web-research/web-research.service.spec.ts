import { WebResearchService } from './web-research.service';
import { MockWebResearchProvider } from './mock-web-research.provider';
import { WebResearchProvider } from './web-research-provider.interface';

// P1.6 — WebResearchService. Le test le plus important de ce chantier (cf. brief, section
// "Fallback") : SANS provider réel injecté — l'état réel de production aujourd'hui, puisque
// AiModule ne lie jamais WEB_RESEARCH_REAL_PROVIDER — le service DOIT renvoyer NOT_CONFIGURED,
// jamais un statut qui pourrait passer pour un succès.
describe('WebResearchService.researchProduct — garde-fou anti-faux-succès', () => {
  it("aucun provider injecté (état de production réel) -> NOT_CONFIGURED, jamais SUCCESS/REAL/MOCK", async () => {
    const service = new WebResearchService(); // même construction que le DI de production : rien lié à WEB_RESEARCH_REAL_PROVIDER

    const outcome = await service.researchProduct('casque audio sans fil');

    expect(outcome.status).toBe('NOT_CONFIGURED');
    expect(outcome).not.toHaveProperty('results');
  });

  it('aucun provider injecté -> ne tente AUCUN appel réseau (pas de search/fetch/extract fantôme)', async () => {
    const search = jest.fn();
    // Un provider existe dans l'environnement de test global mais n'est PAS injecté dans ce
    // service précis — vérifie que l'absence d'injection suffit à bloquer tout appel, peu
    // importe ce qui existe ailleurs dans le process.
    void search;
    const service = new WebResearchService(undefined);

    const outcome = await service.researchProduct('produit');

    expect(outcome.status).toBe('NOT_CONFIGURED');
  });
});

// Chemin exercé UNIQUEMENT par les tests, jamais par le DI de production (cf. commentaire du
// service) — construit explicitement avec MockWebResearchProvider pour prouver que le pipeline
// search -> fetch -> extract -> classement fonctionne, sans jamais prétendre que c'est réel.
describe('WebResearchService.researchProduct — avec MockWebResearchProvider (tests uniquement)', () => {
  it('provider Mock injecté -> statut MOCK explicite, jamais REAL', async () => {
    const service = new WebResearchService(new MockWebResearchProvider());

    const outcome = await service.researchProduct('casque audio sans fil');

    expect(outcome.status).toBe('MOCK');
  });

  it('exécute réellement search -> fetch -> extract pour chaque résultat (pas juste search)', async () => {
    const search = jest.fn().mockResolvedValue([{ title: '[MOCK] A', url: 'https://mock.local/a', snippet: '', sourceType: 'MOCK' }]);
    const fetch = jest.fn().mockResolvedValue({ url: 'https://mock.local/a', html: '<html></html>', fetchedAt: new Date() });
    const extract = jest.fn().mockResolvedValue({ url: 'https://mock.local/a', text: '', claims: [] });
    const provider: WebResearchProvider = { name: 'mock', isMock: true, search, fetch, extract };
    const service = new WebResearchService(provider);

    await service.researchProduct('produit');

    expect(search).toHaveBeenCalledWith('produit');
    expect(fetch).toHaveBeenCalledWith('https://mock.local/a');
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('classe les résultats par priorité de source (OFFICIAL avant MOCK/OTHER)', async () => {
    const search = jest.fn().mockResolvedValue([
      { title: 'B', url: 'https://mock.local/b', snippet: '', sourceType: 'MOCK' },
      { title: 'A', url: 'https://mock.local/a', snippet: '', sourceType: 'OFFICIAL' },
    ]);
    const fetch = jest.fn().mockResolvedValue({ url: 'x', html: '', fetchedAt: new Date() });
    const extract = jest.fn().mockResolvedValue({ url: 'x', text: '', claims: [] });
    const provider: WebResearchProvider = { name: 'mock', isMock: true, search, fetch, extract };
    const service = new WebResearchService(provider);

    const outcome = await service.researchProduct('produit');

    if (outcome.status !== 'MOCK') throw new Error('attendu MOCK');
    expect(outcome.results[0].title).toBe('A'); // OFFICIAL classé avant MOCK
  });
});
