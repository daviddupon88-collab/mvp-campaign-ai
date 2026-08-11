import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { RequestContextService } from '../logging/request-context.service';
import { PrismaService } from '../../prisma/prisma.service';

// Filtre global : capture TOUTE exception non gérée, l'envoie à Sentry (si configuré) avec
// le requestId en contexte pour pouvoir corréler une alerte Sentry avec les logs structurés
// de la même requête, et renvoie une réponse JSON cohérente plutôt que la trace de la pile
// par défaut d'Express (qui fuiterait des détails d'implémentation en production).
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(
    private readonly requestContext?: RequestContextService,
    // Optionnel comme requestContext : ce filtre est instancié manuellement dans main.ts
    // (avant que le conteneur Nest ne soit pleinement disponible pour certains cas), pas
    // injecté via le système de DI standard.
    private readonly prisma?: PrismaService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const responseBody = isHttpException ? exception.getResponse() : 'Erreur interne du serveur';

    // Seules les erreurs serveur (5xx) partent vers Sentry — une 404 ou une validation
    // 400 est un comportement attendu de l'API, pas un incident à investiguer.
    if (status >= 500) {
      const requestId = this.requestContext?.get()?.requestId;
      Sentry.withScope((scope) => {
        if (requestId) scope.setTag('requestId', requestId);
        scope.setContext('request', { method: request.method, url: request.url });
        Sentry.captureException(exception);
      });
      this.logger.error(`Erreur non gérée sur ${request.method} ${request.url}: ${exception}`);

      // Journal d'erreurs HTTP dédié (README item 46) — distinct des générations IA/
      // publications déjà tracées comme échouées (celles-ci restent des succès HTTP avec un
      // statut métier FAILED). Best-effort et non bloquant, comme AuditService : ne retarde
      // jamais l'envoi de la réponse déjà construite ci-dessous — fire-and-forget.
      this.prisma?.httpErrorLog
        .create({
          data: {
            method: request.method,
            path: request.url,
            statusCode: status,
            message: exception instanceof Error ? exception.message : String(exception),
            requestId: this.requestContext?.get()?.requestId,
            organizationId: this.requestContext?.get()?.organizationId,
          },
        })
        .catch((err) => this.logger.warn(`Échec d'écriture du journal d'erreurs HTTP: ${err}`));
    }

    // Une exception levée avec un objet (ex: PlanLimitExceededException, ou le format
    // par défaut de ValidationPipe) voit désormais TOUS ses champs propagés dans la réponse
    // — auparavant, seul `.message` était conservé, ce qui aurait silencieusement supprimé
    // `code`/`recommendedPlan`/etc. avant qu'ils n'atteignent le frontend. Une exception
    // levée avec une simple string continue de produire `{ message: "..." }` comme avant.
    const isStructured = typeof responseBody === 'object' && responseBody !== null;

    response.status(status).json({
      statusCode: status,
      ...(isStructured ? responseBody : { message: responseBody }),
      requestId: this.requestContext?.get()?.requestId,
      timestamp: new Date().toISOString(),
    });
  }
}
