import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service';

// Public (pas de JwtAuthGuard) — comme /health, c'est une sonde interne appelée par le
// serveur Prometheus, pas par un utilisateur final. En production, cet endpoint devrait
// être exposé uniquement sur un réseau interne (jamais sur l'ingress public), configuration
// qui se fait au niveau infrastructure plutôt que dans le code applicatif.
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain')
  async getMetrics(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
