import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../../prompt-engine/prompt-engine.service';
import { PromptTask } from '../../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../../prompt-versions';
import { ProductUrlFacts, ProductSpecification } from './product-url-facts.types';
import { buildProductPageClaims } from './product-page-claim-builder';

const MAX_INPUT_CHARS = 8000;

// Mission 4.4 (Product URL Intelligence, Phase H) — repli LLM UNIQUEMENT quand l'extraction
// déterministe est insuffisante (cf. product-intelligence-fusion.service.ts pour le seuil de
// déclenchement). Ne reçoit JAMAIS le HTML brut — seulement le texte visible nettoyé, tronqué.
// Discipline OBSERVED/INFERRED déjà imposée par le template ; ici, seul "OBSERVED" alimente des
// claims allowedForAdvertising (INFERRED reste un ProductFact de confiance réduite, jamais une
// claim publicitaire — même principe que product-page-claim-builder.ts : une inférence ne devient
// jamais automatiquement un fait exploitable en publicité).
@Injectable()
export class ProductPageLlmExtractorService {
  private readonly logger = new Logger(ProductPageLlmExtractorService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async extract(ctx: AiCallContext, html: string, url: string): Promise<ProductUrlFacts> {
    const cleanedText = this.stripHtml(html).slice(0, MAX_INPUT_CHARS);
    const prompt = this.promptEngine.render(PromptTask.PRODUCT_PAGE_EXTRACTION, { url, cleanedText });

    const first = await this.aiGateway.generateText(ctx, { prompt, maxTokens: 4000 }, 'anthropic', PROMPT_VERSIONS.productPageExtraction);
    const parsed = this.tryParse(first.content, url);
    if (parsed) return parsed;

    this.logger.warn('Extraction LLM de page produit non exploitable au 1er essai — nouvelle tentative avant repli vide.');
    const retry = await this.aiGateway.generateText(ctx, { prompt, maxTokens: 4000 }, 'anthropic', PROMPT_VERSIONS.productPageExtraction);
    const retryParsed = this.tryParse(retry.content, url);
    if (retryParsed) return retryParsed;

    this.logger.warn('Extraction LLM de page produit non exploitable après 2 tentatives, repli vide.');
    return this.emptyResult(url, 'Extraction LLM indisponible — réponse non exploitable après 2 tentatives.');
  }

  private tryParse(raw: string, url: string): ProductUrlFacts | null {
    try {
      const parsed = parseAiJson<any>(raw);
      const specifications: ProductSpecification[] = this.asObservedSpecifications(parsed.specifications);
      const price = this.asPrice(parsed.price);
      const availability = this.asString(parsed.availability);
      const brand = this.asString(parsed.brand);
      const title = this.asString(parsed.title);
      const description = this.asString(parsed.description);

      const claims = buildProductPageClaims({ title, brand, specifications, price, availability }).map((c) => ({
        ...c,
        evidence: `${c.evidence} (extraction LLM, statut OBSERVED)`,
      }));

      return {
        sourceUrl: url,
        title,
        brand,
        category: undefined,
        description,
        specifications,
        claims,
        images: [],
        price,
        availability,
        extractionMethod: 'LLM',
        warnings: [],
      };
    } catch {
      return null;
    }
  }

  // Seules les caractéristiques marquées "OBSERVED" par le modèle deviennent des
  // ProductSpecification (donc des claims publicitairement exploitables) — INFERRED est rejeté
  // ICI plutôt que de risquer de le voir traité comme un fait vérifié en aval.
  private asObservedSpecifications(value: unknown): ProductSpecification[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && s['status'] === 'OBSERVED')
      .filter((s) => typeof s.key === 'string' && typeof s.value === 'string')
      .map((s) => ({ key: s.key as string, value: s.value as string, unit: typeof s.unit === 'string' ? s.unit : undefined }));
  }

  private asPrice(value: unknown): { amount: number; currency: string } | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const amount = (value as Record<string, unknown>).amount;
    const currency = (value as Record<string, unknown>).currency;
    if (typeof amount === 'number' && Number.isFinite(amount) && typeof currency === 'string') return { amount, currency };
    return undefined;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private emptyResult(url: string, warning: string): ProductUrlFacts {
    return {
      sourceUrl: url,
      title: undefined,
      brand: undefined,
      category: undefined,
      description: undefined,
      specifications: [],
      claims: [],
      images: [],
      price: undefined,
      availability: undefined,
      extractionMethod: 'LLM',
      warnings: [warning],
    };
  }
}
