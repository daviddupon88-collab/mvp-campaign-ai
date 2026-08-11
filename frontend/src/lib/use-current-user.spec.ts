import { canApprove, canManageTeam } from './use-current-user';

// Miroir de la hiérarchie RBAC vérifiée côté backend (RolesGuard, role-hierarchy.ts) —
// ce test protège contre une désynchronisation qui laisserait le frontend afficher un
// bouton "Approuver"/"Gérer l'équipe" à un rôle qui se le verrait de toute façon refuser
// par le backend (pas un trou de sécurité en soi, RolesGuard reste la source de vérité,
// mais une UX trompeuse — cf. commentaire de use-current-user.ts).
describe('canApprove', () => {
  it.each(['MARKETING_MANAGER', 'ADMIN', 'OWNER'])('autorise le rôle %s', (role) => {
    expect(canApprove(role)).toBe(true);
  });

  it.each(['EDITOR', 'VIEWER', undefined, '', 'ROLE_INCONNU'])('refuse le rôle %s', (role) => {
    expect(canApprove(role)).toBe(false);
  });
});

describe('canManageTeam', () => {
  it.each(['ADMIN', 'OWNER'])('autorise le rôle %s', (role) => {
    expect(canManageTeam(role)).toBe(true);
  });

  it.each(['MARKETING_MANAGER', 'EDITOR', 'VIEWER', undefined])('refuse le rôle %s', (role) => {
    expect(canManageTeam(role)).toBe(false);
  });
});
