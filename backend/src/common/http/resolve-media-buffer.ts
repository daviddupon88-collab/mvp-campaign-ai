import { fetchWithTimeout } from './fetch-with-timeout';

// Un média (vidéo, audio, image) généré par un fournisseur IA arrive sous deux formats
// légitimes selon celui qui a répondu, jamais mélangés au sein d'un même appel : data URI
// (fournisseur sans URL hébergée — cf. GoogleVeoProvider, OpenAiProvider.generateAudio) ou URL
// HTTP classique (fournisseur avec stockage temporaire — cf. RunwayProvider). Centralisé ici
// pour être réutilisé partout où ce choix doit être géré (VideoFinalizationService pour la
// vidéo brute, AiOrchestratorService pour la concaténation multi-plans) plutôt que redupliqué.
export async function resolveMediaBuffer(dataUriOrUrl: string): Promise<Buffer> {
  const dataUriMatch = /^data:(.+?);base64,(.+)$/.exec(dataUriOrUrl);
  if (dataUriMatch) {
    const [, , base64] = dataUriMatch;
    return Buffer.from(base64, 'base64');
  }

  const res = await fetchWithTimeout(dataUriOrUrl);
  if (!res.ok) throw new Error(`Impossible de récupérer le média : HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
