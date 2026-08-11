import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // taille recommandée pour GCM

// Chiffrement symétrique des identifiants sensibles au repos (tokens OAuth des réseaux
// sociaux et des boutiques e-commerce) — ce sont des secrets qui permettent d'agir au nom
// du client (publier, lire son catalogue) ; les stocker en clair en base est une faute de
// sécurité de base pour un vrai socle SaaS. Format stocké : "iv:authTag:ciphertext" (base64).
//
// TOKEN_ENCRYPTION_KEY doit être une clé de 32 octets encodée en base64 (générée une fois,
// ex: `openssl rand -base64 32`), stable pour toute la durée de vie des données chiffrées —
// la faire tourner nécessite de déchiffrer puis rechiffrer tous les tokens existants
// (procédure de rotation non implémentée ici, cf. roadmap).
@Injectable()
export class TokenCryptoService {
  private readonly logger = new Logger(TokenCryptoService.name);
  private readonly key: Buffer | null;

  constructor(private readonly config: ConfigService) {
    const rawKey = this.config.get<string>('TOKEN_ENCRYPTION_KEY');
    if (!rawKey) {
      this.logger.warn(
        'TOKEN_ENCRYPTION_KEY absente — les tokens seront stockés EN CLAIR. ' +
          'À ne jamais utiliser en production (cf. .env.example).',
      );
      this.key = null;
      return;
    }
    const decoded = Buffer.from(rawKey, 'base64');
    if (decoded.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY doit correspondre à 32 octets encodés en base64 (ex: `openssl rand -base64 32`)');
    }
    this.key = decoded;
  }

  encrypt(plaintext: string): string {
    if (!this.key) return plaintext; // dev sans clé configurée — voir avertissement au démarrage
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(stored: string): string {
    if (!this.key) return stored;
    const parts = stored.split(':');
    if (parts.length !== 3) {
      // Valeur non chiffrée (ex: donnée créée avant configuration de la clé) — on la
      // renvoie telle quelle plutôt que de planter, pour ne pas bloquer les connexions
      // existantes ; elles seront rechiffrées au prochain refresh de token.
      return stored;
    }
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
