/** @type {import('jest').Config} */
module.exports = {
  // testEnvironment 'node' suffit : ces tests couvrent de la logique pure (RBAC miroir,
  // parsing d'erreur API), pas de rendu de composant — pas besoin de jsdom pour l'instant.
  // Le rootDir exclut e2e/ (Playwright, testMatch propre, cf. playwright.config.ts) : les
  // deux coexistent sans collision, chacun sur son testMatch.
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)sx?$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  testEnvironment: 'node',
};
