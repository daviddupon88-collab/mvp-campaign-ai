import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';
import { CreativeIntelligence } from '../../creative-intelligence/creative-intelligence.types';

export interface VideoConceptContext {
  creativeIntelligence: CreativeIntelligence;
  // Phase G (chantier "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19) — présent
  // uniquement lors de l'unique régénération déclenchée par le Creative Gate (verdict REVISE) :
  // injecte les faiblesses/recommandation du jugement précédent pour que cette 2e tentative
  // corrige réellement le défaut identifié, au lieu de simplement retenter la même idée.
  gateFeedback?: string;
}

// Template VIDEO_CONCEPT (P0.2, chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18). Transforme la Creative Intelligence en une idée publicitaire concrète — le
// contraste mauvais/bon exemple ci-dessous (fourni explicitement par le brief) est LA règle la
// plus importante de ce template : un concept qui ne fait que décrire le produit est un échec,
// même si le JSON est parfaitement valide.
export const videoConceptTemplate: PromptTemplate<VideoConceptContext> = {
  task: PromptTask.VIDEO_CONCEPT,
  role: 'Tu es un concepteur-rédacteur publicitaire senior, spécialiste du format vidéo courte (publicité sociale verticale).',
  mission: "Transformer une intelligence publicitaire déjà déterminée en une vraie IDÉE de publicité — jamais une simple description du produit.",
  constraints: [
    'MAUVAIS (rejeté) : une description littérale du produit en situation, ex. "Une veste de sécurité portée par un travailleur sur un chantier."',
    'BON (attendu) : une idée qui montre un problème puis démontre visuellement comment le produit le résout, ex. "Montrer le problème de visibilité sur chantier puis démontrer visuellement comment la veste améliore la visibilité du travailleur."',
    'Le concept doit s\'appuyer sur "hook", "proofToShow" et "creativeAngle" déjà déterminés — ne les ignore pas pour repartir d\'une idée générique.',
    'scenesCount reflète le nombre de scènes RÉELLEMENT nécessaires pour raconter cette idée (entre 2 et 5) — jamais un nombre arbitraire.',
  ],
  outputSchema: `{
  "title": "...",
  "concept": "...",
  "coreMessage": "...",
  "hook": "...",
  "emotionalDirection": "...",
  "visualDirection": "...",
  "storytellingApproach": "...",
  "proofStrategy": "...",
  "cta": "...",
  "targetAudience": "...",
  "duration": 15,
  "scenesCount": 3
}`,
  evaluationCriteria: ["Le concept est une idée publicitaire réelle, pas une description produit", 'scenesCount entre 2 et 5', 'JSON strictement valide'],
  render(context: VideoConceptContext): string {
    const feedbackBlock = context.gateFeedback ? `\n\nCORRECTION REQUISE : une première version de ce concept a été jugée insuffisante par le Creative Gate. Corrige spécifiquement ceci avant de proposer une nouvelle idée : ${context.gateFeedback}` : '';

    return `${this.role} ${this.mission}

${this.constraints[0]}
${this.constraints[1]}

Intelligence publicitaire déterminée pour cette campagne :
${JSON.stringify(context.creativeIntelligence)}

${this.constraints[2]} ${this.constraints[3]}${feedbackBlock}

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact (le format est toujours "9:16", ne le fais pas figurer dans ta réponse) :
${this.outputSchema}`;
  },
};
