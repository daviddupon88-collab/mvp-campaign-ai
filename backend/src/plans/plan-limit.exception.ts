import { ForbiddenException } from '@nestjs/common';

// Distincte d'un ForbiddenException générique : porte des données structurées que le
// frontend peut exploiter pour transformer un refus en moment de conversion (proposer
// explicitement le plan supérieur), plutôt qu'un simple message d'erreur affiché en toast.
// Le code 'PLAN_LIMIT_EXCEEDED' permet au frontend de distinguer ce cas précis de toute
// autre 403 (abonnement suspendu, budget dépassé...), qui ne doivent pas déclencher la
// même invite à l'upgrade.
export interface PlanLimitExceededPayload {
  message: string;
  code: 'PLAN_LIMIT_EXCEEDED';
  limitType: 'credits' | 'seats' | 'activeCampaigns' | 'channels' | 'images' | 'videos' | 'socialPosts' | 'optimizerRuns';
  currentPlan: string;
  current: number;
  limit: number;
  recommendedPlan: string | null; // null si déjà sur le plan le plus élevé (Enterprise)
}

export class PlanLimitExceededException extends ForbiddenException {
  constructor(payload: PlanLimitExceededPayload) {
    // Le premier argument devient le corps de réponse HTTP complet (cf. correctif apporté
    // à GlobalExceptionFilter, qui préserve désormais les champs structurés plutôt que de
    // ne garder que `.message`).
    super(payload);
  }
}
