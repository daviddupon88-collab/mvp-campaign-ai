import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';

export interface CreativeBriefContext {
  // '' quand aucune photo n'a été fournie (repli texte, cf. CreativeIntelligenceService).
  groundedContextBlock: string;
  objective: string;
  audience?: string;
  strategyContent: string;
}

// Template CREATIVE_BRIEF (P0.1, chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18) — remplace le bloc informel (4 champs : AUDIENCE/TON/MESSAGE CLÉ/MANDATORIES)
// jusqu'ici en dur dans le prompt de stratégie de AiOrchestratorService, par une intelligence
// publicitaire structurée et complète (16 champs). Le contrat de génération de stratégie
// existant N'EST PAS modifié par ce template — CreativeIntelligenceService est un appel
// additionnel, distinct.
export const creativeBriefTemplate: PromptTemplate<CreativeBriefContext> = {
  task: PromptTask.CREATIVE_BRIEF,
  role: 'Tu es un directeur de création publicitaire senior, spécialiste de la publicité vidéo qui convertit.',
  mission:
    "À partir de l'intelligence produit et de la stratégie marketing, déterminer les fondations créatives d'une publicité : cible, problème, désir, bénéfice, angle, émotion, preuve à MONTRER — jamais encore une idée de pub concrète (cela viendra dans une étape suivante), mais ce qui la fondera.",
  constraints: [
    "RÈGLE SHOW > TELL : pour \"proofToShow\", décris ce qu'il faut MONTRER visuellement pour démontrer le bénéfice principal — jamais une simple affirmation à énoncer. Exemple : pas \"Haute visibilité\" (TELL), mais \"le gilet capte et réfléchit une source lumineuse dans l'obscurité\" (SHOW, filmable).",
    "N'utilise QUE des caractéristiques déjà confirmées par l'intelligence produit ci-dessous pour \"proofToShow\" et \"mainMessage\" — une caractéristique marquée NON vérifiée ou INCONNUE ne doit jamais devenir une affirmation présentée comme acquise.",
    'Sans intelligence produit disponible (repli texte), reste dans les limites de ce qui est raisonnablement déductible de la description fournie — ne comble jamais un vide par une invention.',
  ],
  outputSchema: `{
  "adObjective": "...",
  "targetAudience": "...",
  "primaryProblem": "...",
  "primaryDesire": "...",
  "primaryBenefit": "...",
  "valueProposition": "...",
  "creativeAngle": "...",
  "desiredEmotion": "...",
  "hook": "...",
  "proofToShow": "...",
  "objections": ["...", "..."],
  "mainMessage": "...",
  "cta": "...",
  "visualTone": "...",
  "pacing": "...",
  "adStyle": "..."
}`,
  evaluationCriteria: ['proofToShow est démontrable visuellement, pas une simple affirmation', 'aucune caractéristique inventée', 'JSON strictement valide'],
  render(context: CreativeBriefContext): string {
    const audienceLine = context.audience?.trim() ? `\nAudience indiquée par l'utilisateur : ${context.audience}` : '';

    return `${this.role} ${this.mission}

Objectif de campagne : ${context.objective}${audienceLine}

Stratégie marketing retenue :
${context.strategyContent}${context.groundedContextBlock}

${this.constraints.join(' ')}

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
${this.outputSchema}`;
  },
};
