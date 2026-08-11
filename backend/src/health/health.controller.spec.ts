import { HttpException, HttpStatus } from '@nestjs/common';
import { Queue } from 'bullmq';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

function buildPrismaMock(queryRawImpl: jest.Mock) {
  return { $queryRaw: queryRawImpl } as unknown as PrismaService;
}

function buildQueueMock(client: Promise<{ info: jest.Mock }>) {
  return { client } as unknown as Queue;
}

// Vérifie explicitement la correction du bug constaté en test manuel : sans le timeout
// enveloppant le contrôle Redis, une connexion Redis indisponible faisait rester
// /health/ready pendu indéfiniment (ioredis retente en interne) au lieu de répondre 503
// rapidement — inacceptable pour une sonde d'orchestrateur.
describe('HealthController', () => {
  it('live() répond toujours ok, sans vérifier de dépendance', () => {
    const controller = new HealthController(buildPrismaMock(jest.fn()), buildQueueMock(Promise.resolve({ info: jest.fn() })));
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('ready() renvoie ok quand la base et Redis répondent', async () => {
    const prisma = buildPrismaMock(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    const queue = buildQueueMock(Promise.resolve({ info: jest.fn().mockResolvedValue('redis_version:7.0.0') }));
    const controller = new HealthController(prisma, queue);

    await expect(controller.ready()).resolves.toEqual({ status: 'ok', checks: { database: 'ok', redis: 'ok' } });
  });

  it('ready() renvoie 503 avec redis:error quand la base répond mais pas Redis', async () => {
    const prisma = buildPrismaMock(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    const queue = buildQueueMock(Promise.reject(new Error('connexion refusée')));
    const controller = new HealthController(prisma, queue);

    try {
      await controller.ready();
      fail('devait lever une exception');
    } catch (error: any) {
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(error.getResponse()).toEqual({ status: 'error', checks: { database: 'ok', redis: 'error' } });
    }
  });

  it('ready() renvoie 503 avec database:error quand Redis répond mais pas la base', async () => {
    const prisma = buildPrismaMock(jest.fn().mockRejectedValue(new Error('base indisponible')));
    const queue = buildQueueMock(Promise.resolve({ info: jest.fn().mockResolvedValue('redis_version:7.0.0') }));
    const controller = new HealthController(prisma, queue);

    try {
      await controller.ready();
      fail('devait lever une exception');
    } catch (error: any) {
      expect(error.getResponse()).toEqual({ status: 'error', checks: { database: 'error', redis: 'ok' } });
    }
  });

  it('ready() échoue rapidement (timeout) plutôt que de rester pendu si Redis ne répond jamais', async () => {
    const prisma = buildPrismaMock(jest.fn().mockResolvedValue([{ '?column?': 1 }]));
    // Une Promise qui ne se résout ni ne se rejette jamais — simule une connexion Redis
    // qui reste en attente indéfiniment (exactement le scénario constaté sans le timeout).
    const neverResolves = new Promise<{ info: jest.Mock }>(() => {});
    const queue = buildQueueMock(neverResolves);
    const controller = new HealthController(prisma, queue);

    const start = Date.now();
    try {
      await controller.ready();
      fail('devait lever une exception');
    } catch (error: any) {
      expect(Date.now() - start).toBeLessThan(3000);
      expect(error.getResponse().checks.redis).toBe('error');
    }
  }, 10_000);
});
