import { Injectable, Logger } from '@nestjs/common';
import { ProductIntelligenceProfile } from '@prisma/client';
import { parseAiJson } from '../../common/parsing/parse-ai-json';
import { AiGatewayService, AiCallContext } from '../ai-gateway/ai-gateway.service';
import { PromptEngineService } from '../prompt-engine/prompt-engine.service';
import { PromptTask } from '../prompt-engine/prompt-task.enum';
import { PROMPT_VERSIONS } from '../prompt-versions';
import { renderGroundedContext } from '../product-intelligence/product-grounding';
import { CreativeIntelligence } from './creative-intelligence.types';
import { CreativeConcept } from './creative-concept.types';
import { CreativeGateResult, CreativeGateStatus } from './creative-gate.types';

export interface EvaluateCreativeGateParams {
  creativeIntelligence: CreativeIntelligence;
  creativeConcept: CreativeConcept;
  objective: string;
  productProfile: ProductIntelligenceProfile | null;
}

const CREATIVE_GATE_THRESHOLD = 75;
const NEUTRAL_SCORE = 50;

// Phase G — Creative Gate (chantier "Moteur d'optimisation de la qualité vidéo — V2",
// 2026-08-19, spec Sections 35-45). Valide le Creative Concept AVANT tout Shot Plan/vidéo —
// "si nous générions exactement cette vidéo, aurait-elle une vraie capacité à promouvoir le
// produit ?". La boucle de révision bornée (REVISE -> régénérer le concept UNE fois -> re-gate)
// vit dans AiOrchestratorService, pas ici — même convention que shot-diversity.ts (ce service
// évalue, l'orchestrateur décide de la boucle), jamais dupliquée deux fois dans le code.
@Injectable()
export class CreativeGateService {
  private readonly logger = new Logger(CreativeGateService.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly promptEngine: PromptEngineService,
  ) {}

  async evaluate(ctx: AiCallContext, params: EvaluateCreativeGateParams): Promise<CreativeGateResult> {
    const missing = this.checkRequiredInputs(params.creativeIntelligence, params.creativeConcept);
    if (missing.length > 0) {
      this.logger.warn(`Creative Gate BLOCKED — informations critiques manquantes, aucun appel de scoring déclenché : ${missing.join('; ')}`);
      return this.buildBlockedResult(missing);
    }

    const groundedContextBlock = params.productProfile ? `\n\n${renderGroundedContext(params.productProfile)}` : '';
    const prompt = this.promptEngine.render(PromptTask.CREATIVE_GATE, {
      creativeIntelligence: params.creativeIntelligence,
      creativeConcept: params.creativeConcept,
      objective: params.objective,
      groundedContextBlock,
    });

    const result = await this.aiGateway.generateText(ctx, { prompt }, 'anthropic', PROMPT_VERSIONS.creativeGate);
    return this.parse(result.content);
  }

  // "Ne pas inventer les informations manquantes" (spec 35.1) — vérifie que le pipeline en amont
  // a réellement produit de quoi construire une publicité, avant de dépenser un appel de scoring.
  // Volontairement borné aux champs dont l'absence rend TOUTE publicité impossible à construire
  // (pas une checklist exhaustive des 16 champs du spec — la plupart sont déjà garantis non vides
  // par les replis neutres de CreativeConceptService/CreativeIntelligenceService, cf. leurs
  // propres .spec.ts) : un concept sans bénéfice, sans hook, sans message central ET sans CTA n'a
  // structurellement rien à évaluer.
  private checkRequiredInputs(intelligence: CreativeIntelligence, concept: CreativeConcept): string[] {
    const missing: string[] = [];
    if (!intelligence.primaryBenefit.trim() && !concept.coreMessage.trim()) {
      missing.push('aucun bénéfice principal ni message central identifié');
    }
    if (!concept.hook.trim()) {
      missing.push('aucun hook défini');
    }
    if (!concept.cta.trim() && !intelligence.cta.trim()) {
      missing.push('aucun CTA défini');
    }
    if (!concept.targetAudience.trim() && !intelligence.targetAudience.trim()) {
      missing.push('aucune cible définie');
    }
    return missing;
  }

  private buildBlockedResult(missing: string[]): CreativeGateResult {
    return {
      status: 'BLOCKED',
      score: 0,
      hook: '',
      promessePrincipale: '',
      benefices: [],
      preuve: '',
      cta: '',
      forces: [],
      faiblesses: [],
      risques: [],
      causesDeRejet: missing,
      recommandation: 'Compléter les informations produit/cible/bénéfice avant de retenter une génération.',
    };
  }

  private parse(raw: string): CreativeGateResult {
    try {
      const parsed = parseAiJson<any>(raw);
      const score = this.asScore(parsed.score);
      const causesDeRejet = this.asStringArray(parsed.causesDeRejet);
      // Le score seul ne suffit pas (spec 43) — un motif de rejet automatique impose BLOCKED
      // même si le modèle a lui-même renvoyé un verdict plus favorable.
      const status: CreativeGateStatus = causesDeRejet.length > 0 ? 'BLOCKED' : this.deriveStatus(score, parsed.verdict);

      return {
        status,
        score,
        hook: this.asString(parsed.hook),
        promessePrincipale: this.asString(parsed.promessePrincipale),
        benefices: this.asStringArray(parsed.benefices),
        preuve: this.asString(parsed.preuve),
        cta: this.asString(parsed.cta),
        forces: this.asStringArray(parsed.forces),
        faiblesses: this.asStringArray(parsed.faiblesses),
        risques: this.asStringArray(parsed.risques),
        causesDeRejet,
        recommandation: this.asString(parsed.recommandation),
      };
    } catch (error) {
      this.logger.warn(`Réponse Creative Gate non conforme au format JSON attendu, repli REVISE (score neutre) : ${error}`);
      return {
        status: 'REVISE',
        score: NEUTRAL_SCORE,
        hook: '',
        promessePrincipale: '',
        benefices: [],
        preuve: '',
        cta: '',
        forces: [],
        faiblesses: [],
        risques: [],
        causesDeRejet: [],
        recommandation: 'Vérification indisponible — nouvelle tentative recommandée.',
      };
    }
  }

  // Seuil déterministe en code, jamais laissé au LLM (même discipline que
  // ProductIdentificationService.deriveConfidenceLevel) — un modèle invité à choisir lui-même
  // son verdict est incohérent d'un appel à l'autre pour un même score.
  private deriveStatus(score: number, rawVerdict: unknown): CreativeGateStatus {
    if (rawVerdict === 'BLOCKED') return 'BLOCKED';
    return score >= CREATIVE_GATE_THRESHOLD ? 'APPROVED' : 'REVISE';
  }

  private asScore(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : NEUTRAL_SCORE;
  }

  private asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}
