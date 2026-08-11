// Gabarits volontairement simples (pas de moteur de templating dédié) — un seul style
// inline cohérent, suffisant pour des emails transactionnels courts. Un vrai design system
// d'emails (MJML, react-email...) serait la prochaine étape naturelle si le volume/la
// diversité d'emails grandit significativement.

function wrap(content: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a18;">
    <div style="font-weight:600;font-size:16px;margin-bottom:20px;">Campaign-ai</div>
    ${content}
    <p style="margin-top:32px;font-size:12px;color:#9a9992;">Cet email vous a été envoyé par Campaign-ai.</p>
  </div>`;
}

export const emailTemplates = {
  invitation(params: { organizationName: string; inviterName: string; acceptUrl: string }) {
    return wrap(`
      <p>${params.inviterName} vous invite à rejoindre <strong>${params.organizationName}</strong> sur Campaign-ai.</p>
      <a href="${params.acceptUrl}" style="display:inline-block;background:#1a1a18;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:12px;">Accepter l'invitation</a>
    `);
  },

  campaignReadyForReview(params: { campaignName: string; reviewUrl: string }) {
    return wrap(`
      <p>La campagne <strong>${params.campaignName}</strong> est prête à être validée.</p>
      <a href="${params.reviewUrl}" style="display:inline-block;background:#1a1a18;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:12px;">Examiner la campagne</a>
    `);
  },

  trialEndingSoon(params: { daysRemaining: number; billingUrl: string }) {
    return wrap(`
      <p>Votre essai gratuit se termine dans <strong>${params.daysRemaining} jour(s)</strong>. Souscrivez un plan pour continuer à utiliser Campaign-ai sans interruption.</p>
      <a href="${params.billingUrl}" style="display:inline-block;background:#1a1a18;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:12px;">Choisir un plan</a>
    `);
  },

  paymentFailed(params: { billingUrl: string }) {
    return wrap(`
      <p>Le paiement de votre abonnement Campaign-ai a échoué. Merci de mettre à jour votre moyen de paiement pour éviter une interruption de service.</p>
      <a href="${params.billingUrl}" style="display:inline-block;background:#1a1a18;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:12px;">Mettre à jour le paiement</a>
    `);
  },

  supportReply(params: { subject: string; ticketUrl: string }) {
    return wrap(`
      <p>Vous avez reçu une réponse à votre demande de support « ${params.subject} ».</p>
      <a href="${params.ticketUrl}" style="display:inline-block;background:#1a1a18;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:12px;">Voir la conversation</a>
    `);
  },
};
