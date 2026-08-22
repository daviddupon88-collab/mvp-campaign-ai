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
  // Mission 4.3 (Goal-First Quality Architecture, Phase 2) — buildStageQualityRequirementsBlock(...),
  // '' si aucune exigence de construction applicable au stade concept. Contrairement à
  // gateFeedback (correction APRÈS un rejet), ce bloc est TOUJOURS présent : la contrainte de
  // qualité doit piloter la 1ère tentative, pas seulement les révisions.
  qualityRequirementsBlock: string;
  // Mission 4.4 (Product URL Intelligence, Phase M) — '' quand aucun productProfile n'est
  // disponible (aucune photo, ou photo sans URL exploitée) — même convention que
  // CreativeGateService/CreativeIntelligenceService.
  groundedContextBlock: string;
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
    // Audit forensic (2026-08-22, campagnes réelles) : "proofToShow" (SHOW > TELL, ci-dessus)
    // arrive intact jusqu'ici, mais se dilue en "proofStrategy" quand le concept en fait une
    // formulation créative — c'est CE moment précis où la preuve redevient une affirmation
    // verbale au lieu de rester une action filmable, corrompant toute la chaîne en aval
    // (NarrativeBlueprint, Shot Plan) qui hérite ensuite de "proofStrategy" sans jamais revoir
    // "proofToShow". Réaffirmé explicitement ici plutôt que supposé hérité silencieusement.
    'RÈGLE SHOW > TELL (proofStrategy) : "proofStrategy" doit rester la MÊME action concrète et filmable que "proofToShow", jamais reformulée en affirmation verbale. MAUVAIS : "démontrer l\'efficacité du produit". BON : "montrer le tissu plongé dans le produit devenir uniformément coloré en quelques secondes, à l\'écran". Si "proofStrategy" ne peut pas être filmé tel quel par une caméra, il est invalide.',
    'scenesCount reflète le nombre de scènes RÉELLEMENT nécessaires pour raconter cette idée (entre 2 et 5) — jamais un nombre arbitraire.',
    // Mission 4.3 (Goal-First Quality Architecture, Phase 2, Étape 3) — le principe directeur de
    // la mission : la cible qualité pilote la CONSTRUCTION, pas seulement l'évaluation après coup.
    'Ce concept doit être spécifiquement construit pour satisfaire les exigences de qualité listées ci-dessous — ce sont des contraintes de construction à respecter dès cette proposition, pas des critères vérifiés après coup.',
    'Pour qualityAlignment : cite, pour CHAQUE exigence de construction listée, l\'élément CONCRET et vérifiable de CE concept qui la satisfait (quelle réplique, quel bénéfice, quelle preuve précisément) — jamais une note chiffrée ni une formule vague type "ce concept est fort".',
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
  "scenesCount": 3,
  "qualityAlignment": "..."
}`,
  evaluationCriteria: ["Le concept est une idée publicitaire réelle, pas une description produit", 'scenesCount entre 2 et 5', 'JSON strictement valide'],
  render(context: VideoConceptContext): string {
    const feedbackBlock = context.gateFeedback ? `\n\nCORRECTION REQUISE : une première version de ce concept a été jugée insuffisante par le Creative Gate. Corrige spécifiquement ceci avant de proposer une nouvelle idée : ${context.gateFeedback}` : '';

    return `${this.role} ${this.mission}

${this.constraints[0]}
${this.constraints[1]}

Intelligence publicitaire déterminée pour cette campagne :
${JSON.stringify(context.creativeIntelligence)}${context.groundedContextBlock}

${this.constraints[2]}
${this.constraints[3]}
${this.constraints[4]}
${this.constraints[5]}${context.qualityRequirementsBlock}
${this.constraints[6]}${feedbackBlock}

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact (le format est toujours "9:16", ne le fais pas figurer dans ta réponse) :
${this.outputSchema}`;
  },
};
