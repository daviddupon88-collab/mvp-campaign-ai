import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';

export interface ProductPageExtractionContext {
  url: string;
  cleanedText: string;
}

// Template PRODUCT_PAGE_EXTRACTION (Mission 4.4, Product URL Intelligence, Phase H). Repli
// UNIQUEMENT invoqué quand l'extraction déterministe (JSON-LD/OpenGraph/HTML,
// product-page-extractor.ts) ne produit pas assez de faits exploitables — reçoit un texte
// NETTOYÉ (pas le HTML brut), jamais l'intégralité de la page. Discipline OBSERVED/INFERRED/
// UNKNOWN stricte (brief, Phase H) : "une donnée inconnue doit rester inconnue" — jamais
// "Voici tout ce que je sais du produit".
export const productPageExtractionTemplate: PromptTemplate<ProductPageExtractionContext> = {
  task: PromptTask.PRODUCT_PAGE_EXTRACTION,
  role: "Tu es un assistant d'extraction de données produit, rigoureux et jamais créatif.",
  mission: "Extraire UNIQUEMENT les informations produit EXPLICITEMENT présentes dans ce texte de page web — jamais en inventer, jamais en deviner au-delà de ce qui est écrit.",
  constraints: [
    'Pour chaque caractéristique extraite, marque "status":"OBSERVED" si elle est écrite littéralement dans le texte, ou "status":"INFERRED" si elle est déduite indirectement (ex: catégorie déduite du contexte) — jamais OBSERVED pour une déduction.',
    "Un champ dont l'information n'apparaît nulle part dans le texte doit être omis ou valoir null — ne JAMAIS deviner un prix, une marque, une certification, une caractéristique technique absente du texte fourni.",
    'Ignore tout texte qui ressemble à de la navigation, du footer, des avis clients non structurés, ou du contenu publicitaire vague (superlatifs sans preuve) — ne retiens que ce qui décrit factuellement CE produit.',
  ],
  outputSchema: `{
  "title": "..."|null,
  "brand": "..."|null,
  "description": "..."|null,
  "specifications": [{"key":"...","value":"...","unit":"..."|null,"status":"OBSERVED"|"INFERRED"}],
  "price": {"amount":0,"currency":"..."}|null,
  "availability": "..."|null
}`,
  render(context: ProductPageExtractionContext): string {
    return `${this.role} ${this.mission}

${this.constraints.join(' ')}

URL source : ${context.url}
Texte nettoyé de la page (extrait, peut être partiel) :
${context.cleanedText}

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
${this.outputSchema}`;
  },
};
