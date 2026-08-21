import { PromptTask } from '../prompt-task.enum';
import { PromptTemplate } from '../prompt-engine.types';

export interface RepairContext {
  originalText: string;
  defects: string[]; // justifications/défauts remontés par le Video Judge pour ce texte
  // Phase B (chantier V2, 2026-08-19) — présent uniquement quand un précédent correctif sur ce
  // même texte a eu un résultat FAIBLE (repair-history.ts) : demande un correctif plus radical.
  priorAttemptFailed?: boolean;
}

// Template REPAIR (P0.6/P0.7, chantier "Creative Intelligence Engine & Video Quality Loop",
// 2026-08-18) — correctif SUBTITLE_ONLY (grammaire/lisibilité/rythme du texte parlé), le moins
// coûteux des 4 stratégies de réparation (cf. repair-dispatch.ts) : ne régénère AUCUN média, se
// contente de corriger le TEXTE de la narration déjà générée, réinjecté ensuite dans le montage
// (VideoAssemblyService rebâtit les sous-titres depuis ce texte corrigé).
export const repairTemplate: PromptTemplate<RepairContext> = {
  task: PromptTask.REPAIR,
  role: 'Tu es correcteur pour une publicité vidéo déjà tournée.',
  mission: "Corriger UNIQUEMENT les défauts signalés dans un texte de narration déjà enregistré — sans changer le sens, la longueur globale, ni inventer un nouveau message.",
  constraints: [
    'Corrige la grammaire/orthographe et la lisibilité — ne réécris PAS le message, ne change PAS la longueur de façon significative (le texte sera re-synchronisé sur l\'audio déjà enregistré).',
    "N'ajoute et n'invente aucune information absente du texte original.",
  ],
  outputSchema: '{"correctedText":"..."}',
  evaluationCriteria: ['Corrige uniquement les défauts signalés', 'longueur proche de l\'original', 'JSON strictement valide'],
  render(context: RepairContext): string {
    const escalationBlock = context.priorAttemptFailed ? "\n\nIMPORTANT : le correctif précédent n'a pas suffi — corrige plus radicalement le passage concerné, pas une retouche mineure." : '';

    return `${this.role} ${this.mission}

Texte original : ${context.originalText}
Défauts signalés : ${context.defects.join(' ; ')}

${this.constraints.join(' ')}${escalationBlock}

Réponds UNIQUEMENT en JSON strict, sans texte autour, au format exact :
${this.outputSchema}`;
  },
};
