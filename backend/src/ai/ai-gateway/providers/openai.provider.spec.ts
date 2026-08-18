import { OpenAiProvider } from './openai.provider';
import { ConfigService } from '@nestjs/config';

function buildConfig() {
  return { get: () => 'test-api-key' } as unknown as ConfigService;
}

function mockImageResponse() {
  return { ok: true, json: async () => ({ data: [{ b64_json: 'ZmFrZQ==' }] }) };
}

// Chantier "fidélité visuelle du visuel marketing" (2026-08-18) : bug réel constaté en
// conditions réelles — sans ancrage sur une image de référence, le visuel publicitaire pouvait
// représenter un produit/une marque différente de celle réellement injectée (pure génération
// texte-vers-image). Couvre le nouveau chemin d'édition ancrée (/v1/images/edits) et la
// non-régression du chemin existant (/v1/images/generations) sans imageUrl.
describe('OpenAiProvider.generateImage — ancrage sur une image de référence (imageUrl)', () => {
  it("sans imageUrl : appelle /v1/images/generations (comportement inchangé), jamais /v1/images/edits", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockImageResponse()) as any;
    const provider = new OpenAiProvider(buildConfig());

    await provider.generateImage({ prompt: 'un visuel publicitaire' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(init.body).toContain('"prompt":"un visuel publicitaire"');
  });

  it('imageUrl en data URI : décodé directement (aucun fetch réseau pour la récupérer), un seul appel réseau total vers /v1/images/edits', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockImageResponse()) as any;
    const provider = new OpenAiProvider(buildConfig());

    await provider.generateImage({ prompt: 'x', imageUrl: 'data:image/png;base64,ZmFrZQ==' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('imageUrl en URL HTTP : récupérée par fetch puis envoyée en multipart — 2 appels réseau au total', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      })
      .mockResolvedValueOnce(mockImageResponse()) as any;
    const provider = new OpenAiProvider(buildConfig());

    await provider.generateImage({ prompt: 'x', imageUrl: 'https://cdn.example.com/produit.png' });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [firstUrl] = (global.fetch as jest.Mock).mock.calls[0];
    const [secondUrl] = (global.fetch as jest.Mock).mock.calls[1];
    expect(firstUrl).toBe('https://cdn.example.com/produit.png');
    expect(secondUrl).toBe('https://api.openai.com/v1/images/edits');
  });

  it("échec de récupération de l'image de référence : erreur explicite, l'édition n'est jamais tentée", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 404 }) as any;
    const provider = new OpenAiProvider(buildConfig());

    await expect(provider.generateImage({ prompt: 'x', imageUrl: 'https://cdn.example.com/absent.png' })).rejects.toThrow(
      "impossible de récupérer l'image de référence",
    );
    expect(global.fetch).toHaveBeenCalledTimes(1); // pas de 2e appel (édition) après l'échec du 1er
  });
});
