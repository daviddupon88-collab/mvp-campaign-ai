import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const start = process.hrtime.bigint();

    // Le chemin de route (ex: "/campaigns/:id") plutôt que l'URL brute — sinon chaque ID de
    // ressource distinct créerait une nouvelle série temporelle, faisant exploser la
    // cardinalité des métriques (un piège Prometheus classique).
    const route = request.route?.path ?? request.url;

    return next.handle().pipe(
      tap({
        next: () => this.record(request.method, route, response.statusCode, start),
        error: () => this.record(request.method, route, response.statusCode || 500, start),
      }),
    );
  }

  private record(method: string, route: string, status: number, start: bigint) {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method, route, status: String(status) };
    this.metrics.httpRequestsTotal.inc(labels);
    this.metrics.httpRequestDurationSeconds.observe(labels, durationSeconds);
  }
}
