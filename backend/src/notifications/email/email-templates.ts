// Gabarits volontairement simples (pas de moteur de templating dédié) — un seul style
// inline cohérent, suffisant pour des emails transactionnels courts. Un vrai design system
// d'emails (MJML, react-email...) serait la prochaine étape naturelle si le volume/la
// diversité d'emails grandit significativement.

// Toute valeur interpolée ici peut venir d'un texte libre saisi par un utilisateur (nom
// d'organisation, nom de campagne, sujet de ticket) — jamais échappée avant cette correction,
// ce qui permettait d'injecter du HTML/JS dans l'email d'un tiers (ex: nom d'organisation
// contenant une balise <img onerror=...>). Les URLs (acceptUrl, reviewUrl...) restent non
// échappées : elles sont toujours générées côté serveur, jamais saisies par un utilisateur.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
      <p>${escapeHtml(params.inviterName)} vous invite à rejoindre <strong>${escapeHtml(params.organizationName)}</strong> sur Campaign-ai.</p>
      <a href="${params.acceptUrl}" style="display:inline-block;background:#1a1a18;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:12px;">Accepter l'invitation</a>
    `);
  },

  campaignReadyForReview(params: { campaignName: string; reviewUrl: string }) {
    return wrap(`
      <p>La campagne <strong>${escapeHtml(params.campaignName)}</strong> est prête à être validée.</p>
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
      <p>Vous avez reçu une réponse à votre demande de support « ${escapeHtml(params.subject)} ».</p>
      <a href="${params.ticketUrl}" style="display:inline-block;background:#1a1a18;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;margin-top:12px;">Voir la conversation</a>
    `);
  },
};
