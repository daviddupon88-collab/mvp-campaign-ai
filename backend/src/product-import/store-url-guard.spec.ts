import { BadRequestException } from '@nestjs/common';
import { assertPublicStoreUrl } from './store-url-guard';

// Vérifie explicitement la correction de la vulnérabilité SSRF (cf. commentaire de classe
// dans store-url-guard.ts) : une URL de boutique ne doit être acceptée que si elle est en
// https ET résout vers une adresse publique — tout le reste doit être rejeté, jamais
// silencieusement ignoré. exemple.com/example.org sont garantis publics (RFC 2606,
// réservés par l'IANA pour la documentation), donc stables pour un test qui fait une vraie
// résolution DNS sans dépendre d'un domaine tiers qui pourrait changer d'IP.
describe('assertPublicStoreUrl', () => {
  it('rejette un schéma non-https', async () => {
    await expect(assertPublicStoreUrl('http://example.com')).rejects.toThrow(BadRequestException);
    await expect(assertPublicStoreUrl('ftp://example.com')).rejects.toThrow(BadRequestException);
    await expect(assertPublicStoreUrl('file:///etc/passwd')).rejects.toThrow(BadRequestException);
  });

  it('rejette une URL malformée', async () => {
    await expect(assertPublicStoreUrl('pas-une-url')).rejects.toThrow(BadRequestException);
  });

  it('rejette une IP littérale en boucle locale', async () => {
    await expect(assertPublicStoreUrl('https://127.0.0.1/admin')).rejects.toThrow(BadRequestException);
  });

  it('rejette le endpoint de métadonnées cloud (169.254.169.254)', async () => {
    await expect(assertPublicStoreUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(BadRequestException);
  });

  it('rejette une IP littérale en plage privée (RFC 1918)', async () => {
    await expect(assertPublicStoreUrl('https://10.0.0.5')).rejects.toThrow(BadRequestException);
    await expect(assertPublicStoreUrl('https://192.168.1.1')).rejects.toThrow(BadRequestException);
    await expect(assertPublicStoreUrl('https://172.16.0.1')).rejects.toThrow(BadRequestException);
  });

  it('rejette une IPv6 en boucle locale ou link-local', async () => {
    await expect(assertPublicStoreUrl('https://[::1]')).rejects.toThrow(BadRequestException);
    await expect(assertPublicStoreUrl('https://[fe80::1]')).rejects.toThrow(BadRequestException);
  });

  it('accepte un domaine public réel (résolution DNS effective)', async () => {
    await expect(assertPublicStoreUrl('https://example.com')).resolves.toBeUndefined();
  }, 15_000);
});
