import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Test E2E réel — démarre l'application NestJS complète et exerce l'API HTTP via supertest,
// exactement comme le ferait un client réel. Nécessite Postgres et Redis actifs
// (`docker compose up -d`, cf. README) : ce test n'a PAS été exécuté dans l'environnement
// où ce code a été écrit (pas de base de données disponible dans ce sandbox), mais est
// prêt à s'exécuter tel quel dans un environnement de développement ou de CI configuré
// (cf. .github/workflows/ci.yml, qui provisionne Postgres/Redis en services).
describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // Email unique par exécution pour ne jamais entrer en collision avec une exécution
  // précédente sur la même base — un test E2E ne doit pas dépendre d'un état préalable nettoyé.
  const uniqueEmail = `e2e-${Date.now()}@example.com`;
  const password = 'motdepasse-solide-123';

  it('POST /api/auth/register crée un compte et une organisation, renvoie un accessToken', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: uniqueEmail, password, fullName: 'Test E2E', organizationName: 'Organisation E2E' })
      .expect(201);

    expect(response.body.accessToken).toBeDefined();
    expect(response.body.user.email).toBe(uniqueEmail);
    expect(response.body.user.role).toBe('OWNER');
  });

  it('POST /api/auth/register refuse un email déjà utilisé', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: uniqueEmail, password, fullName: 'Doublon', organizationName: 'Autre organisation' })
      .expect(409);
  });

  it('POST /api/auth/login réussit avec les bons identifiants', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: uniqueEmail, password })
      .expect(201); // NestJS renvoie 201 par défaut sur un @Post sans @HttpCode explicite

    expect(response.body.accessToken).toBeDefined();
  });

  it('POST /api/auth/login échoue avec un mauvais mot de passe, sans révéler quel champ est incorrect', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: uniqueEmail, password: 'mauvais-mot-de-passe' })
      .expect(401);

    // Le message ne doit jamais indiquer si c'est l'email ou le mot de passe qui est en cause.
    expect(response.body.message.toLowerCase()).not.toContain('mot de passe incorrect');
  });

  it('GET /api/auth/me exige une authentification', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });

  it('GET /api/auth/me retourne les organisations de l\'utilisateur avec un token valide', async () => {
    const loginResponse = await request(app.getHttpServer()).post('/api/auth/login').send({ email: uniqueEmail, password });
    const token = loginResponse.body.accessToken;

    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.organizations.length).toBeGreaterThanOrEqual(1);
  });
});
