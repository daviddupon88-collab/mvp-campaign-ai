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

// bytesBase64Encoded sous response.videos[0], jamais response.predictions[0].videoUri (ce
// dernier champ n'existe dans aucune version documentée de l'API Vertex AI — cf. le correctif
// du 2026-08-16 dans GoogleVeoProvider.pollUntilComplete). Reflète la forme réelle de réponse
// obtenue SANS `storageUri` dans la requête (choix délibéré du provider).
function mockFetchSequence(bytesBase64Encoded = Buffer.from('fake-video-bytes').toString('base64'), mimeType = 'video/mp4') {
  const fetchMock = jest
    .fn()
    // 1) soumission de l'opération longue
    .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'operations/op-1' }) })
    // 2) premier (et unique) poll : terminé immédiatement
    .mockResolvedValueOnce({ ok: true, json: async () => ({ done: true, response: { videos: [{ bytesBase64Encoded, mimeType }] } }) });
  global.fetch = fetchMock as any;
  return fetchMock;
}

describe('GoogleVeoProvider.generateVideo — coût réel', () => {
  it('costEstimate = durationSeconds demandé × $0.05/s', async () => {
    mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    const result = await provider.generateVideo({ prompt: 'test', durationSeconds: 5 });

    expect(result.costEstimate).toBe(0.25); // 5s × $0.05
  }, 10_000);

  it('costEstimate reflète la durée par défaut (8s) quand durationSeconds n\'est pas fourni', async () => {
    mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    const result = await provider.generateVideo({ prompt: 'test' });

    expect(result.costEstimate).toBe(0.4); // 8s × $0.05 — le coût réel d'une vidéo par défaut
  }, 10_000);

  it('envoie bien la durationSeconds effective à l\'API Veo, pas seulement au calcul de coût', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test', durationSeconds: 12 });

    const submitCallBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(submitCallBody.parameters.durationSeconds).toBe(12);
  }, 10_000);
});

// Régression du bug du 2026-08-16 : la réponse Veo réelle place la vidéo sous
// `response.videos[0].bytesBase64Encoded`, jamais sous `response.predictions[0].videoUri` (ce
// dernier n'existe dans aucune version documentée de l'API) — sans ce correctif, tout appel Veo
// qui aurait réussi authentification + génération échouait quand même à l'étape de lecture de
// la réponse, indépendamment des credentials.
describe('GoogleVeoProvider.generateVideo — format de réponse réel', () => {
  it('décode bytesBase64Encoded en data URI (content), pas un champ videoUri qui n\'existe pas', async () => {
    const rawBytes = Buffer.from('fake-video-bytes');
    mockFetchSequence(rawBytes.toString('base64'), 'video/mp4');
    const provider = new GoogleVeoProvider(buildConfig());

    const result = await provider.generateVideo({ prompt: 'test' });

    expect(result.content).toBe(`data:video/mp4;base64,${rawBytes.toString('base64')}`);
  }, 10_000);

  it('n\'active jamais generateAudio côté Veo — l\'audio final est garanti en aval par VideoAssemblyService/VideoQcService', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test' });

    const submitCallBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(submitCallBody.parameters.generateAudio).toBe(false);
  }, 10_000);
});

// Régression du bug du 2026-08-17 : le polling utilisait un GET générique sur le nom de
// l'opération (pattern "Long-running operations" générique de Google Cloud) — Vertex AI
// exige `models.fetchPredictOperation`, un POST sur la ressource du MODÈLE avec
// `{"operationName": "..."}` dans le corps. L'ancien GET obtenait une page HTML 404 générique
// de Google (jamais une erreur JSON API), qui faisait planter `res.json()` en SyntaxError
// opaque — masquant la vraie cause derrière une erreur de parsing illisible. Constaté en
// conditions réelles (premier test avec de vrais credentials GCP), jamais reproductible en
// mock jusqu'ici.
describe('GoogleVeoProvider.generateVideo — polling de l\'opération longue', () => {
  it('interroge via POST models.fetchPredictOperation (pas un GET sur le nom de l\'opération)', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test' });

    const [pollUrl, pollInit] = fetchMock.mock.calls[1];
    expect(pollUrl).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/veo-3.1-lite-generate-001:fetchPredictOperation',
    );
    expect(pollInit.method).toBe('POST');
    expect(JSON.parse(pollInit.body)).toEqual({ operationName: 'operations/op-1' });
  }, 10_000);

  it('remonte une erreur exploitable (pas un crash de parsing) quand le poll échoue avec un corps non-JSON', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'operations/op-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '<!DOCTYPE html>...' });
    global.fetch = fetchMock as any;
    const provider = new GoogleVeoProvider(buildConfig());

    await expect(provider.generateVideo({ prompt: 'test' })).rejects.toThrow(/Google Veo error \(poll\): 404/);
  }, 10_000);
});

