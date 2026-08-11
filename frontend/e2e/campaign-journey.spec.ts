import { test, expect, Page } from '@playwright/test';

// Parcours réel dans un vrai navigateur, contre le backend NestJS + PostgreSQL + Redis
// (AI_MODE=mock côté backend : la génération IA est simulée mais traverse le vrai pipeline
// asynchrone — queue BullMQ, AI Orchestrator, modération, Content Studio). Aucun mock réseau
// côté Playwright : chaque clic déclenche un vrai appel HTTP au backend réel.

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

async function register(page: Page, email: string, password: string) {
  await page.goto('/register');
  await page.getByLabel('Nom complet').fill('Test Playwright');
  await page.getByLabel("Nom de l'organisation").fill('Organisation Playwright');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page).toHaveURL(/\/onboarding/);
}

test.describe('Parcours utilisateur réel', () => {
  test('inscription → onboarding → création de campagne → génération IA → approbation', async ({ page }) => {
    const email = uniqueEmail('journey');
    const password = 'motdepasse-solide-123';

    await register(page, email, password);

    // --- Onboarding : étape 1, Brand Kit ---
    await page.getByLabel('Ton éditorial').fill('Chaleureux et direct, orienté résultats');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('✓ Brand Kit renseigné')).toBeVisible();

    // --- Onboarding : étape 3, première campagne ---
    await page.getByRole('button', { name: 'Créer une campagne' }).click();
    await expect(page).toHaveURL(/\/campaigns\/new/);

    // --- Assistant de création : page blanche, sans template ---
    await page.getByText('Partir d\'une page blanche, sans template').click();
    await page.getByLabel('Nom de la campagne').fill('Lancement gamme running E2E');
    await page.getByLabel('Description du produit').fill('Chaussures de running légères avec amorti réactif');
    await page.getByLabel('Objectif').fill('Générer 200 ventes en ligne en 30 jours');
    await page.getByRole('button', { name: 'Facebook', exact: true }).click();
    await page.getByRole('button', { name: 'Instagram', exact: true }).click();
    await page.getByRole('button', { name: 'Générer la campagne' }).click();

    // --- Redirection vers la fiche campagne, orchestration IA en cours ---
    await expect(page).toHaveURL(/\/campaigns\/[a-f0-9-]+$/);
    await expect(page.getByText('Lancement gamme running E2E')).toBeVisible();

    // --- Attente de la fin de la génération asynchrone (worker BullMQ + AI Gateway mock) ---
    // La page se rafraîchit elle-même toutes les 3s ; on attend que le bouton d'approbation
    // apparaisse, ce qui ne se produit qu'une fois READY_FOR_REVIEW atteint (modération +
    // cohérence de marque passées) — un vrai indicateur de bout en bout, pas un sleep arbitraire.
    const approveButton = page.getByRole('button', { name: 'Approuver' });
    await expect(approveButton).toBeVisible({ timeout: 45_000 });
    await expect(approveButton).toBeEnabled();

    // --- Garde-fous visibles avant approbation ---
    await expect(page.getByText('Générations IA')).toBeVisible();
    await expect(page.getByText('Validation avant publication')).toBeVisible();

    // --- Approbation (rôle OWNER, autorisé) ---
    await approveButton.click();
    await expect(page.getByRole('button', { name: 'Approuvée ✓' })).toBeVisible();

    // --- Le Content Studio doit être peuplé par l'orchestration ---
    await page.getByRole('button', { name: 'Contenu' }).click();
    await expect(page.getByText(/facebook|instagram/i).first()).toBeVisible();

    // --- Retour à la liste des campagnes : la campagne y apparaît ---
    await page.goto('/campaigns');
    await expect(page.getByText('Lancement gamme running E2E')).toBeVisible();
  });

  test('déconnexion puis reconnexion avec les mêmes identifiants', async ({ page }) => {
    const email = uniqueEmail('login');
    const password = 'motdepasse-solide-123';

    await register(page, email, password);

    // Quitte l'onboarding pour atteindre une page avec la nav (bouton Déconnexion)
    await page.getByRole('button', { name: 'Passer et aller au tableau de bord' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.getByRole('button', { name: 'Déconnexion' }).click();
    await expect(page).toHaveURL(/\/login/);

    // Une route protégée doit rediriger vers /login tant qu'on n'est pas reconnecté
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Mot de passe').fill(password);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText('Tableau de bord')).toBeVisible();
  });

  test('un mauvais mot de passe est refusé avec un message clair', async ({ page }) => {
    const email = uniqueEmail('badpass');
    const password = 'motdepasse-solide-123';
    await register(page, email, password);

    // register() laisse la session sur /onboarding (pas de Nav/bouton Déconnexion à cet
    // écran) — on vide directement le token plutôt que de chercher un bouton qui n'existe
    // pas ici, pour tester juste le refus de connexion, pas le mécanisme de déconnexion.
    await page.evaluate(() => localStorage.removeItem('accessToken'));
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByText(/identifiants invalides/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
