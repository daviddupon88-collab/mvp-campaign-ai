import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import {
  ProductVisionAnalysis,
  ProductIdentificationCandidate,
  ProductIdentificationResult,
  IdentificationConfidenceLevel,
} from './product-intelligence.types';

// Seuils de dérivation du niveau de confiance — délibérément DÉTERMINISTES (pas auto-déclarés
// par le LLM) : un LLM invité à choisir lui-même "CONFIRMED"/"PROBABLE"/... est incohérent d'un
// appel à l'autre pour un même score, alors qu'un seuil fixe est testable et prévisible. Valeurs
// choisies pour rester strictes côté haut (0.85 pour CONFIRMED — jamais un "probablement bon")
// et permissives côté bas (0.3 pour UNCERTAIN — en dessous, aucune hypothèse n'est assez fondée
// pour être conservée comme "candidat plausible").
const CONFIRMED_THRESHOLD = 0.85;
const PROBABLE_THRESHOLD = 0.6;
const UNCERTAIN_THRESHOLD = 0.3;

// P0.2 — Product Identification (chantier Product Intelligence, 2026-08-18). Raisonne sur les
// données DÉJÀ EXTRAITES par ProductVisionAnalysisService (P0.1) — pas un 2e appel vision, un
// generateText/anthropic (raisonnement pur, moins coûteux qu'un nouvel appel vision). Règle
// absolue du brief : ne jamais transformer une hypothèse en fait — si l'identification est
// incertaine, conserve plusieurs candidats plutôt que d'en inventer un seul avec excès de
// confiance.
@Injectable()
export class ProductIdentificationService {
  private readonly logger = new Logger(ProductIdentificationService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async identify(ctx: AiCallContext, vision: ProductVisionAnalysis, productDescriptionHint?: string): Promise<ProductIdentificationResult> {
    // Prompt construit via Prompt Engine V2 (P0.5) — cf. templates/product-identification.template.ts.
    const prompt = this.promptEngine.render(PromptTask.PRODUCT_IDENTIFICATION, { vision, descriptionHint: productDescriptionHint });

    const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic', PROMPT_VERSIONS.productIdentification);
    return this.buildResult(result.content);
  }

  // Parsing défensif suivant le même pattern que VideoDirectorService.tryParseShotPlan /
  // ModerationService.checkMisleadingClaimsBatch : une réponse malformée ne doit jamais faire
  // échouer la génération de campagne — repli sur candidates:[] (-> UNKNOWN), jamais une
  // exception sauf échec total du provider.
  private buildResult(raw: string): ProductIdentificationResult {
    let candidates: ProductIdentificationCandidate[] = [];
    try {
      const parsed = parseAiJson<any>(raw);
      if (Array.isArray(parsed.candidates)) {
        candidates = parsed.candidates.filter(this.isValidCandidate).map((c: ProductIdentificationCandidate) => ({
          name: c.name,
          brand: c.brand ?? null,
          model: c.model ?? null,
          matchScore: Math.max(0, Math.min(1, c.matchScore)),
          reason: c.reason,
        }));
      }
    } catch (error) {
      this.logger.warn(`Réponse d'identification produit non conforme au format JSON attendu, repli sur aucun candidat (UNKNOWN): ${error}`);
    }

    // Meilleur candidat = matchScore le plus élevé — jamais le premier de la liste tel quel
    // (l'ordre renvoyé par le modèle n'est pas garanti trié).
    const best = candidates.reduce<ProductIdentificationCandidate | null>((acc, c) => (!acc || c.matchScore > acc.matchScore ? c : acc), null);
    const confidence = best?.matchScore ?? 0;

    return {
      candidates,
      bestMatch: best?.name ?? null,
      confidenceLevel: this.deriveConfidenceLevel(confidence),
      confidence,
    };
  }

  private deriveConfidenceLevel(bestScore: number): IdentificationConfidenceLevel {
    if (bestScore >= CONFIRMED_THRESHOLD) return 'CONFIRMED';
    if (bestScore >= PROBABLE_THRESHOLD) return 'PROBABLE';
    if (bestScore >= UNCERTAIN_THRESHOLD) return 'UNCERTAIN';
    return 'UNKNOWN';
  }

  private isValidCandidate(value: unknown): value is ProductIdentificationCandidate {
    if (!value || typeof value !== 'object') return false;
    const c = value as Record<string, unknown>;
    return typeof c.name === 'string' && c.name.length > 0 && typeof c.matchScore === 'number' && typeof c.reason === 'string';
  }
}
