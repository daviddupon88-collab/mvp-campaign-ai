import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';
import { ProductVisionAnalysis } from '../../product-intelligence/product-intelligence.types';

export interface ProductIdentificationContext {
  vision: ProductVisionAnalysis;
  descriptionHint?: string;
}

// Template PRODUCT_IDENTIFICATION (P0.5) — même contenu que le prompt précédemment en dur dans
// ProductIdentificationService.identify() (P0.2). Le contrat public du service ne change pas.
export const productIdentificationTemplate: PromptTemplate<ProductIdentificationContext> = {
  task: PromptTask.PRODUCT_IDENTIFICATION,
  role: 'Tu es un expert en identification produit à partir d\'indices visuels.',
  mission: "Proposer jusqu'à 3 hypothèses sur l'identité précise d'un produit (nom, marque, modèle), à partir de l'analyse vision déjà extraite — jamais depuis une nouvelle observation de l'image.",
  constraints: [
    'Utilise UNIQUEMENT les indices fournis dans l\'analyse vision — ne suppose rien d\'autre.',
    'Si les indices sont insuffisants pour distinguer un produit précis, propose moins de candidats plutôt que d\'inventer une identification non fondée.',
    'Un tableau vide est une réponse valide si rien n\'est identifiable.',
  ],
  outputSchema: '{"candidates":[{"name":"...","brand":"..."|null,"model":"..."|null,"matchScore":0.0,"reason":"..."}]}',
  evaluationCriteria: ['matchScore reflète le soutien des indices pour CETTE hypothèse précise, pas une confiance générale', 'JSON strictement valide'],
  render(context: ProductIdentificationContext): string {
    const descriptionHint = context.descriptionHint?.trim() ? `\nDescription fournie par l'utilisateur : ${context.descriptionHint}` : '';

    return `${this.role} ${this.mission}

Voici l'analyse vision structurée d'une photo produit :
${JSON.stringify(context.vision)}${descriptionHint}

${this.constraints.join(' ')}

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
${this.outputSchema}
"matchScore" (0 à 1) reflète à quel point les indices de l'analyse vision soutiennent CETTE hypothèse précise.`;
  },
};
