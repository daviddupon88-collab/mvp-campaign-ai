import { ApiError } from './api';

// ApiError porte les champs structurés d'un PlanLimitExceededException backend (cf.
// plan-limit.exception.ts) jusqu'à l'UI — c'est ce qui permet à UpgradeModal de distinguer
// un plafond de plan de n'importe quelle autre erreur 4xx et d'afficher un moment de
// conversion ciblé plutôt qu'un message générique. Un bug de propagation ici redégraderait
// silencieusement cette expérience en simple toast d'erreur (cf. correctif historique
// mentionné dans le README, item 54).
describe('ApiError', () => {
  it('reconnaît une erreur de plafond de plan via isPlanLimit', () => {
    const error = new ApiError(
      {
        message: 'Quota de campagnes actives atteint',
        code: 'PLAN_LIMIT_EXCEEDED',
        limitType: 'activeCampaigns',
        currentPlan: 'starter',
        current: 3,
        limit: 3,
        recommendedPlan: 'growth',
        statusCode: 403,
      },
      403,
    );

    expect(error.isPlanLimit).toBe(true);
    expect(error.recommendedPlan).toBe('growth');
    expect(error.message).toBe('Quota de campagnes actives atteint');
  });

  it('ne signale pas isPlanLimit pour une erreur 4xx quelconque', () => {
    const error = new ApiError({ message: 'Identifiants invalides' }, 401);

    expect(error.isPlanLimit).toBe(false);
    expect(error.statusCode).toBe(401); // repli sur fallbackStatus quand le corps n'en fournit pas
  });

  it('utilise un message par défaut quand le corps de réponse est vide', () => {
    const error = new ApiError({}, 500);
    expect(error.message).toBe('API error (500)');
  });
});
