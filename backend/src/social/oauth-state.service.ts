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
  // Rotation (cf. .env.example) : un consentement OAuth en cours au moment exact d'un
  // déploiement a été signé sous l'ANCIEN secret, mais reviendra sur ce serveur (déjà sur
  // le nouveau secret) dans la fenêtre de TTL_MS. Sans ce filet, tourner OAUTH_STATE_SECRET
  // casserait tout flux OAuth démarré juste avant le déploiement — le state, légitime,
  // serait rejeté comme falsifié. `create()` ne signe jamais avec ce secret : seul `verify()`
  // l'accepte, en repli, le temps que les anciens states expirent naturellement (10 min).
  private readonly previousSecret: string | null;
  private static readonly TTL_MS = 10 * 60 * 1000; // 10 minutes — largement suffisant pour un consentement OAuth

  constructor(private readonly config: ConfigService) {
    // Secret dédié plutôt que de réutiliser JWT_SECRET : une compromission de l'un ne doit
    // pas automatiquement compromettre l'autre.
    this.secret = this.config.get<string>('OAUTH_STATE_SECRET') ?? this.config.get<string>('JWT_SECRET', 'dev-secret-change-me');
    this.previousSecret = this.config.get<string>('OAUTH_STATE_SECRET_PREVIOUS') ?? null;
  }

  create(organizationId: string): string {
    const nonce = randomBytes(8).toString('hex');
    const expiresAt = Date.now() + OAuthStateService.TTL_MS;
    const payload = `${organizationId}.${nonce}.${expiresAt}`;
    const signature = this.sign(payload, this.secret);
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

    // Accepté si signé par le secret courant, ou (repli) par l'ancien secret encore valide
    // pendant une rotation — cf. commentaire de `previousSecret` ci-dessus.
    const validUnderCurrent = this.matchesSignature(payload, signature, this.secret);
    const validUnderPrevious = !validUnderCurrent && this.previousSecret !== null && this.matchesSignature(payload, signature, this.previousSecret);
    if (!validUnderCurrent && !validUnderPrevious) {
      throw new BadRequestException('Signature du paramètre state invalide');
    }

    const expiresAt = parseInt(expiresAtStr, 10);
    if (Number.isNaN(expiresAt) || Date.now() > expiresAt) {
      throw new BadRequestException('Paramètre state expiré — relancez la connexion');
    }

    return organizationId;
  }

  // Comparaison en temps constant — évite qu'une différence de timing sur la comparaison
  // de signature ne fuite d'information exploitable pour la forger progressivement.
  private matchesSignature(payload: string, signature: string, secret: string): boolean {
    const expectedSignature = this.sign(payload, secret);
    const providedBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
  }

  private sign(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }
}
