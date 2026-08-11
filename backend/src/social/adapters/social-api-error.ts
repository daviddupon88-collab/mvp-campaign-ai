// Erreur typée que tout adaptateur doit lever en cas d'échec d'appel à une plateforme —
// remplace les `throw new Error(...)` génériques précédents. `retryable` est ce qui permet
// à withRetry() de décider s'il vaut la peine de retenter (panne transitoire, rate limit)
// ou d'abandonner immédiatement (erreur d'authentification, requête invalide).
export class SocialApiError extends Error {
  readonly platform: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { platform: string; statusCode?: number; retryable: boolean }) {
    super(message);
    this.name = 'SocialApiError';
    this.platform = options.platform;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
  }

  // Classification par défaut à partir du code HTTP : 429 (rate limit) et 5xx (panne
  // serveur côté plateforme) sont transitoires ; le reste (401/403/400/404...) ne l'est pas
  // — retenter une requête mal formée ou un token invalide ne changera rien.
  static fromHttpStatus(platform: string, statusCode: number, message: string): SocialApiError {
    const retryable = statusCode === 429 || statusCode >= 500;
    return new SocialApiError(message, { platform, statusCode, retryable });
  }

  static network(platform: string, message: string): SocialApiError {
    return new SocialApiError(message, { platform, retryable: true });
  }
}
