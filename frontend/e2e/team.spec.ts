import { test, expect, Page } from '@playwright/test';

// Parcours réel de gestion d'équipe (/settings/team), contre le vrai backend — pas de mocks.
// N'exerce pas l'acceptation d'invitation (page frontend actuellement absente, cf. README) :
// se limite à ce qui est réellement joignable depuis l'interface aujourd'hui, inviter/lister/
// renvoyer/annuler, chacun étant un vrai appel réseau vers TeamsService.

function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

async function registerAndReachDashboard(page: Page, email: string, password: string) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Test Playwright Team');
  await page.getByLabel('Organization name').fill('Organisation Playwright Team');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create my account' }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole('button', { name: 'Skip and go to dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('Gestion d\'équipe', () => {
  test('inviter un membre, le voir dans les invitations en attente, renvoyer puis annuler', async ({ page }) => {
    const ownerEmail = uniqueEmail('team-owner');
    const password = 'motdepasse-solide-123';
    const inviteeEmail = uniqueEmail('team-invitee');

    await registerAndReachDashboard(page, ownerEmail, password);

    await page.goto('/settings/team');
    // getByRole('heading', ...) plutôt que getByText : le lien de navigation vers cette
    // page porte lui aussi le libellé exact "Team" (cf. navigation.json), un getByText
    // simple matcherait les deux éléments (violation du mode strict de Playwright).
    await expect(page.getByRole('heading', { name: 'Team', exact: true })).toBeVisible();

    // --- L'OWNER (créateur de l'organisation) apparaît déjà dans les membres ---
    await expect(page.getByText(ownerEmail)).toBeVisible();

    // --- Invitation : formulaire dédié, rôle par défaut EDITOR ---
    await page.getByLabel('Email').fill(inviteeEmail);
    await page.getByRole('button', { name: 'Send invitation' }).click();

    // --- Apparaît dans les invitations en attente — preuve que TeamsService.invite() a
    //     réellement persisté l'invitation et que le frontend l'a récupérée en re-chargeant. ---
    await expect(page.getByText('Pending invitations')).toBeVisible();
    await expect(page.getByText(inviteeEmail)).toBeVisible();
    // Pas d'assertion sur le texte "EDITOR" seul : la même chaîne existe déjà comme option
    // du sélecteur de rôle du formulaire d'invitation, un getByText simple matcherait les
    // deux (violation du mode strict de Playwright) — l'email suffit à identifier la ligne.

    // --- Renvoyer ne doit pas produire d'erreur ni faire disparaître l'invitation ---
    await page.getByRole('button', { name: 'Resend' }).click();
    await expect(page.getByText(inviteeEmail)).toBeVisible();

    // --- Annuler retire l'invitation de la liste — preuve que TeamsService.revokeInvitation()
    //     a bien été appelé et que la liste re-chargée ne contient plus la ligne. ---
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(inviteeEmail)).not.toBeVisible();
  });
});
