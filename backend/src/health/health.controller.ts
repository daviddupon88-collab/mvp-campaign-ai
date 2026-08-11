import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Deux endpoints distincts, convention standard Kubernetes/orchestrateurs :
//  - /health/live  : le processus tourne-t-il ? (jamais de dépendance externe vérifiée ici —
//    un /live qui dépend de la base ferait redémarrer le pod en boucle si la base est juste
//    lente, alors que le processus lui-même va très bien)
//  - /health/ready : peut-il servir du trafic ? (vérifie les dépendances critiques)
// Public (pas de JwtAuthGuard) : ce sont des sondes internes, jamais appelées par un
// utilisateur final ; exiger un token compliquerait sans bénéfice la configuration de la
// sonde côté orchestrateur.
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

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

    // Point d'extension : vérifier la connexion Redis (utilisée par BullMQ) nécessiterait
    // d'exposer un client ioredis dédié — non fait ici pour ne pas ajouter de dépendance
    // uniquement pour ce contrôle ; l'échec de connexion Redis se manifeste indirectement
    // par l'échec des jobs de génération, déjà visible dans les logs structurés.

    const allOk = Object.values(checks).every((v) => v === 'ok');
    if (!allOk) {
      throw new HttpException({ status: 'error', checks }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', checks };
  }
}
