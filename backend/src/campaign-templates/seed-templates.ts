// Templates fournis nativement par Campaign-ai (isSystem=true), un par secteur prioritaire
// identifié au chapitre 5 du Volume 1 (personas Sophie/PME, Julien/e-commerce, etc.).
// Chaque template guide l'AI Orchestrator : angle d'analyse à privilégier, archétype de
// persona par défaut, style d'appel à l'action — sans imposer de contenu figé.

export interface SeedTemplate {
  name: string;
  sector: 'ECOMMERCE' | 'SAAS_B2B' | 'RESTAURANT_LOCAL' | 'FITNESS_WELLNESS' | 'REAL_ESTATE' | 'EVENT' | 'GENERAL';
  description: string;
  defaultObjective: string;
  defaultChannels: string[];
  toneHint: string;
  structureHint: {
    analysisAngle: string;
    personaArchetype: string;
    ctaStyle: string;
  };
}

export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    name: 'Lancement produit e-commerce',
    sector: 'ECOMMERCE',
    description: "Présente un nouveau produit à partir d'une photo, avec un accent sur la conversion directe.",
    defaultObjective: 'Générer des ventes directes sur les 30 premiers jours',
    defaultChannels: ['facebook', 'instagram', 'googleads', 'email'],
    toneHint: 'Enthousiaste, orienté bénéfice concret, incitatif sans être agressif',
    structureHint: {
      analysisAngle: "Mettre l'accent sur l'USP, le prix perçu et la preuve sociale",
      personaArchetype: 'Acheteur impulsif sensible au rapport qualité-prix (persona Julien, e-commerçant)',
      ctaStyle: "Achat immédiat, offre de lancement limitée dans le temps",
    },
  },
  {
    name: 'Acquisition B2B SaaS',
    sector: 'SAAS_B2B',
    description: 'Génère de la demande qualifiée pour un logiciel B2B, orientée démonstration/essai.',
    defaultObjective: 'Générer des demandes de démo qualifiées',
    defaultChannels: ['linkedin', 'googleads', 'email'],
    toneHint: 'Expert, rassurant, orienté ROI mesurable plutôt qu\'émotionnel',
    structureHint: {
      analysisAngle: "Mettre l'accent sur le gain de temps/productivité et la réduction de risque opérationnel",
      personaArchetype: 'Décideur ou responsable métier cherchant à justifier un investissement (persona Sophie, PME)',
      ctaStyle: 'Démo personnalisée ou essai gratuit, sans engagement',
    },
  },
  {
    name: 'Commerce de proximité',
    sector: 'RESTAURANT_LOCAL',
    description: 'Attire une clientèle locale pour un restaurant, salon ou commerce de quartier.',
    defaultObjective: "Augmenter la fréquentation locale sur le mois",
    defaultChannels: ['facebook', 'instagram'],
    toneHint: 'Chaleureux, convivial, ancré dans le quartier',
    structureHint: {
      analysisAngle: "Mettre l'accent sur l'expérience, l'ambiance et la proximité géographique",
      personaArchetype: 'Habitant du quartier cherchant une recommandation de confiance',
      ctaStyle: 'Visite, réservation, ou découverte en personne',
    },
  },
  {
    name: 'Coaching & bien-être',
    sector: 'FITNESS_WELLNESS',
    description: "Promeut un service de coaching, fitness ou bien-être orienté transformation personnelle.",
    defaultObjective: "Générer des inscriptions à un programme ou une séance d'essai",
    defaultChannels: ['instagram', 'tiktok', 'email'],
    toneHint: 'Motivant, bienveillant, orienté résultat progressif (sans promesse irréaliste)',
    structureHint: {
      analysisAngle: 'Mettre en avant la transformation et le suivi personnalisé',
      personaArchetype: 'Personne motivée mais manquant de structure ou de régularité',
      ctaStyle: "Séance d'essai ou premier échange gratuit",
    },
  },
  {
    name: 'Mise en valeur immobilière',
    sector: 'REAL_ESTATE',
    description: 'Met en avant un bien ou un service immobilier avec un ton rassurant et factuel.',
    defaultObjective: 'Générer des demandes de visite ou de contact qualifiées',
    defaultChannels: ['facebook', 'googleads', 'email'],
    toneHint: 'Factuel, rassurant, valorisant sans exagération',
    structureHint: {
      analysisAngle: 'Mettre en avant les caractéristiques distinctives et la localisation',
      personaArchetype: "Acheteur ou locataire en phase de comparaison active",
      ctaStyle: 'Prise de rendez-vous pour visite',
    },
  },
  {
    name: 'Promotion d\'événement',
    sector: 'EVENT',
    description: 'Génère des inscriptions pour un webinaire, salon ou événement à date fixe.',
    defaultObjective: "Maximiser les inscriptions avant la date de l'événement",
    defaultChannels: ['linkedin', 'facebook', 'email'],
    toneHint: 'Dynamique, créant un sentiment d\'urgence légitime (date fixe)',
    structureHint: {
      analysisAngle: "Mettre l'accent sur la valeur du contenu de l'événement et l'urgence temporelle",
      personaArchetype: 'Professionnel cherchant à monter en compétence ou networker',
      ctaStyle: "Inscription immédiate, places limitées",
    },
  },
];
