// Échec rapide plutôt que tardif : un secret manquant ou laissé à sa valeur de
// développement par défaut doit empêcher le démarrage en production, pas se manifester
// des heures plus tard par un token JWT forgeable ou des tokens sociaux stockés en clair.
// Volontairement permissif en dehors de production — le mode mock/développement local
// (cf. README, "Démarrage rapide sans clés API") ne doit jamais être bloqué par ceci.
const DEV_DEFAULTS = new Set(['dev-secret-change-me', 'change-me-in-production']);

interface EnvCheck {
  key: string;
  required: boolean; // requis même hors production (le service ne peut pas démarrer sans)
  productionOnly: boolean; // requis uniquement quand NODE_ENV=production
}

const CHECKS: EnvCheck[] = [
  { key: 'DATABASE_URL', required: true, productionOnly: false },
  { key: 'JWT_SECRET', required: false, productionOnly: true },
  { key: 'TOKEN_ENCRYPTION_KEY', required: false, productionOnly: true },
  { key: 'OAUTH_STATE_SECRET', required: false, productionOnly: true },
];

export function validateEnv(): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors: string[] = [];

  for (const check of CHECKS) {
    const value = process.env[check.key];

    if (check.required && !value) {
      errors.push(`${check.key} est requis (absent).`);
      continue;
    }

    if (check.productionOnly && isProduction) {
      if (!value) {
        errors.push(`${check.key} est requis en production (absent).`);
      } else if (DEV_DEFAULTS.has(value)) {
        errors.push(`${check.key} est encore à sa valeur de développement par défaut — à changer avant tout déploiement en production.`);
      }
    }
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Échec de validation des variables d\'environnement au démarrage :\n' + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }
}
