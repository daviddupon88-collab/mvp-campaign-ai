import { GoogleVeoProvider } from './google-veo.provider';
import { ConfigService } from '@nestjs/config';

// Couvre la correction de l'audit du 2026-08-13 : ce provider ne renseignait jamais
// `costEstimate`, rendant invisible le poste de coût dominant (98%+ d'une campagne) dans
// tout le reporting de marge réelle (AiEconomicsService.getMarginSummary()).
function buildConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    GOOGLE_CLOUD_PROJECT_ID: 'test-project',
    GOOGLE_CLOUD_LOCATION: 'us-central1',
    GOOGLE_CLOUD_ACCESS_TOKEN: 'static-test-token', // évite de mocker google-auth-library
    ...overrides,
  };
  return { get: (key: string, fallback?: string) => values[key] ?? fallback } as unknown as ConfigService;
}

function mockFetchSequence(videoUri = 'https://example.com/video.mp4') {
  const fetchMock = jest
    .fn()
    // 1) soumission de l'opération longue
    .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'operations/op-1' }) })
    // 2) premier (et unique) poll : terminé immédiatement
    .mockResolvedValueOnce({ ok: true, json: async () => ({ done: true, response: { predictions: [{ videoUri }] } }) });
  global.fetch = fetchMock as any;
  return fetchMock;
}

describe('GoogleVeoProvider.generateVideo — coût réel', () => {
  it('costEstimate = durationSeconds demandé × $0.50/s', async () => {
    mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    const result = await provider.generateVideo({ prompt: 'test', durationSeconds: 5 });

    expect(result.costEstimate).toBe(2.5); // 5s × $0.50
  }, 10_000);

  it('costEstimate reflète la durée par défaut (8s) quand durationSeconds n\'est pas fourni', async () => {
    mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    const result = await provider.generateVideo({ prompt: 'test' });

    expect(result.costEstimate).toBe(4); // 8s × $0.50 — le coût réel d'une vidéo par défaut
  }, 10_000);

  it('envoie bien la durationSeconds effective à l\'API Veo, pas seulement au calcul de coût', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test', durationSeconds: 12 });

    const submitCallBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(submitCallBody.parameters.durationSeconds).toBe(12);
  }, 10_000);
});
