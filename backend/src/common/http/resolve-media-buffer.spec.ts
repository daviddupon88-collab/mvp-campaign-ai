import { resolveMediaBuffer } from './resolve-media-buffer';

describe('resolveMediaBuffer', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('décode un data URI directement, sans appel réseau', async () => {
    const original = Buffer.from('contenu binaire de test');
    const dataUri = `data:video/mp4;base64,${original.toString('base64')}`;
    const fetchSpy = jest.spyOn(global, 'fetch');

    const buffer = await resolveMediaBuffer(dataUri);

    expect(buffer).toEqual(original);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('télécharge une URL HTTP classique via fetch', async () => {
    const original = Buffer.from('octets distants');
    // new Uint8Array(original).buffer, pas original.buffer.slice(...) : Buffer.from(string)
    // alloue souvent depuis le pool interne de Node (mémoire partagée entre buffers créés dans
    // le même test), dont le contenu peut changer avant l'exécution asynchrone de
    // arrayBuffer() — new Uint8Array(...) copie les valeurs dans un ArrayBuffer indépendant.
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array(original).buffer }) as any;

    const buffer = await resolveMediaBuffer('https://example.com/clip.mp4');

    expect(buffer).toEqual(original);
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/clip.mp4', expect.anything());
  });

  it('URL HTTP en échec : lève une exception explicite avec le code HTTP', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as any;

    await expect(resolveMediaBuffer('https://example.com/clip.mp4')).rejects.toThrow(/récupérer le média.*503/);
  });
});
