import { LoggerService } from '@nestjs/common';
import { RequestContextService } from './request-context.service';

// Niveaux de l'entrée JSON écrite — distincts de LogLevel (@nestjs/common), qui ne connaît
// pas 'info' : NestJS appelle log() pour le niveau informatif standard, mais 'info' est le
// nom conventionnel attendu par la plupart des agrégateurs de logs (Datadog, Loki...).
type LogEntryLevel = 'info' | 'error' | 'warn' | 'debug' | 'verbose';

// Remplace le Logger texte par défaut de NestJS par une sortie JSON structurée (une ligne
// par log, un objet par ligne) — exploitable par n'importe quel agrégateur de logs
// (Datadog, CloudWatch, Loki, Elastic...) sans étape d'analyse fragile sur du texte libre.
// Chaque ligne inclut automatiquement le requestId de la requête en cours si disponible
// (cf. RequestContextService), sans que l'appelant n'ait à le fournir explicitement.
//
// Choix délibéré : implémentation minimale sans dépendance tierce (pino, winston...) pour
// rester simple à auditer — un vrai déploiement production échangerait volontiers ceci
// contre nestjs-pino pour la performance (sérialisation JSON native, pas de blocage I/O),
// sans changer l'interface LoggerService consommée par le reste du code.
export class StructuredLoggerService implements LoggerService {
  constructor(private readonly requestContext?: RequestContextService) {}

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace);
  }

  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string) {
    this.write('verbose', message, context);
  }

  private write(level: LogEntryLevel, message: unknown, context?: string, trace?: string) {
    const requestId = this.requestContext?.get()?.requestId;
    const organizationId = this.requestContext?.get()?.organizationId;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      context,
      requestId,
      organizationId,
      ...(trace ? { trace } : {}),
    };

    // stdout/stderr séparés par gravité — convention standard pour que les agrégateurs
    // de logs (et `docker logs`) puissent distinguer erreurs et bruit informatif sans parser.
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(JSON.stringify(entry) + '\n');
  }
}
