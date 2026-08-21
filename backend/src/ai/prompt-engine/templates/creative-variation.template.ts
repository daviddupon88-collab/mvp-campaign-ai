import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';
import { CreativeConcept } from '../../creative-intelligence/creative-concept.types';

export interface CreativeVariationContext {
  acceptedConcept: CreativeConcept;
  count: number;
}

// Template CREATIVE_VARIATION (P0.12, chantier "Creative Intelligence Engine & Video Quality
// Loop", 2026-08-18) — itère sur un concept DÉJÀ VALIDÉ (jamais une nouvelle passe stratégique
// depuis Product/Creative Intelligence) : varie hook/ordre des arguments/CTA, conserve
// visualDirection/format/scenesCount pour rester compatible avec ce qui a déjà été approuvé.
export const creativeVariationTemplate: PromptTemplate<CreativeVariationContext> = {
  task: PromptTask.CREATIVE_VARIATION,
  role: 'Tu es concepteur-rédacteur publicitaire senior, spécialiste des tests créatifs A/B/C.',
  mission: "Proposer des variantes d'un concept publicitaire DÉJÀ VALIDÉ — jamais une nouvelle idée, des angles différents sur la MÊME idée (hook différent, ordre des arguments différent, CTA différent).",
  constraints: [
    'Conserve visualDirection, format et scenesCount identiques au concept d\'origine — seuls hook/coreMessage/storytellingApproach/cta peuvent varier entre les variantes.',
    "Chaque variante doit rester fidèle au même produit et aux mêmes preuves (proofStrategy) — ne réintroduis jamais une caractéristique non confirmée dans le concept d'origine.",
  ],
  outputSchema: `[{"title":"...","concept":"...","coreMessage":"...","hook":"...","emotionalDirection":"...","storytellingApproach":"...","proofStrategy":"...","cta":"..."}]`,
  evaluationCriteria: ['Chaque variante propose un angle réellement différent (pas une reformulation)', 'JSON strictement valide'],
  render(context: CreativeVariationContext): string {
    return `${this.role} ${this.mission}

Concept déjà validé :
${JSON.stringify(context.acceptedConcept)}

${this.constraints.join(' ')}

Réponds UNIQUEMENT en JSON strict, sans texte autour, un tableau d'EXACTEMENT ${context.count} variantes au format exact :
${this.outputSchema}`;
  },
};
