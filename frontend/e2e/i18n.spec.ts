import { test, expect, Page } from '@playwright/test';

// Scénario de la mission : détection English par défaut → changement de langue depuis
// Settings → RTL arabe → persistance au reload → persistance au niveau du compte (survit à
// une déconnexion/reconnexion, y compris quand le cookie local a été effacé et que le
// navigateur reste en anglais — la préférence du compte doit l'emporter, cf. i18n/get-locale.ts).

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

async function registerAndReachDashboard(page: Page, email: string, password: string) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Test Playwright i18n');
  await page.getByLabel('Organization name').fill('Organisation Playwright i18n');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole('button', { name: 'Skip and go to dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('Internationalisation', () => {
  test('English par défaut, changement de langue, RTL arabe, persistance reload + compte', async ({ page, context }) => {
    const email = uniqueEmail('i18n');
    const password = 'motdepasse-solide-123';

    await registerAndReachDashboard(page, email, password);

    // --- 1. English détecté par défaut (Accept-Language en-US du navigateur Playwright) ---
    await expect(page.getByText('Dashboard', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Campaigns' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    const languageSelect = page.getByLabel('Language / Sprache / Langue / اللغة');

    // --- 2. Deutsch depuis le header ---
    await languageSelect.selectOption('de');
    await expect(page.getByRole('link', { name: 'Kampagnen' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');

    // --- 3. Français ---
    await languageSelect.selectOption('fr');
    await expect(page.getByRole('link', { name: 'Campagnes' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

    // --- 4. العربية — RTL réel, pas juste un changement de texte ---
    await languageSelect.selectOption('ar');
    await expect(page.getByRole('link', { name: 'الحملات' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // --- 5. Persistance au rechargement (cookie) ---
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('link', { name: 'الحملات' })).toBeVisible();

    // --- 6. Persistance au niveau du compte : déconnexion, cookie local effacé (simule un
    //     nouvel appareil), reconnexion — le navigateur reste en-US, donc si l'arabe est
    //     toujours affiché ensuite, c'est bien la préférence du COMPTE qui a gagné. ---
    await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
    await expect(page).toHaveURL(/\/login/);

    await context.clearCookies();
    // clearCookies() n'affecte pas le HTML déjà rendu (page /login servie avec le cookie
    // NEXT_LOCALE=ar avant l'effacement) — un reload est nécessaire pour qu'une nouvelle
    // requête, sans cookie, retombe sur l'Accept-Language du navigateur (en-US → anglais).
    await page.reload();

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('link', { name: 'الحملات' })).toBeVisible();

    // --- 7. Retour à English ---
    await page.getByLabel('Language / Sprache / Langue / اللغة').selectOption('en');
    await expect(page.getByRole('link', { name: 'Campaigns' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });
});
