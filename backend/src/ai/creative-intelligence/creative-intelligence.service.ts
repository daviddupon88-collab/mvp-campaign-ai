import { Injectable, Logger } from '@nestjs/common';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { ProductIntelligenceProfile } from '@prisma/client';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { renderGroundedContext } from '../product-intelligence/product-grounding';
import { CreativeIntelligence } from './creative-intelligence.types';

export interface GenerateCreativeIntelligenceParams {
  productProfile: ProductIntelligenceProfile | null;
  productDescription?: string;
  objective: string;
  audience?: string;
  strategyContent: string;
}

// Repli neutre — jamais un throw sur une réponse IA malformée (cf. VisualDnaService.parse,
// ProductVisionAnalysisService). Champs vides plutôt qu'inventés : une intelligence créative
// vide est un signal honnête (le prompt en aval devra composer avec), jamais un faux contenu.
const NEUTRAL_CREATIVE_INTELLIGENCE: Omit<CreativeIntelligence, 'raw'> = {
  adObjective: '',
  targetAudience: '',
  primaryProblem: '',
  primaryDesire: '',
  primaryBenefit: '',
  valueProposition: '',
  creativeAngle: '',
  desiredEmotion: '',
  hook: '',
  proofToShow: '',
  objections: [],
  mainMessage: '',
  cta: '',
  visualTone: '',
  pacing: '',
  adStyle: '',
};

// P0.1 — Creative Intelligence (chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Fait le pont entre Product Intelligence (déjà construit, jamais modifié ici) et
// la Marketing Strategy déjà générée par AiOrchestratorService, pour produire une intelligence
// publicitaire structurée (SHOW>TELL, statuts CONFIRMED/PROBABLE/UNKNOWN respectés) — pas
// encore une idée de pub concrète (cf. CreativeConceptService, P0.2).
//
// Fonctionne AUSSI sans photo produit (productProfile=null) : repli sur productDescription
// texte, avec des règles de grounding plus souples mais toujours interdiction d'inventer une
// caractéristique — décision de périmètre explicite (cf. plan), pour ne pas priver les
// campagnes texte-seul de cette couche.
@Injectable()
export class CreativeIntelligenceService {
  private readonly logger = new Logger(CreativeIntelligenceService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async generate(ctx: AiCallContext, params: GenerateCreativeIntelligenceParams): Promise<CreativeIntelligence> {
    const groundedContextBlock = params.productProfile
      ? `\n\n${renderGroundedContext(params.productProfile)}`
      : params.productDescription?.trim()
        ? `\n\nDescription produit fournie (aucune analyse vision disponible — reste dans les limites de ce texte, n'invente rien au-delà) : ${params.productDescription}`
        : '';

    const prompt = this.promptEngine.render(PromptTask.CREATIVE_BRIEF, {
      groundedContextBlock,
      objective: params.objective,
      audience: params.audience,
      strategyContent: params.strategyContent,
    });

    // Bug réel constaté en conditions réelles (2026-08-21, même classe que StoryboardGateService/
    // CreativeGateService/NarrativeBlueprintService/VideoJudgeService/CreativeConceptService) :
    // sans maxTokens explicite, ce call retombe sur le défaut 4000 de AnthropicProvider —
    // schéma à 16 champs texte, risque réel de troncature JSON en sortie.
    const result = await this.aiGateway.generateText(ctx, { prompt, maxTokens: 8000 }, 'anthropic', PROMPT_VERSIONS.creativeBrief);
    return this.parse(result.content);
  }

  private parse(raw: string): CreativeIntelligence {
    try {
      const parsed = parseAiJson<any>(raw);
      return {
        adObjective: this.asString(parsed.adObjective),
        targetAudience: this.asString(parsed.targetAudience),
        primaryProblem: this.asString(parsed.primaryProblem),
        primaryDesire: this.asString(parsed.primaryDesire),
        primaryBenefit: this.asString(parsed.primaryBenefit),
        valueProposition: this.asString(parsed.valueProposition),
        creativeAngle: this.asString(parsed.creativeAngle),
        desiredEmotion: this.asString(parsed.desiredEmotion),
        hook: this.asString(parsed.hook),
        proofToShow: this.asString(parsed.proofToShow),
        objections: this.asStringArray(parsed.objections),
        mainMessage: this.asString(parsed.mainMessage),
        cta: this.asString(parsed.cta),
        visualTone: this.asString(parsed.visualTone),
        pacing: this.asString(parsed.pacing),
        adStyle: this.asString(parsed.adStyle),
        raw,
      };
    } catch (error) {
      this.logger.warn(`Réponse Creative Intelligence non conforme au format JSON attendu, repli neutre conservé: ${error}`);
      return { ...NEUTRAL_CREATIVE_INTELLIGENCE, raw };
    }
  }

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}
