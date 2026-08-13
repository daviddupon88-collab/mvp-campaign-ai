import { defineConfig, devices } from '@playwright/test';

// Parcours réel dans un vrai navigateur, contre le backend NestJS + PostgreSQL + Redis
// (pas de mocks réseau) — cf. README pour le mode AI_MODE=mock qui rend ce parcours
// exécutable sans clés API réelles. webServer démarre le frontend Next.js lui-même ;
// le backend doit déjà tourner séparément (build + node dist/main.js, cf. .env.test).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Locale navigateur déterministe : English est la langue par défaut de Campaign-ai, la
    // détection automatique (Accept-Language) doit donc y aboutir quel que soit le poste/CI
    // qui exécute la suite — cf. frontend/src/i18n pour la logique de détection elle-même.
    locale: 'en-US',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run start -- -p 3000',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
