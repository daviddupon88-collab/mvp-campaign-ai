import { PromptTask } from './prompt-task.enum';

// Contrat structuré demandé par le brief pour chaque prompt : role/mission/context/constraints/
// examples/output_schema/evaluation_criteria. "context" n'est PAS un champ statique ici — il est
// injecté dynamiquement via render(context) (ex: le Product Intelligence Profile, l'analyse
// vision déjà extraite...), donc porté par TContext plutôt que par un champ texte figé.
export interface PromptTemplate<TContext> {
  task: PromptTask;
  role: string;
  mission: string;
  constraints: string[];
  outputSchema: string; // description textuelle du JSON de sortie attendu
  evaluationCriteria?: string[];
  render(context: TContext): string; // assemble role+mission+constraints+outputSchema+context en prompt final
}
