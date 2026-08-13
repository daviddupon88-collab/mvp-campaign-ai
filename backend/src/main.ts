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
