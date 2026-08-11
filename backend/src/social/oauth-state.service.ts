import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Corrige une vulnérabilité réelle : le paramètre `state` du flux OAuth transportait
// l'organizationId en clair, non signé. N'importe qui connaissant (ou devinant) l'ID d'une
// organisation victime aurait pu démarrer son propre flux OAuth, consentir avec SON compte,
// puis rediriger le callback avec `state=<id-de-la-victime>` — liant son compte réseau
// social à l'organisation de la victime (CSRF de type "state forgery").
//
// Le state signé encode organizationId + un nonce + une expiration courte, avec une
// signature HMAC vérifiée au retour : falsifier un state valide sans connaître le secret
// serveur est infaisable, et un state volé/rejoué au-delà de 10 minutes est refusé.
@Injectable()
export class OAuthStateService {
  private readonly secret: string;
  private static readonly TTL_MS = 10 * 60 * 1000; // 10 minutes — largement suffisant pour un consentement OAuth

  constructor(private readonly config: ConfigService) {
    // Secret dédié plutôt que de réutiliser JWT_SECRET : une compromission de l'un ne doit
    // pas automatiquement compromettre l'autre.
    this.secret = this.config.get<string>('OAUTH_STATE_SECRET') ?? this.config.get<string>('JWT_SECRET', 'dev-secret-change-me');
  }

  create(organizationId: string): string {
    const nonce = randomBytes(8).toString('hex');
    const expiresAt = Date.now() + OAuthStateService.TTL_MS;
    const payload = `${organizationId}.${nonce}.${expiresAt}`;
    const signature = this.sign(payload);
    return Buffer.from(`${payload}.${signature}`).toString('base64url');
  }

  // Lève une exception explicite plutôt que de renvoyer null — un state invalide ne doit
  // jamais être traité comme "organisation inconnue", mais comme une tentative rejetée.
  verify(state: string): string {
    let decoded: string;
    try {
      decoded = Buffer.from(state, 'base64url').toString('utf8');
    } catch {
      throw new BadRequestException('Paramètre state invalide');
    }

    const parts = decoded.split('.');
    if (parts.length !== 4) throw new BadRequestException('Paramètre state invalide');
    const [organizationId, nonce, expiresAtStr, signature] = parts;

    const payload = `${organizationId}.${nonce}.${expiresAtStr}`;
    const expectedSignature = this.sign(payload);

    // Comparaison en temps constant — évite qu'une différence de timing sur la comparaison
    // de signature ne fuite d'information exploitable pour la forger progressivement.
    const providedBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      throw new BadRequestException('Signature du paramètre state invalide');
    }

    const expiresAt = parseInt(expiresAtStr, 10);
    if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
      throw new BadRequestException('Paramètre state expiré — relancez la connexion');
    }

    return organizationId;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }
}
