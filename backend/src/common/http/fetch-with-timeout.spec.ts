import { fetchWithTimeout } from './fetch-with-timeout';

describe('fetchWithTimeout', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('résout normalement quand le fournisseur répond avant le délai', async () => {
    const response = new Response('ok');
    global.fetch = jest.fn().mockResolvedValue(response);

    const result = await fetchWithTimeout('https://example.com', {}, 50);

    expect(result).toBe(response);
  });

  it('abandonne la requête (signal aborted) si le fournisseur ne répond jamais avant le délai', async () => {
    global.fetch = jest.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as any;

    await expect(fetchWithTimeout('https://example.com', {}, 10)).rejects.toThrow();
  });

  it('propage un signal déjà fourni au fetch sous-jacent, combiné au timeout', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('ok'));
    global.fetch = fetchMock;

    await fetchWithTimeout('https://example.com', { method: 'POST' }, 50);

    expect(fetchMock).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
  });
});
