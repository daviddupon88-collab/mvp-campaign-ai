import { RunwayProvider } from './runway.provider';
import { ConfigService } from '@nestjs/config';

function buildConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = { RUNWAY_API_KEY: 'test-key', ...overrides };
  return { get: (key: string, fallback?: string) => values[key] ?? fallback } as unknown as ConfigService;
}

function mockFetchSequence(videoUrl = 'https://example.com/runway-video.mp4', estimatedCost: { credits: number } | undefined = { credits: 50 }) {
  const fetchMock = jest
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'task-1', estimatedCost }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'SUCCEEDED', output: [videoUrl] }) });
  global.fetch = fetchMock as any;
  return fetchMock;
}

describe('RunwayProvider.generateVideo', () => {
  it("exige une image source — lève une exception explicite si imageUrl est absent, sans jamais appeler l'API", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const provider = new RunwayProvider(buildConfig());

    await expect(provider.generateVideo({ prompt: 'test' })).rejects.toThrow(/image source requise/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envoie bien promptImage (image-to-video), pas un appel texte seul', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new RunwayProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test', imageUrl: 'https://example.com/visual.png' });

    const submitBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(submitBody.promptImage).toBe('https://example.com/visual.png');
    expect(submitBody.model).toBe('gen4_turbo');
  }, 10_000);

  // Deux tests séparés plutôt qu'un seul avec deux appels generateVideo() séquentiels : chaque
  // appel attend réellement ~5s (polling non simulé, même contrainte que GoogleVeoProvider) —
  // les cumuler dans un seul test frôlait le timeout sous charge (suite complète), et un test
  // qui dépasse son timeout peut laisser une requête en vol qui pollue le mock du test suivant.
  it('durée demandée <= 7s : arrondie à 5s (seule valeur courte acceptée par gen4_turbo)', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new RunwayProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test', imageUrl: 'https://example.com/visual.png', durationSeconds: 6 });

    const submitBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(submitBody.duration).toBe(5);
  }, 10_000);

  it('durée demandée > 7s : arrondie à 10s', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new RunwayProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test', imageUrl: 'https://example.com/visual.png', durationSeconds: 12 });

    const submitBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(submitBody.duration).toBe(10);
  }, 10_000);

  it('costEstimate dérivé des crédits réellement facturés par Runway (estimatedCost.credits), pas une constante', async () => {
    mockFetchSequence(undefined, { credits: 50 });
    const provider = new RunwayProvider(buildConfig());

    const result = await provider.generateVideo({ prompt: 'test', imageUrl: 'https://example.com/visual.png', durationSeconds: 12 });

    expect(result.costEstimate).toBe(0.5); // 50 crédits × $0.01
  }, 10_000);

  it("retourne l'URL vidéo une fois le polling terminé (SUCCEEDED)", async () => {
    mockFetchSequence('https://example.com/final.mp4');
    const provider = new RunwayProvider(buildConfig());

    const result = await provider.generateVideo({ prompt: 'test', imageUrl: 'https://example.com/visual.png' });

    expect(result.content).toBe('https://example.com/final.mp4');
    expect(result.provider).toBe('runway');
  }, 10_000);

  it('remonte une erreur explicite si Runway renvoie FAILED', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'task-1', estimatedCost: { credits: 50 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'FAILED', failure: 'contenu refusé' }) });
    global.fetch = fetchMock as any;
    const provider = new RunwayProvider(buildConfig());

    await expect(provider.generateVideo({ prompt: 'test', imageUrl: 'https://example.com/visual.png' })).rejects.toThrow(/contenu refusé/);
  }, 10_000);

  // Bug corrigé le 2026-08-18 (constaté en conditions réelles — bascule Veo→Runway sur une
  // vraie campagne) : Runway rejette (400, "must start with https://") toute promptImage qui
  // n'est pas https://, runway:// ou data:image/...;base64,... — or referenceImageUrl est
  // souvent une URL http:// locale (stockage de dev, jamais atteignable par Runway de toute
  // façon). Le provider doit désormais récupérer l'image lui-même et l'inliner en data URI.
  it("image source en http:// (stockage local, injoignable par Runway) : récupérée et réinjectée en data URI, jamais envoyée telle quelle", async () => {
    // 3 appels fetch dans l'ordre réel : (1) resolveMediaBuffer() récupère l'image locale,
    // (2) soumission Runway, (3) polling.
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new TextEncoder().encode('fake-png-bytes').buffer })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'task-1', estimatedCost: { credits: 50 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'SUCCEEDED', output: ['https://example.com/final.mp4'] }) });
    global.fetch = fetchMock as any;
    const provider = new RunwayProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test', imageUrl: 'http://localhost:3001/uploads/org-1/visual.png' });

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/uploads/org-1/visual.png');
    const submitBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(submitBody.promptImage).toMatch(/^data:image\/png;base64,/);
  }, 10_000);

  it('erreur HTTP à la soumission : remonte le statut et le corps de la réponse', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'quota dépassé' });
    global.fetch = fetchMock as any;
    const provider = new RunwayProvider(buildConfig());

    await expect(provider.generateVideo({ prompt: 'test', imageUrl: 'https://example.com/visual.png' })).rejects.toThrow(/403.*quota dépassé/);
  }, 10_000);
});
