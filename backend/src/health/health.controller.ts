import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CAMPAIGN_GENERATION_QUEUE } from '../queue/queue.module';

// Deux endpoints distincts, convention standard Kubernetes/orchestrateurs :
//  - /health/live  : le processus tourne-t-il ? (jamais de dépendance externe vérifiée ici —
//    un /live qui dépend de la base ferait redémarrer le pod en boucle si la base est juste
//    lente, alors que le processus lui-même va très bien)
//  - /health/ready : peut-il servir du trafic ? (vérifie les dépendances critiques)
// Public (pas de JwtAuthGuard) : ce sont des sondes internes, jamais appelées par un
// utilisateur final ; exiger un token compliquerait sans bénéfice la configuration de la
// sonde côté orchestrateur.
const REDIS_CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(CAMPAIGN_GENERATION_QUEUE) private readonly generationQueue: Queue,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | 'error'> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    // Réutilise la connexion Redis déjà ouverte par BullMQ pour la file de génération
    // (cf. QueueModule) plutôt que d'instancier un client dédié rien que pour ce contrôle —
    // sans ce check, une panne Redis ne se manifestait qu'indirectement, via l'échec des
    // jobs de génération, jamais depuis /health/ready lui-même.
    //
    // Enveloppé dans un timeout explicite : sans lui, Redis injoignable ne fait pas échouer
    // rapidement `await this.generationQueue.client` — ioredis retente indéfiniment en
    // interne, ce qui bloquerait /health/ready au lieu de répondre vite (constaté en test :
    // le endpoint restait pendu plusieurs dizaines de secondes plutôt que de renvoyer 503).
    try {
      // Pas de .ping() sur IRedisClient (abstraction bullmq multi-backend) — .info() exige
      // elle aussi un aller-retour réseau réel vers Redis, tout aussi probant pour ce contrôle.
      const client = await withTimeout(this.generationQueue.client, REDIS_CHECK_TIMEOUT_MS);
      await withTimeout(client.info(), REDIS_CHECK_TIMEOUT_MS);
      checks.redis = 'ok';
    } catch {
      checks.redis = 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    if (!allOk) {
      throw new HttpException({ status: 'error', checks }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', checks };
  }
}
