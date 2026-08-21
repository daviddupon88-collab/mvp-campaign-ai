import { test, expect, Page } from '@playwright/test';

// Parcours réel de la page facturation (/settings/billing), contre le vrai backend — pas de
// mocks. Ne va JAMAIS jusqu'au clic "Choose this plan"/"Contact us" : ça déclencherait un
// vrai appel sortant à l'API Stripe (POST /billing/checkout), non configurée en CI
// (STRIPE_SECRET_KEY absente) et non souhaitable dans une suite e2e déterministe. Ce test
// vérifie uniquement que GET /plans et GET /plans/usage sont correctement consommés et
// rendus — la même grille de tarifs (`plan-catalog.ts`) est déjà couverte unitairement côté
// backend (plan-catalog.spec.ts) ; ce qui manquait était la preuve que le frontend l'affiche
// fidèlement, sans valeur codée en dur qui pourrait se désynchroniser.

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

async function registerAndReachDashboard(page: Page, email: string, password: string) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Test Playwright Billing');
  await page.getByLabel('Organization name').fill('Organisation Playwright Billing');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole('button', { name: 'Skip and go to dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('Facturation et grille tarifaire', () => {
  test('quota d\'essai et grille de plans reflètent fidèlement les données réelles du backend', async ({ page }) => {
    const email = uniqueEmail('billing');
    const password = 'motdepasse-solide-123';

    await registerAndReachDashboard(page, email, password);
    await page.goto('/settings/billing');

    // --- Quota d'essai : 0 crédit consommé sur les crédits inclus (aucune campagne créée) —
    //     preuve que GET /plans/usage reflète le vrai solde de Subscription, pas une valeur
    //     par défaut du frontend. Valeur alignée sur PLAN_CATALOG.trial.aiCreditsIncluded
    //     (plan-catalog.ts) — actuellement 50000, TEMPORAIRE (2026-08-18, cf. commentaire sur
    //     cette ligne côté backend) : remettre "0 / 1100" ici quand cette valeur est revertée.
    //     Ce test était déjà désynchronisé AVANT ce chantier (hardcodait "0 / 300", alors que
    //     le backend était déjà à 1100 depuis plus tôt le même jour) — jamais détecté faute
    //     d'avoir fait tourner cette suite Playwright entre-temps. ---
    await expect(page.getByText('AI credits used this month')).toBeVisible();
    await expect(page.getByText('0 / 50000')).toBeVisible();
    await expect(page.getByText(/Free trial — ends on/)).toBeVisible();

    // --- Grille de plans : GET /plans exclut 'trial' (non sélectionnable) — les 4 plans
    //     payants doivent apparaître avec leurs vraies valeurs de plan-catalog.ts, jamais un
    //     essai (pas de bouton "Current plan" puisque le plan courant n'est pas dans la liste).
    //     Assertions par texte non scopées à une carte : chaque valeur numérique est unique à
    //     son plan dans la grille actuelle (aucune ambiguïté), sauf les deux libellés partagés
    //     entre plusieurs cartes ("Unlimited channels", "Choose this plan"), vérifiés par
    //     comptage plutôt que par un scoping DOM fragile (une carte de plan n'a pas d'attribut
    //     dédié à cibler sans en ajouter un artificiellement pour ce seul test). ---
    await expect(page.getByText('Change plan')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Current plan' })).not.toBeVisible();

    // Starter — 39€/mois, 920 crédits, 3 sièges, 3 campagnes actives, 3 canaux/campagne
    await expect(page.getByText('39€')).toBeVisible();
    await expect(page.getByText('920 AI credits/month')).toBeVisible();
    await expect(page.getByText('3 seats')).toBeVisible();
    await expect(page.getByText('3 active campaigns')).toBeVisible();
    await expect(page.getByText('3 channels per campaign')).toBeVisible();

    // Growth — 99€/mois, 2585 crédits, 10 sièges, 10 campagnes actives, plan mis en avant
    await expect(page.getByText('Popular')).toBeVisible();
    await expect(page.getByText('99€')).toBeVisible();
    await expect(page.getByText('2,585 AI credits/month')).toBeVisible();
    await expect(page.getByText('10 seats')).toBeVisible();
    await expect(page.getByText('10 active campaigns')).toBeVisible();

    // Business — 249€/mois, 6835 crédits, 30 sièges, 28 campagnes actives
    await expect(page.getByText('249€')).toBeVisible();
    await expect(page.getByText('6,835 AI credits/month')).toBeVisible();
    await expect(page.getByText('30 seats')).toBeVisible();
    await expect(page.getByText('28 active campaigns')).toBeVisible();

    // Enterprise — sur devis, 69000 crédits (plafond indicatif), sièges illimités
    await expect(page.getByText('Custom quote')).toBeVisible();
    await expect(page.getByText('69,000 AI credits/month')).toBeVisible();
    await expect(page.getByText('Unlimited seats')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Contact us' })).toBeVisible();

    // Partagés entre plusieurs cartes : Growth/Business/Enterprise (canaux illimités),
    // Starter/Growth/Business (bouton d'achat identique) — comptage plutôt qu'identité.
    await expect(page.getByText('Unlimited channels')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Choose this plan' })).toHaveCount(3);
  });
});
