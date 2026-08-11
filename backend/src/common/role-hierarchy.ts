// Hiérarchie RBAC unique, utilisée à la fois par RolesGuard (contrôle d'accès aux endpoints)
// et TeamsService (règles métier : un ADMIN ne peut pas promouvoir quelqu'un au-dessus de
// son propre niveau, ni toucher au rôle d'un OWNER). Une seule source de vérité pour éviter
// que les deux dérivent silencieusement l'une de l'autre.
export const ROLE_HIERARCHY = ['VIEWER', 'EDITOR', 'MARKETING_MANAGER', 'ADMIN', 'OWNER'] as const;
export type RoleName = (typeof ROLE_HIERARCHY)[number];

export function roleLevel(role: string): number {
  return ROLE_HIERARCHY.indexOf(role as RoleName);
}

export function isAtLeast(role: string, minimum: string): boolean {
  return roleLevel(role) >= roleLevel(minimum);
}
