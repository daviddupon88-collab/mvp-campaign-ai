const createNextIntlPlugin = require('next-intl/plugin');
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Produit .next/standalone (serveur Node minimal, dépendances tracées automatiquement —
  // pas de node_modules complet à réinstaller dans l'image de production) plutôt que le
  // dossier .next classique + node_modules entier — cf. frontend/Dockerfile, dont l'étape
  // finale ne copie plus que ce dossier autonome. Réduit sensiblement la taille de l'image
  // Docker de production (README item 52).
  // N'affecte que le build Docker : next dev / next start en local (npm run test:e2e
  // compris) continuent de fonctionner tels quels. Next.js émet un avertissement
  // informatif lors de ces usages locaux ("next start does not work with output:
  // standalone") — sans rapport avec le serveur autonome réellement utilisé par le
  // Dockerfile, testé séparément (server.js démarre et sert une page complète).
  output: 'standalone',
};

module.exports = withNextIntl(nextConfig);
