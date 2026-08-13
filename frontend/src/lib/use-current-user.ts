'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export interface CurrentUser {
  id: string;
  email: string;
  isPlatformAdmin: boolean;
  preferredLanguage: string;
  role: string; // rôle dans l'organisation courante
  currentOrganizationId: string;
  organizations: Array<{ id: string; name: string; role: string }>;
}

// Un seul appel à /auth/me par montage d'écran plutôt que de décoder le JWT côté client
// (qui dupliquerait la logique de RolesGuard/PlatformAdminGuard) — cette info reste la
// source de vérité pour ce que l'INTERFACE affiche, le backend revalidant de toute façon
// chaque action sensible indépendamment (un rôle mal affiché ici ne donnerait jamais
// d'accès réel à une action non autorisée).
export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((data) =>
        setUser({
          id: data.user.id,
          email: data.user.email,
          isPlatformAdmin: data.user.isPlatformAdmin,
          preferredLanguage: data.user.preferredLanguage ?? 'en',
          role: data.role,
          currentOrganizationId: data.currentOrganizationId,
          organizations: data.organizations,
        }),
      )
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  return { user, loading };
}

// Miroir exact de canApprove() côté simulateur / RolesGuard côté backend — un Editor peut
// proposer une campagne mais jamais l'auto-valider.
export function canApprove(role: string | undefined): boolean {
  return role === 'MARKETING_MANAGER' || role === 'ADMIN' || role === 'OWNER';
}

export function canManageTeam(role: string | undefined): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}