// Correction du 2026-08-18 : jusqu'ici params.imageUrl était transmis par l'appelant mais
// jamais lu par ce provider — Veo générait en texte-vers-vidéo pur, sans jamais voir la vraie
// photo produit, aucune garantie de fidélité visuelle. Le champ `image` (au niveau de
// l'instance, pas `parameters`) ancre désormais la génération sur l'image de référence.
describe('GoogleVeoProvider.generateVideo — ancrage sur l\'image de référence (imageUrl)', () => {
  it('sans imageUrl : aucun champ "image" dans l\'instance envoyée (texte-vers-vidéo pur, comportement inchangé)', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test' });

    const submitCallBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(submitCallBody.instances[0]).toEqual({ prompt: 'test' });
    expect(submitCallBody.instances[0].image).toBeUndefined();
  }, 10_000);

  it('imageUrl en data URI : décodée directement, aucun appel réseau supplémentaire pour la récupérer', async () => {
    const fetchMock = mockFetchSequence();
    const provider = new GoogleVeoProvider(buildConfig());
    const imageBase64 = Buffer.from('fake-image-bytes').toString('base64');

    await provider.generateVideo({ prompt: 'test', imageUrl: `data:image/png;base64,${imageBase64}` });

    // 2 appels seulement (soumission + poll) — pas de 3e appel réseau pour une image déjà inline.
    expect(fetchMock.mock.calls).toHaveLength(2);
    const submitCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(submitCallBody.instances[0].image).toEqual({ bytesBase64Encoded: imageBase64, mimeType: 'image/png' });
  }, 10_000);

  it('imageUrl en URL HTTP : récupérée et encodée en base64 avant d\'être jointe à l\'instance', async () => {
    const imageBytes = Buffer.from('fake-image-bytes');
    const fetchMock = jest
      .fn()
      // 1) récupération de l'image de référence
      .mockResolvedValueOnce({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength) })
      // 2) soumission de l'opération longue
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: 'operations/op-1' }) })
      // 3) poll : terminé immédiatement
      .mockResolvedValueOnce({ ok: true, json: async () => ({ done: true, response: { videos: [{ bytesBase64Encoded: 'x', mimeType: 'video/mp4' }] } }) });
    global.fetch = fetchMock as any;
    const provider = new GoogleVeoProvider(buildConfig());

    await provider.generateVideo({ prompt: 'test', imageUrl: 'http://localhost:3001/uploads/photo.jpg' });

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/uploads/photo.jpg');
    const submitCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(submitCallBody.instances[0].image).toEqual({ bytesBase64Encoded: imageBytes.toString('base64'), mimeType: 'image/jpeg' });
  }, 10_000);

  it('échec de récupération de l\'image de référence : erreur explicite, pas de soumission Veo tentée', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce({ ok: false, status: 403 });
    global.fetch = fetchMock as any;
    const provider = new GoogleVeoProvider(buildConfig());

    await expect(provider.generateVideo({ prompt: 'test', imageUrl: 'http://localhost:3001/uploads/photo.jpg' })).rejects.toThrow(
      /impossible de récupérer l'image de référence.*403/,
    );
    expect(fetchMock.mock.calls).toHaveLength(1); // jamais arrivé jusqu'à la soumission
  }, 10_000);
});
