import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Test E2E réel (Lot F, Phase 17/19) — démarre l'application NestJS complète contre une
// vraie base Postgres, exactement comme auth.e2e-spec.ts. Certaines données de préparation
// sont injectées directement via Prisma (une BrandMemoryEntry n'est jamais créée par un
// endpoint HTTP dédié — toujours dérivée d'un événement métier réel, cf. audit) ; toutes les
// ASSERTIONS d'isolation et de comportement passent par de vraies requêtes HTTP, pas des
// appels de service internes.
//
// Organisations enregistrées UNE SEULE FOIS pour tout le fichier (dans beforeAll) plutôt que
// par test : POST /auth/register est limité à 10 requêtes/60s (cf. @Throttle sur
// AuthController) — un enregistrement par test dépasserait ce plafond légitime et ferait
// échouer la suite pour une mauvaise raison (429, pas un bug Brand Brain).
describe('Brand Brain (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orgA: { token: string; organizationId: string };
  let orgB: { token: string; organizationId: string };
  let orgShared: { token: string; organizationId: string };

  async function registerOrg(prefix: string) {
    const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'motdepasse-solide-123', fullName: 'Test E2E', organizationName: `Org ${prefix}` })
      .expect(201);
    return { token: res.body.accessToken as string, organizationId: res.body.user.organizationId as string };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    orgA = await registerOrg('tenant-a');
    orgB = await registerOrg('tenant-b');
    orgShared = await registerOrg('shared');
  });

  afterAll(async () => {
    await app.close();
  });

  // Phase 17 (CRITIQUE) : une organisation ne doit JAMAIS pouvoir lire ni agir sur la mémoire
  // de marque d'une autre, même en connaissant un id valide.
  describe('Isolation multi-tenant', () => {
    it("le Brand Kit d'une organisation n'apparaît jamais pour une autre", async () => {
      await request(app.getHttpServer())
        .put('/api/brand-kit')
        .set('Authorization', `Bearer ${orgA.token}`)
        .send({ mission: 'Mission secrète de A' })
        .expect(200);

      const bView = await request(app.getHttpServer()).get('/api/brand-kit').set('Authorization', `Bearer ${orgB.token}`).expect(200);
      expect(bView.body?.mission).not.toBe('Mission secrète de A');
    });

    it("une organisation ne peut ni lire ni agir sur une BrandMemoryEntry d'une autre organisation (confirm/dismiss/correct/promote → 404)", async () => {
      const entry = await prisma.brandMemoryEntry.create({
        data: { organizationId: orgA.organizationId, type: 'LEARNING', content: 'Connaissance privée de A', dedupKey: `e2e-${Date.now()}` },
      });

      // Absente de la liste de B — jamais une histoire globale partagée entre organisations.
      const bList = await request(app.getHttpServer()).get('/api/brand-kit/memory').set('Authorization', `Bearer ${orgB.token}`).expect(200);
      expect(bList.body.find((e: any) => e.id === entry.id)).toBeUndefined();

      // 404 (jamais 403) : ne révèle même pas l'existence de la ressource à une autre organisation.
      await request(app.getHttpServer()).post(`/api/brand-kit/memory/${entry.id}/confirm`).set('Authorization', `Bearer ${orgB.token}`).expect(404);
      await request(app.getHttpServer()).post(`/api/brand-kit/memory/${entry.id}/dismiss`).set('Authorization', `Bearer ${orgB.token}`).expect(404);
      await request(app.getHttpServer())
        .post(`/api/brand-kit/memory/${entry.id}/promote-to-rule`)
        .set('Authorization', `Bearer ${orgB.token}`)
        .send({})
        .expect(404);
      await request(app.getHttpServer())
        .patch(`/api/brand-kit/memory/${entry.id}`)
        .set('Authorization', `Bearer ${orgB.token}`)
        .send({ content: 'tentative de correction par une autre organisation' })
        .expect(404);

      // La bonne organisation, elle, peut agir normalement sur sa propre connaissance.
      await request(app.getHttpServer()).post(`/api/brand-kit/memory/${entry.id}/confirm`).set('Authorization', `Bearer ${orgA.token}`).expect(201);
    });

    it("une organisation ne peut pas résoudre une contradiction d'une autre organisation", async () => {
      const [a, b] = await Promise.all([
        prisma.brandMemoryEntry.create({ data: { organizationId: orgA.organizationId, type: 'LEARNING', content: 'Vidéos courtes', dedupKey: `e2e-a-${Date.now()}` } }),
        prisma.brandMemoryEntry.create({ data: { organizationId: orgA.organizationId, type: 'LEARNING', content: 'Vidéos longues', dedupKey: `e2e-b-${Date.now()}` } }),
      ]);
      const contradiction = await prisma.brandMemoryContradiction.create({
        data: { organizationId: orgA.organizationId, knowledgeAId: a.id, knowledgeBId: b.id, evidenceA: 1, evidenceB: 1, confidenceA: 0.3, confidenceB: 0.3 },
      });

      await request(app.getHttpServer())
        .post(`/api/brand-kit/contradictions/${contradiction.id}/resolve`)
        .set('Authorization', `Bearer ${orgB.token}`)
        .send({ resolution: 'RESOLVED_A' })
        .expect(404);
    });
  });

  // Phase 19 (intégration) : persistance réelle des mutations, pas seulement le comportement
  // en mémoire déjà couvert par les tests unitaires avec mocks. Toutes partagent orgShared —
  // chaque test crée ses propres entrées indépendantes, aucune interférence entre elles.
  describe('Persistance réelle des mutations', () => {
    it('confirmer une connaissance persiste réellement evidenceCount/confidenceScore en base', async () => {
      const entry = await prisma.brandMemoryEntry.create({
        data: { organizationId: orgShared.organizationId, type: 'LEARNING', content: 'Observation initiale', dedupKey: `e2e-persist-${Date.now()}`, evidenceCount: 1, positiveSignals: 0 },
      });

      await request(app.getHttpServer()).post(`/api/brand-kit/memory/${entry.id}/confirm`).set('Authorization', `Bearer ${orgShared.token}`).expect(201);

      const reloaded = await prisma.brandMemoryEntry.findUnique({ where: { id: entry.id } });
      expect(reloaded?.evidenceCount).toBe(2);
      expect(reloaded?.positiveSignals).toBe(1);
    });

    it('rejeter (dismiss) une connaissance la retire de la liste ACTIVE, sans la supprimer', async () => {
      const entry = await prisma.brandMemoryEntry.create({
        data: { organizationId: orgShared.organizationId, type: 'LEARNING', content: 'À rejeter', dedupKey: `e2e-dismiss-${Date.now()}` },
      });

      await request(app.getHttpServer()).post(`/api/brand-kit/memory/${entry.id}/dismiss`).set('Authorization', `Bearer ${orgShared.token}`).expect(201);

      const activeList = await request(app.getHttpServer())
        .get('/api/brand-kit/memory?status=ACTIVE')
        .set('Authorization', `Bearer ${orgShared.token}`)
        .expect(200);
      expect(activeList.body.find((e: any) => e.id === entry.id)).toBeUndefined();

      const stillExists = await prisma.brandMemoryEntry.findUnique({ where: { id: entry.id } });
      expect(stillExists).not.toBeNull();
      expect(stillExists?.status).toBe('DISMISSED');
    });

    it('promouvoir en règle avec des termes interdits est réellement appliqué au code — édition manuelle bloquée', async () => {
      const learning = await prisma.brandMemoryEntry.create({
        data: { organizationId: orgShared.organizationId, type: 'LEARNING', content: 'Éviter les promesses de résultat garanti', dedupKey: `e2e-rule-${Date.now()}` },
      });
      await request(app.getHttpServer())
        .post(`/api/brand-kit/memory/${learning.id}/promote-to-rule`)
        .set('Authorization', `Bearer ${orgShared.token}`)
        .send({ forbiddenTerms: ['garanti'] })
        .expect(201);

      // Prépare une pièce de contenu générée par l'IA (createdByUserId absent) à éditer.
      const campaign = await prisma.campaign.create({
        data: { organizationId: orgShared.organizationId, name: 'Campagne E2E', objective: 'Test', status: 'READY_FOR_REVIEW' },
      });
      const piece = await prisma.contentPiece.create({
        data: { organizationId: orgShared.organizationId, campaignId: campaign.id, channel: 'facebook', type: 'TEXT', status: 'READY' },
      });
      const version = await prisma.contentVersion.create({
        data: { contentPieceId: piece.id, versionNumber: 1, body: 'Texte généré par l\'IA, sans promesse.' },
      });
      await prisma.contentPiece.update({ where: { id: piece.id }, data: { currentVersionId: version.id } });

      // L'édition manuelle contenant le terme interdit est bloquée PAR DU CODE (pas seulement
      // par le prompt) — c'est le point central de la Phase 11, vérifié ici en conditions réelles.
      await request(app.getHttpServer())
        .post(`/api/campaigns/${campaign.id}/content/${piece.id}/edit`)
        .set('Authorization', `Bearer ${orgShared.token}`)
        .send({ body: 'Résultat garanti sous 30 jours.' })
        .expect(400);

      // Une édition qui respecte la règle passe normalement.
      await request(app.getHttpServer())
        .post(`/api/campaigns/${campaign.id}/content/${piece.id}/edit`)
        .set('Authorization', `Bearer ${orgShared.token}`)
        .send({ body: "Texte corrigé, sans terme interdit." })
        .expect(201);
    });

    it('résoudre une contradiction en CONTEXT_DEPENDENT réactive les deux connaissances', async () => {
      const [a, b] = await Promise.all([
        prisma.brandMemoryEntry.create({ data: { organizationId: orgShared.organizationId, type: 'LEARNING', content: 'A', dedupKey: `e2e-ctx-a-${Date.now()}`, status: 'CONTRADICTED' } }),
        prisma.brandMemoryEntry.create({ data: { organizationId: orgShared.organizationId, type: 'LEARNING', content: 'B', dedupKey: `e2e-ctx-b-${Date.now()}`, status: 'CONTRADICTED' } }),
      ]);
      const contradiction = await prisma.brandMemoryContradiction.create({
        data: { organizationId: orgShared.organizationId, knowledgeAId: a.id, knowledgeBId: b.id, evidenceA: 1, evidenceB: 1, confidenceA: 0.3, confidenceB: 0.3 },
      });

      await request(app.getHttpServer())
        .post(`/api/brand-kit/contradictions/${contradiction.id}/resolve`)
        .set('Authorization', `Bearer ${orgShared.token}`)
        .send({ resolution: 'CONTEXT_DEPENDENT' })
        .expect(201);

      const [reloadedA, reloadedB] = await Promise.all([
        prisma.brandMemoryEntry.findUnique({ where: { id: a.id } }),
        prisma.brandMemoryEntry.findUnique({ where: { id: b.id } }),
      ]);
      expect(reloadedA?.status).toBe('ACTIVE');
      expect(reloadedB?.status).toBe('ACTIVE');
    });
  });

  // Phase 12 — le résumé reflète les données réellement en base, jamais une valeur figée.
  describe('GET /brand-kit/brief', () => {
    it('reflète le nombre réel de contradictions non résolues pour cette organisation', async () => {
      const [a, b] = await Promise.all([
        prisma.brandMemoryEntry.create({ data: { organizationId: orgB.organizationId, type: 'LEARNING', content: 'A', dedupKey: `e2e-brief-a-${Date.now()}` } }),
        prisma.brandMemoryEntry.create({ data: { organizationId: orgB.organizationId, type: 'LEARNING', content: 'B', dedupKey: `e2e-brief-b-${Date.now()}` } }),
      ]);
      await prisma.brandMemoryContradiction.create({
        data: { organizationId: orgB.organizationId, knowledgeAId: a.id, knowledgeBId: b.id, evidenceA: 1, evidenceB: 1, confidenceA: 0.3, confidenceB: 0.3, resolutionStatus: 'UNRESOLVED' },
      });

      const brief = await request(app.getHttpServer()).get('/api/brand-kit/brief').set('Authorization', `Bearer ${orgB.token}`).expect(200);
      expect(brief.body.contradictionsCount).toBe(1);
    });
  });

  // Phase 4/16/19 : une édition manuelle réelle sur une pièce générée par l'IA doit produire
  // une vraie BrandMemoryEntry en base — pas seulement vérifié par des mocks (cf. unit tests
  // de ContentStudioService), ici via le vrai endpoint HTTP et la vraie base.
  describe('Content Studio → Brand Brain (intégration réelle)', () => {
    it('éditer manuellement une pièce générée par l\'IA crée une BrandMemoryEntry consultable via GET /brand-kit/memory', async () => {
      const campaign = await prisma.campaign.create({
        data: { organizationId: orgShared.organizationId, name: 'Campagne E2E — capture édition', objective: 'Test', status: 'READY_FOR_REVIEW' },
      });
      const piece = await prisma.contentPiece.create({
        data: { organizationId: orgShared.organizationId, campaignId: campaign.id, channel: 'linkedin', type: 'TEXT', status: 'READY' },
      });
      const version = await prisma.contentVersion.create({
        data: { contentPieceId: piece.id, versionNumber: 1, body: 'Notre solution est absolument incroyable et révolutionnaire pour votre entreprise.' },
      });
      await prisma.contentPiece.update({ where: { id: piece.id }, data: { currentVersionId: version.id } });

      await request(app.getHttpServer())
        .post(`/api/campaigns/${campaign.id}/content/${piece.id}/edit`)
        .set('Authorization', `Bearer ${orgShared.token}`)
        .send({ body: 'Notre solution est adaptée pour votre entreprise.' })
        .expect(201);

      const memory = await request(app.getHttpServer())
        .get('/api/brand-kit/memory?category=COPY')
        .set('Authorization', `Bearer ${orgShared.token}`)
        .expect(200);

      const captured = memory.body.find((e: any) => e.channel === 'linkedin' && e.dedupKey?.startsWith('edit-removed:linkedin:'));
      expect(captured).toBeDefined();
      expect(captured.source).toBe('content_studio_edit');
      expect(captured.sourceId).toBe(piece.id);
    });
  });
});
