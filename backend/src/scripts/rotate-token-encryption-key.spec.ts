import { ConfigService } from '@nestjs/config';
import { TokenCryptoService } from '../common/crypto/token-crypto.service';
import { rotateStoredValue } from './rotate-token-encryption-key';

function buildCrypto(key: string): TokenCryptoService {
  const config = { get: (_k: string) => key } as unknown as ConfigService;
  return new TokenCryptoService(config);
}

const OLD_KEY = Buffer.alloc(32, 1).toString('base64');
const NEW_KEY = Buffer.alloc(32, 2).toString('base64');

// Vérifie explicitement qu'une rotation ne perd ni ne corrompt jamais un secret — le
// scénario catastrophe pour ce script serait de rechiffrer une valeur en perdant le
// plaintext original, rendant une connexion sociale/boutique définitivement inutilisable.
describe('rotateStoredValue', () => {
  it('déchiffre sous l\'ancienne clé, rechiffre sous la nouvelle, sans perte du plaintext', () => {
    const oldCrypto = buildCrypto(OLD_KEY);
    const newCrypto = buildCrypto(NEW_KEY);
    const plaintext = 'super-secret-access-token-123';
    const storedUnderOldKey = oldCrypto.encrypt(plaintext);

    const { value, changed } = rotateStoredValue(oldCrypto, newCrypto, storedUnderOldKey);

    expect(changed).toBe(true);
    expect(value).not.toBe(storedUnderOldKey); // effectivement rechiffré, pas une copie
    // La preuve qui compte : le résultat se déchiffre sous la NOUVELLE clé et redonne
    // exactement le plaintext d'origine.
    expect(newCrypto.decrypt(value!)).toBe(plaintext);
  });

  it('ne modifie jamais une valeur déjà en clair (pas de rotation à faire)', () => {
    const oldCrypto = buildCrypto(OLD_KEY);
    const newCrypto = buildCrypto(NEW_KEY);

    const { value, changed } = rotateStoredValue(oldCrypto, newCrypto, 'valeur-en-clair-non-chiffree');

    expect(changed).toBe(false);
    expect(value).toBe('valeur-en-clair-non-chiffree');
  });

  it('renvoie null pour une valeur null (refreshToken absent, par exemple)', () => {
    const oldCrypto = buildCrypto(OLD_KEY);
    const newCrypto = buildCrypto(NEW_KEY);

    const { value, changed } = rotateStoredValue(oldCrypto, newCrypto, null);

    expect(value).toBeNull();
    expect(changed).toBe(false);
  });

  it('rechiffre indépendamment plusieurs valeurs sans les confondre entre elles', () => {
    const oldCrypto = buildCrypto(OLD_KEY);
    const newCrypto = buildCrypto(NEW_KEY);
    const access = oldCrypto.encrypt('access-token-A');
    const refresh = oldCrypto.encrypt('refresh-token-B');

    const rotatedAccess = rotateStoredValue(oldCrypto, newCrypto, access);
    const rotatedRefresh = rotateStoredValue(oldCrypto, newCrypto, refresh);

    expect(newCrypto.decrypt(rotatedAccess.value!)).toBe('access-token-A');
    expect(newCrypto.decrypt(rotatedRefresh.value!)).toBe('refresh-token-B');
  });
});
