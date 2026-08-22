import { BadRequestException } from '@nestjs/common';
import { assertValidProductPageUrl } from './product-page-url-validator';

// Mission 4.4 (Product URL Intelligence, Phase A) — mêmes cas que store-url-guard.spec.ts, plus
// la différence de politique assumée (http:// accepté ici, jamais côté boutique) et la limite de
// longueur. example.com/example.org sont garantis publics (RFC 2606) — stable pour un test qui
// fait une vraie résolution DNS.
describe('assertValidProductPageUrl', () => {
  it('accepte http:// (contrairement à assertPublicStoreUrl) — une page produit redirige souvent depuis http', async () => {
    await expect(assertValidProductPageUrl('http://example.com')).resolves.toBeInstanceOf(URL);
  }, 15_000);

  it('accepte https://', async () => {
    await expect(assertValidProductPageUrl('https://example.com/produit')).resolves.toBeInstanceOf(URL);
  }, 15_000);

  it('rejette un protocole non-http(s)', async () => {
    await expect(assertValidProductPageUrl('ftp://example.com')).rejects.toThrow(BadRequestException);
    await expect(assertValidProductPageUrl('file:///etc/passwd')).rejects.toThrow(BadRequestException);
  });

  it('rejette une URL malformée', async () => {
    await expect(assertValidProductPageUrl('pas-une-url')).rejects.toThrow(BadRequestException);
  });

  it('rejette une URL trop longue', async () => {
    const tooLong = 'https://example.com/' + 'a'.repeat(2100);
    await expect(assertValidProductPageUrl(tooLong)).rejects.toThrow(BadRequestException);
  });

  it('rejette une IP littérale en boucle locale', async () => {
    await expect(assertValidProductPageUrl('http://127.0.0.1/admin')).rejects.toThrow(BadRequestException);
  });

  it('rejette le endpoint de métadonnées cloud (169.254.169.254)', async () => {
    await expect(assertValidProductPageUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(BadRequestException);
  });

  it('rejette une IP littérale en plage privée (RFC 1918)', async () => {
    await expect(assertValidProductPageUrl('http://10.0.0.5')).rejects.toThrow(BadRequestException);
    await expect(assertValidProductPageUrl('http://192.168.1.1')).rejects.toThrow(BadRequestException);
    await expect(assertValidProductPageUrl('http://172.16.0.1')).rejects.toThrow(BadRequestException);
  });

  it('rejette une IPv6 en boucle locale ou link-local', async () => {
    await expect(assertValidProductPageUrl('http://[::1]')).rejects.toThrow(BadRequestException);
    await expect(assertValidProductPageUrl('http://[fe80::1]')).rejects.toThrow(BadRequestException);
  });

  it('rejette localhost (résolution DNS -> 127.0.0.1)', async () => {
    await expect(assertValidProductPageUrl('http://localhost')).rejects.toThrow(BadRequestException);
  }, 15_000);
});
