export interface LegalDocument {
  type: 'TERMS_OF_SERVICE' | 'PRIVACY_POLICY' | 'AI_DISCLOSURE';
  version: string;
  title: string;
  body: string; // Markdown
}

// Textes légaux versionnés — la version doit changer à chaque modification substantielle,
// et toute nouvelle version nécessite une nouvelle acceptation (cf. PolicyAcceptance,
// jamais écrasée, jamais réutilisée pour une version différente). Contenu simplifié/gabarit :
// un vrai déploiement en production ferait relire ces textes par un juriste avant publication.
const CURRENT_VERSION = '2026-01-01';

const DOCUMENTS: Record<string, LegalDocument> = {
  TERMS_OF_SERVICE: {
    type: 'TERMS_OF_SERVICE',
    version: CURRENT_VERSION,
    title: "Conditions Générales d'Utilisation",
    body: `# Conditions Générales d'Utilisation de Campaign-ai

En utilisant Campaign-ai, vous acceptez que la plateforme génère des campagnes marketing
à l'aide de fournisseurs d'intelligence artificielle tiers (OpenAI, Anthropic, Google, et
autres selon disponibilité). Vous restez responsable de la validation et de la publication
finale de tout contenu généré — cf. workflow d'approbation obligatoire de la plateforme.

L'abonnement est facturé mensuellement selon le plan souscrit. Les crédits IA inclus sont
consommés selon la grille en vigueur, consultable dans votre espace de facturation.

[Gabarit — à faire relire par un juriste avant toute mise en production.]`,
  },
  PRIVACY_POLICY: {
    type: 'PRIVACY_POLICY',
    version: CURRENT_VERSION,
    title: 'Politique de Confidentialité',
    body: `# Politique de Confidentialité

Campaign-ai traite vos données personnelles (email, nom, contenu de vos campagnes) pour
fournir le service souscrit. Certaines données sont transmises à des fournisseurs d'IA
tiers dans le cadre de la génération de contenu (cf. Politique de sous-traitance).

Vous disposez d'un droit d'accès, de rectification, de portabilité (export de vos données
personnelles via votre espace confidentialité) et d'effacement (suppression de votre compte).

[Gabarit — à faire relire par un juriste avant toute mise en production. Registre des
traitements complet à tenir séparément (Article 30 RGPD).]`,
  },
  AI_DISCLOSURE: {
    type: 'AI_DISCLOSURE',
    version: CURRENT_VERSION,
    title: "Information sur l'utilisation de l'intelligence artificielle",
    body: `# Utilisation de systèmes d'IA — Information (AI Act)

L'intégralité du contenu marketing produit par Campaign-ai (textes, visuels, vidéos) est
généré par des systèmes d'intelligence artificielle. Chaque génération est tracée
(fournisseur, modèle, horodatage — cf. AiGeneration) et soumise à une validation humaine
obligatoire avant toute publication (cf. workflow d'approbation).

Des vérifications automatiques (modération de sécurité, cohérence de marque) sont
appliquées à chaque génération avant qu'elle n'atteigne l'écran de validation humaine.

[Gabarit — la classification précise de risque au sens de l'AI Act européen et les
obligations qui en découlent doivent être établies avec un conseil juridique spécialisé.]`,
  },
};

export function getLegalDocument(type: string): LegalDocument {
  const doc = DOCUMENTS[type];
  if (!doc) throw new Error(`Document légal inconnu: ${type}`);
  return doc;
}

export function listLegalDocuments(): LegalDocument[] {
  return Object.values(DOCUMENTS);
}

export function getCurrentPolicyVersion(): string {
  return CURRENT_VERSION;
}
