// Borne la durée de tout appel HTTP sortant vers un fournisseur externe (IA, réseau social).
// Sans ceci, un fournisseur qui ne répond jamais bloque indéfiniment le worker BullMQ ou la
// requête HTTP qui l'a déclenché — aucun retry/backoff ne peut se déclencher tant que la
// promesse sous-jacente n'a jamais ni résolu ni rejeté. Même pattern que celui déjà utilisé
// dans StorageService.uploadFromUrl(), extrait ici pour être réutilisé par chaque provider IA
// et adaptateur réseau social plutôt que redupliqué à l'identique dans chacun.
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
