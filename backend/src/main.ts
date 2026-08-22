import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { validateEnv } from './common/validate-env';
import { StructuredLoggerService } from './common/logging/structured-logger.service';
import { RequestContextService } from './common/logging/request-context.service';
import { GlobalExceptionFilter } from './common/observability/global-exception.filter';
import { StorageService } from './storage/storage.service';
import { PrismaService } from './prisma/prisma.service';
import { logProcessEvent, serializeError } from './common/observability/process-health';

// Audit forensic (2026-08-22) — filet de sécurité process-wide, ajouté après avoir constaté en
// conditions réelles qu'une SEULE promesse rejetée non interceptée n'importe où dans le code
// (ex: narrationPromise dans ai-orchestrator.service.ts, ou pushConversion dans
// meta-capi.service.ts — deux cas réels trouvés et corrigés à la source) faisait planter TOUT le
// process Node en l'absence de tout handler global — tuant du même coup TOUTES les campagnes en
// cours, pas seulement celle en cause. Ce filet ne remplace pas la correction à la source (déjà
// faite pour les deux cas connus) : il protège contre tout point manqué, présent ou futur.
//
// unhandledRejection : simplement journalisé (+ Sentry si configuré) — jamais process.exit ici.
// La quasi-totalité des cas réels rencontrés sont des échecs best-effort isolés (notification,
// tracking, narration) déjà non-critiques par conception ; les arrêter ne rendrait aucun service
// plus sûr, seulement plus fragile face au moindre bug isolé.
//
// uncaughtException : selon la documentation Node elle-même, le process est alors dans un état
// non défini et NE DOIT PAS continuer à traiter de nouvelles requêtes/jobs — journalisé puis
// arrêt volontaire (délai court pour laisser partir les logs/Sentry), pour qu'un superviseur de
// process (nodemon/nest --watch en dev, PM2/Docker en prod) le relance proprement plutôt que de
// laisser tourner un process potentiellement corrompu de façon silencieuse.
// Stabilisation infrastructure (Mission 4.5, 2026-08-22) — logProcessEvent() écrit de façon
// SYNCHRONE (cf. process-health.ts) et est appelé EN PREMIER, avant tout envoi Sentry/exit : un
// crash précédent (backend mort entre deux requêtes, aucune trace exploitable) a confirmé qu'une
// persistance uniquement en mémoire/console ne survit pas à l'arrêt du process si personne ne
// lit stdout au bon moment. La persistance disque prime désormais sur tout le reste.
process.on('unhandledRejection', (reason) => {
  logProcessEvent('unhandledRejection', { error: serializeError(reason) });
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  }
});

process.on('uncaughtException', (error) => {
  logProcessEvent('uncaughtException', { error: serializeError(error) });
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error);
    Sentry.flush(2000).finally(() => process.exit(1));
  } else {
    setTimeout(() => process.exit(1), 100);
  }
});

// Signaux d'arrêt (Mission 4.5) — SIGTERM/SIGINT sont des arrêts VOLONTAIRES (orchestrateur,
// Ctrl+C, ou nest --watch qui redémarre le process sur changement de fichier) — jamais un
// crash, mais leur absence de journalisation rendait auparavant indiscernable un arrêt demandé
// d'un arrêt inexpliqué en relisant seulement le journal. process.exit() explicite après
// journalisation : attacher un listener SIGTERM/SIGINT supprime le comportement d'arrêt par
// défaut de Node, il faut donc le reproduire nous-mêmes pour ne pas casser le cycle de
// redémarrage de nest --watch.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logProcessEvent('processSignal', { signal });
    process.exit(0);
  });
}

async function bootstrap() {
  // Échec rapide si un secret critique manque ou est resté à sa valeur de développement —
  // avant même de créer l'application, pour ne jamais démarrer dans un état non sécurisé.
  validateEnv();

  // Sentry initialisé avant la création de l'app pour capturer aussi les erreurs de
  // bootstrap (ex: échec de connexion à la base au démarrage). Sans SENTRY_DSN, Sentry.init
  // reste un no-op silencieux — aucune erreur si le suivi d'erreurs n'est pas configuré.
  if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV ?? 'development', tracesSampleRate: 0.1 });
  }

  // bodyParser désactivé globalement : le webhook Stripe a besoin du corps brut
  // (non parsé) pour vérifier la signature ; tout le reste de l'API utilise du JSON classique.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, bufferLogs: true });

  // Logger structuré JSON, avec ID de corrélation automatique par requête (cf. RequestContextService).
  const requestContext = app.get(RequestContextService);
  app.useLogger(new StructuredLoggerService(requestContext));
  app.useGlobalFilters(new GlobalExceptionFilter(requestContext, app.get(PrismaService)));

  app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Sert les fichiers uploadés en mode STORAGE_PROVIDER=local (dev uniquement — cf.
  // avertissement au démarrage dans StorageService) ; en mode s3, les fichiers sont servis
  // directement par le fournisseur de stockage (ou un CDN devant), cette route ne sert à rien.
  const storage = app.get(StorageService);
  if (storage.isLocalMode()) {
    app.use('/uploads', express.static(storage.getLocalDir()));
  }

  // Express 5 (NestJS 11) change le parseur de query string par défaut de "extended" à
  // "simple" — sans incidence sur les query params déjà utilisés dans cette API (aucun
  // paramètre imbriqué/tableau, vérifié), mais restauré explicitement pour ne dépendre
  // d'aucune analyse a posteriori si un futur endpoint en ajoutait un.
  app.set('query parser', 'extended');
  app.enableCors();
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // rejette les champs non attendus dans les DTOs
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`Campaign-ai backend démarré sur http://localhost:${port}/api`);
}
bootstrap();
