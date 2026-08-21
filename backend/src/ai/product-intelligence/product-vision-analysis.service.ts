import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { ProductVisionAnalysis } from './product-intelligence.types';

const FALLBACK_VISION_ANALYSIS: Omit<ProductVisionAnalysis, 'raw' | 'confidence'> = {
  category: null,
  subcategory: null,
  productType: null,
  brand: null,
  productName: null,
  model: null,
  visibleText: [],
  logoDetected: false,
  packaging: null,
  colors: [],
  materials: [],
  shape: null,
  visualAttributes: [],
  distinctiveFeatures: [],
  visibleClaims: [],
  identificationClues: [],
};

// P0.1 — Product Vision Analysis (chantier Product Intelligence, 2026-08-18). Première étape du
// pipeline IMAGE -> VISION -> IDENTIFICATION -> PRODUCT INTELLIGENCE PROFILE -> GROUNDING. Un seul
// appel vision, schéma riche (17 champs), toujours défensif : une identification incertaine ne
// doit JAMAIS être présentée comme un fait — cf. règle absolue du brief. Le prompt est ici, en
// dur, pour cette étape 2 de l'implémentation ; migré vers PromptEngineService à l'étape 6
// (P0.5) sans changer ce contrat public.
@Injectable()
export class ProductVisionAnalysisService {
  private readonly logger = new Logger(ProductVisionAnalysisService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async analyze(ctx: AiCallContext, imageUrl: string, productDescriptionHint?: string): Promise<ProductVisionAnalysis> {
    // Prompt construit via Prompt Engine V2 (P0.5) — cf. templates/product-analysis.template.ts
    // pour le contenu exact (role/mission/constraints/outputSchema).
    const prompt = this.promptEngine.render(PromptTask.PRODUCT_ANALYSIS, { descriptionHint: productDescriptionHint });

    const result = await this.aiGateway.analyzeImage(ctx, { prompt, imageUrl }, 'openai', PROMPT_VERSIONS.productAnalysisV2);
    return this.parse(result.content);
  }

  // Même principe de repli que VisualDnaService.parse / AiOrchestratorService.formatProductAnalysis :
  // un modèle qui ne respecte pas le format JSON demandé ne doit jamais faire échouer la
  // génération de campagne — repli neutre (tout à null/vide, confidence 0), raw conservé pour
  // qu'un futur debug (ou un validateur humain) puisse voir ce qui a réellement été renvoyé.
  private parse(raw: string): ProductVisionAnalysis {
    try {
      const parsed = parseAiJson<any>(raw);
      return {
        category: this.str(parsed.category),
        subcategory: this.str(parsed.subcategory),
        productType: this.str(parsed.productType),
        brand: this.str(parsed.brand),
        productName: this.str(parsed.productName),
        model: this.str(parsed.model),
        visibleText: this.strArray(parsed.visibleText),
        logoDetected: parsed.logoDetected === true,
        packaging: this.str(parsed.packaging),
        colors: this.strArray(parsed.colors),
        materials: this.strArray(parsed.materials),
        shape: this.str(parsed.shape),
        visualAttributes: this.strArray(parsed.visualAttributes),
        distinctiveFeatures: this.strArray(parsed.distinctiveFeatures),
        visibleClaims: this.strArray(parsed.visibleClaims),
        identificationClues: this.strArray(parsed.identificationClues),
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
        raw,
      };
    } catch (error) {
      this.logger.warn(`Réponse d'analyse vision produit non conforme au format JSON attendu, repli neutre conservé: ${error}`);
      return { ...FALLBACK_VISION_ANALYSIS, confidence: 0, raw };
    }
  }

  private str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private strArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}
