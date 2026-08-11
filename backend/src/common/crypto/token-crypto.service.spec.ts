import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { TokenCryptoService } from './token-crypto.service';

describe('TokenCryptoService', () => {
  function buildService(key?: string): TokenCryptoService {
    const config = { get: (k: string) => (k === 'TOKEN_ENCRYPTION_KEY' ? key : undefined) } as unknown as ConfigService;
    return new TokenCryptoService(config);
  }

  it('chiffre puis déchiffre un token, retrouvant la valeur d\'origine', () => {
    const key = randomBytes(32).toString('base64');
    const service = buildService(key);
    const plaintext = 'ya29.a0AfH6SMC-secret-access-token';

    const encrypted = service.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext); // ne doit jamais rester en clair
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it('produit un chiffré différent à chaque appel pour le même texte (IV aléatoire)', () => {
    const key = randomBytes(32).toString('base64');
    const service = buildService(key);
    const plaintext = 'same-token-value';

    const first = service.encrypt(plaintext);
    const second = service.encrypt(plaintext);
    expect(first).not.toBe(second); // sinon deux tokens identiques seraient reconnaissables en base
  });

  it('rejette une clé de taille incorrecte au démarrage', () => {
    expect(() => buildService(Buffer.from('trop-courte').toString('base64'))).toThrow();
  });

  it('sans clé configurée, se comporte en pass-through (dev uniquement)', () => {
    const service = buildService(undefined);
    const plaintext = 'plain-value';
    expect(service.encrypt(plaintext)).toBe(plaintext);
    expect(service.decrypt(plaintext)).toBe(plaintext);
  });

  it('ne plante pas sur une valeur non chiffrée passée à decrypt (donnée pré-chiffrement)', () => {
    const key = randomBytes(32).toString('base64');
    const service = buildService(key);
    expect(service.decrypt('valeur-non-chiffree-heritee')).toBe('valeur-non-chiffree-heritee');
  });
});
