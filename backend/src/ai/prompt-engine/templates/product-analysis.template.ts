import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';

export interface ProductAnalysisContext {
  descriptionHint?: string;
}

// Template PRODUCT_ANALYSIS (P0.5) — même contenu que le prompt précédemment en dur dans
// ProductVisionAnalysisService.analyze() (P0.1), reformulé en template structuré. Le contrat
// public de ProductVisionAnalysisService ne change pas — seul l'endroit où le texte du prompt
// est assemblé change (ici, plutôt qu'inline dans le service).
export const productAnalysisTemplate: PromptTemplate<ProductAnalysisContext> = {
  task: PromptTask.PRODUCT_ANALYSIS,
  role: 'Tu es un analyste vision produit e-commerce, précis et rigoureux.',
  mission: "Observer une photo de produit avec la plus grande précision et extraire UNIQUEMENT ce qui est réellement visible.",
  constraints: [
    'Si une information n\'est PAS visible dans l\'image, renvoie null (ou un tableau vide) pour ce champ.',
    'Ne devine JAMAIS, ne complète JAMAIS depuis une connaissance générale de ce type de produit.',
    'Une identification incertaine ne doit jamais être présentée comme un fait.',
  ],
  outputSchema: `{
  "category": "..."|null,
  "subcategory": "..."|null,
  "productType": "..."|null,
  "brand": "..."|null,
  "productName": "..."|null,
  "model": "..."|null,
  "visibleText": ["...", "..."],
  "logoDetected": true|false,
  "packaging": "..."|null,
  "colors": ["...", "..."],
  "materials": ["...", "..."],
  "shape": "..."|null,
  "visualAttributes": ["...", "..."],
  "distinctiveFeatures": ["...", "..."],
  "visibleClaims": ["...", "..."],
  "identificationClues": ["...", "..."],
  "confidence": 0.0
}`,
  evaluationCriteria: ['Aucun champ deviné/halluciné', 'confidence reflète la certitude globale, pas la qualité photo', 'JSON strictement valide'],
  render(context: ProductAnalysisContext): string {
    const descriptionHint = context.descriptionHint?.trim()
      ? `\nDescription fournie par l'utilisateur, à recouper avec ce que montre réellement l'image : ${context.descriptionHint}`
      : '';

    return `${this.role} ${this.mission}${descriptionHint}

RÈGLE ABSOLUE : ${this.constraints.join(' ')}

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
${this.outputSchema}
"confidence" (0 à 1) reflète ta certitude GLOBALE sur l'identification du produit à partir de cette seule image, pas la qualité de la photo.`;
  },
};
