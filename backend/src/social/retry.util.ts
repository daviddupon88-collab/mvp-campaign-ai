import { Logger } from '@nestjs/common';
import { SocialApiError } from './adapters/social-api-error';

const logger = new Logger('withRetry');

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
}

// Retry générique avec backoff exponentiel + jitter — réservé aux erreurs marquées
// `retryable` (cf. SocialApiError) : une erreur d'authentification ou de validation ne
// doit jamais être retentée telle quelle, elle échouera de la même façon à chaque tentative
// et ne fait que retarder l'échec définitif tout en consommant le quota de rate limit.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof SocialApiError ? error.retryable : false;

      if (!retryable || attempt === maxAttempts) throw error;

      const jitter = Math.random() * 0.3 + 0.85; // ±15% pour éviter un effet de meute
      const delay = baseDelayMs * Math.pow(3, attempt - 1) * jitter;
      logger.warn(
        `${options.label ?? 'Appel'} — tentative ${attempt}/${maxAttempts} échouée (${error}), nouvel essai dans ${Math.round(delay)}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
