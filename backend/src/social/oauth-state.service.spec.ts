import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { OAuthStateService } from './oauth-state.service';

// Ces tests vérifient explicitement la correction de la vulnérabilité de falsification de
// state (cf. commentaire de classe dans oauth-state.service.ts) : un state ne doit être
// accepté QUE s'il a été signé par ce service avec le bon secret, et QUE dans sa fenêtre
// de validité — tout le reste doit être rejeté, pas silencieusement ignoré.
describe('OAuthStateService', () => {
  function buildService(secret = 'test-secret', previousSecret?: string): OAuthStateService {
    const config = {
      get: (key: string) => {
        if (key === 'OAUTH_STATE_SECRET') return secret;
        if (key === 'OAUTH_STATE_SECRET_PREVIOUS') return previousSecret;
        return undefined;
      },
    } as unknown as ConfigService;
    return new OAuthStateService(config);
  }

  it('signe puis vérifie correctement un state légitime, retournant l\'organizationId d\'origine', () => {
    const service = buildService();
    const state = service.create('org-123');
    expect(service.verify(state)).toBe('org-123');
  });

  it('rejette un state dont l\'organizationId a été modifié après signature (falsification)', () => {
    const service = buildService();
    const state = service.create('org-victim');

    // Simule une tentative de falsification : décoder, remplacer l'organizationId, ré-encoder
    // sans connaître le secret de signature — exactement le scénario de l'attaque corrigée.
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const [, nonce, expiresAt, signature] = decoded.split('.');
    const forged = Buffer.from(`org-attacker.${nonce}.${expiresAt}.${signature}`).toString('base64url');

    expect(() => service.verify(forged)).toThrow(BadRequestException);
  });

  it('rejette un state signé avec un secret différent', () => {
    const serviceA = buildService('secret-a');
    const serviceB = buildService('secret-b');
    const state = serviceA.create('org-123');

    expect(() => serviceB.verify(state)).toThrow(BadRequestException);
  });

  it('rejette un state malformé (pas assez de segments)', () => {
    const service = buildService();
    expect(() => service.verify(Buffer.from('garbage').toString('base64url'))).toThrow(BadRequestException);
  });

  it('rejette un state expiré', () => {
    const service = buildService();
    // Fabrique directement un payload expiré (nécessite d'accéder à la logique interne via
    // une resignature manuelle avec le même secret, pour rester une vraie ligne de code
    // testée plutôt qu'une hypothèse sur le format).
    const nonce = 'aaaaaaaaaaaaaaaa';
    const expiredAt = Date.now() - 1000; // déjà expiré
    const payload = `org-123.${nonce}.${expiredAt}`;
    const signature = createHmac('sha256', 'test-secret').update(payload).digest('hex');
    const expiredState = Buffer.from(`${payload}.${signature}`).toString('base64url');

    expect(() => service.verify(expiredState)).toThrow(BadRequestException);
  });

  // Rotation de OAUTH_STATE_SECRET (cf. .env.example) : un state signé sous l'ancien secret,
  // en vol au moment d'un déploiement qui bascule le secret courant, doit rester accepté tant
  // que l'ancien secret est fourni en repli via OAUTH_STATE_SECRET_PREVIOUS.
  it('accepte un state signé sous l\'ancien secret quand OAUTH_STATE_SECRET_PREVIOUS est configuré (rotation)', () => {
    const beforeRotation = buildService('old-secret');
    const state = beforeRotation.create('org-123');

    const afterRotation = buildService('new-secret', 'old-secret');
    expect(afterRotation.verify(state)).toBe('org-123');
  });

  it('rejette un state signé sous un secret ni courant ni précédent, même avec un secret précédent configuré', () => {
    const attacker = buildService('secret-attacker');
    const state = attacker.create('org-123');

    const server = buildService('new-secret', 'old-secret');
    expect(() => server.verify(state)).toThrow(BadRequestException);
  });

  it('ne signe jamais de nouveau state avec l\'ancien secret, même quand il est configuré', () => {
    const server = buildService('new-secret', 'old-secret');
    const state = server.create('org-123');

    // Un vérificateur qui ne connaîtrait QUE l'ancien secret ne doit jamais valider un state
    // fraîchement créé — sinon la rotation ne "tournerait" jamais réellement.
    const onlyOldSecret = buildService('old-secret');
    expect(() => onlyOldSecret.verify(state)).toThrow(BadRequestException);
  });
});
