module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 2021,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'dist', 'node_modules'],
  rules: {
    // Volontairement permissif sur ce projet à ce stade — l'objectif de la CI est
    // d'attraper les erreurs structurelles (variables non définies, imports cassés),
    // pas d'imposer un style strict qui bloquerait chaque nouveau chantier.
    '@typescript-eslint/no-explicit-any': 'off',
    // argsIgnorePattern/varsIgnorePattern : reconnaît la convention déjà utilisée dans le code
    // (préfixer un paramètre/variable intentionnellement inutilisé par `_`, ex: `_dto`, `_k`)
    // — sans ça, ESLint signale ces cas comme des warnings alors qu'ils sont volontaires.
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    'no-console': 'off',
  },
};
