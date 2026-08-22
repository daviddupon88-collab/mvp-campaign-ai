import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { assertValidProductPageUrl } from './product-page-url-validator';
import { ProductPageFetchResult } from './product-page-fetch-result.types';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 5_000_000;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

// Mission 4.4 (Product URL Intelligence, Phase B) — URL -> HTTP sécurisé -> Page. Responsabilité
// UNIQUE (cf. plan) : ne fait AUCUN appel LLM, ne construit AUCUN concept, ne touche jamais
// QualityTarget. Revalide CHAQUE cible de redirection avec assertValidProductPageUrl (ferme le
// gap explicitement documenté dans store-url-guard.ts : "ne vérifie pas les cibles de
// redirection") — une page produit publique redirige fréquemment (http->https, www->apex,
// tracking params), et chaque saut est une nouvelle opportunité de SSRF si non revalidé.
//
// Ne lève JAMAIS pour une page inaccessible/non-HTML/trop volumineuse — retourne un résultat
// avec warnings[] et html absent à la place (Mission 4.4 Phase Q : "une URL inaccessible ne doit
// pas automatiquement bloquer une campagne"). Ne lève QUE pour une URL invalide dès le départ
// (erreur de saisie, pas un problème réseau) ou une cible de redirection dangereuse (SSRF avéré
// — ça, ça reste un vrai rejet, jamais un warning silencieux).
@Injectable()
export class SafeProductPageFetcherService {
  private readonly logger = new Logger(SafeProductPageFetcherService.name);

  async fetch(rawUrl: string): Promise<ProductPageFetchResult> {
    const startedAt = Date.now();
    let current = await assertValidProductPageUrl(rawUrl);
    const warnings: string[] = [];

    for (let redirectCount = 0; ; redirectCount++) {
      if (redirectCount > MAX_REDIRECTS) {
        return this.emptyResult(rawUrl, current.toString(), 0, [...warnings, `Trop de redirections (>${MAX_REDIRECTS}) — abandon.`], '', redirectCount, startedAt);
      }

      let response: Response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        response = await fetch(current.toString(), { redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml' } });
      } catch (error) {
        clearTimeout(timeout);
        this.logger.warn(`Fetch de page produit échoué (${current.toString()}) : ${error}`);
        return this.emptyResult(rawUrl, current.toString(), 0, [...warnings, `Page produit inaccessible : ${error instanceof Error ? error.message : String(error)}`], '', redirectCount, startedAt);
      } finally {
        clearTimeout(timeout);
      }

      if (REDIRECT_STATUS_CODES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          return this.emptyResult(rawUrl, current.toString(), response.status, [...warnings, `Redirection (${response.status}) sans en-tête Location — abandon.`], '', redirectCount, startedAt);
        }
        let next: URL;
        try {
          next = await assertValidProductPageUrl(new URL(location, current).toString());
        } catch (error) {
          // Une cible de redirection dangereuse (adresse privée, protocole interdit) reste un
          // vrai rejet — jamais un warning silencieux, contrairement à une page simplement
          // inaccessible.
          throw error instanceof BadRequestException ? error : new BadRequestException('Redirection de page produit refusée');
        }
        warnings.push(`Redirigé de ${current.toString()} vers ${next.toString()}.`);
        current = next;
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        return this.emptyResult(rawUrl, current.toString(), response.status, [...warnings, `Type de contenu inattendu (${contentType || 'absent'}) — page ignorée, non traitée comme du HTML.`], contentType, redirectCount, startedAt);
      }

      const html = await this.readBodyWithCap(response, warnings);

      return {
        url: rawUrl,
        finalUrl: current.toString(),
        statusCode: response.status,
        contentType,
        html,
        retrievedAt: new Date().toISOString(),
        warnings,
        fetchDurationMs: Date.now() - startedAt,
        redirectCount,
      };
    }
  }

  private async readBodyWithCap(response: Response, warnings: string[]): Promise<string | undefined> {
    if (!response.body) {
      const text = await response.text();
      return text.length > MAX_BYTES ? undefined : text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        warnings.push(`Réponse tronquée : dépasse la taille maximale autorisée (${MAX_BYTES} octets).`);
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  }

  private emptyResult(
    url: string,
    finalUrl: string,
    statusCode: number,
    warnings: string[],
    contentType = '',
    redirectCount = 0,
    startedAt = Date.now(),
  ): ProductPageFetchResult {
    return { url, finalUrl, statusCode, contentType, html: undefined, retrievedAt: new Date().toISOString(), warnings, fetchDurationMs: Date.now() - startedAt, redirectCount };
  }
}
