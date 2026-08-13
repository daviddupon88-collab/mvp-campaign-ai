// Migration de .eslintrc.json (format legacy, retiré avec `next lint` en Next.js 16) vers
// la config plate (flat config) native, désormais fournie directement par eslint-config-next
// (dist/core-web-vitals.js) plutôt que via l'ancien alias de chaîne "next/core-web-vitals"
// chargé par FlatCompat — cette dernière approche provoquait une erreur ("Converting
// circular structure to JSON") au chargement, incompatible avec cette version du paquet.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    rules: {
      // Désactivé : le contenu de ce projet est en français, où l'apostrophe droite est
      // idiomatique dans du texte JSX ("l'organisation", "d'une page blanche"...) — cette
      // règle déclencherait une erreur sur quasiment chaque page sans corriger de bug réel.
      // Même logique que le lint backend (.eslintrc.js) : attraper les erreurs structurelles,
      // pas imposer un style qui ne correspond pas à la langue du contenu.
      'react/no-unescaped-entities': 'off',
    },
  },
];

export default eslintConfig;
