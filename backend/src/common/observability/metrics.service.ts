import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Métriques minimales mais réelles : nombre de requêtes HTTP par route/statut, et leur
// durée — suffisant pour détecter une dégradation (taux d'erreur en hausse, latence qui
// dérive) sans construire un système d'observabilité complet. collectDefaultMetrics()
// ajoute en prime les métriques process Node standard (mémoire, event loop lag, GC).
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Nombre total de requêtes HTTP traitées',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });

  readonly httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Durée des requêtes HTTP en secondes',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
