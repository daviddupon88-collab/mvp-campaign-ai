import { BadRequestException } from '@nestjs/common';
import { SafeProductPageFetcherService } from './safe-product-page-fetcher.service';

function mockResponse(opts: { status?: number; contentType?: string; body?: string; location?: string; bodyStream?: boolean }): Response {
  const headers = new Headers();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  if (opts.location) headers.set('location', opts.location);
  const body = opts.body ?? '';
  return new Response(body, { status: opts.status ?? 200, headers });
}

describe('SafeProductPageFetcherService.fetch', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('URL invalide dès le départ : rejette (jamais un warning silencieux)', async () => {
    const service = new SafeProductPageFetcherService();
    await expect(service.fetch('ftp://example.com')).rejects.toThrow(BadRequestException);
  });

  it('récupère une page HTML 200 avec succès', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html>ok</html>' }));
    const service = new SafeProductPageFetcherService();

    const result = await service.fetch('https://example.com/produit');

    expect(result.statusCode).toBe(200);
    expect(result.html).toBe('<html>ok</html>');
    expect(result.warnings).toEqual([]);
  });

  it('suit une redirection publique (302) et revalide la cible', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: 'https://example.com/produit-final' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, contentType: 'text/html', body: '<html>final</html>' }));
    global.fetch = fetchMock;
    const service = new SafeProductPageFetcherService();

    const result = await service.fetch('https://example.com/produit');

    expect(result.finalUrl).toBe('https://example.com/produit-final');
    expect(result.html).toBe('<html>final</html>');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejette une redirection vers une adresse privée (SSRF) — jamais un warning, un vrai rejet', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ status: 302, location: 'http://169.254.169.254/latest/meta-data' }));
    const service = new SafeProductPageFetcherService();

    await expect(service.fetch('https://example.com/produit')).rejects.toThrow(BadRequestException);
  });

  it('abandonne après trop de redirections', async () => {
    global.fetch = jest.fn().mockImplementation(() => Promise.resolve(mockResponse({ status: 302, location: 'https://example.com/next' })));
    const service = new SafeProductPageFetcherService();

    const result = await service.fetch('https://example.com/produit');

    expect(result.html).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('Trop de redirections'))).toBe(true);
  });

  it('content-type inattendu (non-HTML) : retourne un résultat sans html, avec warning, ne lève jamais', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4' }));
    const service = new SafeProductPageFetcherService();

    const result = await service.fetch('https://example.com/produit.pdf');

    expect(result.html).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('Type de contenu inattendu'))).toBe(true);
  });

  it('timeout/erreur réseau : retourne un résultat sans html, avec warning, ne lève jamais', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network timeout'));
    const service = new SafeProductPageFetcherService();

    const result = await service.fetch('https://example.com/produit');

    expect(result.html).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('inaccessible'))).toBe(true);
  });

  it('réponse surdimensionnée : tronque et signale, ne plante jamais', async () => {
    const bigBody = 'a'.repeat(6_000_000);
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ status: 200, contentType: 'text/html', body: bigBody }));
    const service = new SafeProductPageFetcherService();

    const result = await service.fetch('https://example.com/produit');

    expect(result.html).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('taille maximale'))).toBe(true);
  }, 20_000);

  it('redirection sans en-tête Location : résultat vide avec warning, ne plante jamais', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ status: 302 }));
    const service = new SafeProductPageFetcherService();

    const result = await service.fetch('https://example.com/produit');

    expect(result.html).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('sans en-tête Location'))).toBe(true);
  });

  // Mission 4.5 (Phase 1 — instrumentation) : fetchDurationMs/redirectCount étaient auparavant
  // calculables (durée du fetch, boucle de redirection) mais jamais exposés sur le résultat.
  describe('instrumentation (fetchDurationMs / redirectCount)', () => {
    it('succès direct (0 redirection) : redirectCount=0, fetchDurationMs mesuré', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockResponse({ status: 200, contentType: 'text/html', body: '<html>ok</html>' }));
      const service = new SafeProductPageFetcherService();

      const result = await service.fetch('https://example.com/produit');

      expect(result.redirectCount).toBe(0);
      expect(result.fetchDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('une redirection suivie : redirectCount=1', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(mockResponse({ status: 302, location: 'https://example.com/produit-final' }))
        .mockResolvedValueOnce(mockResponse({ status: 200, contentType: 'text/html', body: '<html>final</html>' }));
      global.fetch = fetchMock;
      const service = new SafeProductPageFetcherService();

      const result = await service.fetch('https://example.com/produit');

      expect(result.redirectCount).toBe(1);
    });

    it('échec réseau : redirectCount/fetchDurationMs présents même sur le chemin d\'erreur', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network timeout'));
      const service = new SafeProductPageFetcherService();

      const result = await service.fetch('https://example.com/produit');

      expect(result.redirectCount).toBe(0);
      expect(result.fetchDurationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
