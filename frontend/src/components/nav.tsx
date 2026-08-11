'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { logout } from '@/lib/use-require-auth';
import { useCurrentUser } from '@/lib/use-current-user';

const LINK_STYLE_BASE = { fontSize: 14, textDecoration: 'none' as const };

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link href={href} style={{ ...LINK_STYLE_BASE, color: active ? '#1a1a18' : '#5f5e5a', fontWeight: active ? 600 : 400 }}>
      {label}
    </Link>
  );
}

export function Nav() {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useCurrentUser();

  return (
    <nav
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '16px 24px',
        borderBottom: '1px solid #e5e3dd',
        background: '#fff',
        flexWrap: 'wrap',
        gap: 12,
      }}
    >
      <Link href="/dashboard" style={{ fontWeight: 500, textDecoration: 'none', color: '#1a1a18' }}>
        Campaign-ai
      </Link>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <NavLink href="/campaigns" label="Campagnes" active={pathname?.startsWith('/campaigns') ?? false} />
        <NavLink href="/calendar" label="Calendrier" active={pathname === '/calendar'} />
        <NavLink href="/settings/brand" label="Brand Brain" active={pathname === '/settings/brand'} />
        <NavLink href="/settings/team" label="Équipe" active={pathname === '/settings/team'} />
        <NavLink href="/settings/billing" label="Facturation" active={pathname === '/settings/billing'} />
        <NavLink href="/support" label="Support" active={pathname?.startsWith('/support') ?? false} />
        <NavLink href="/help" label="Aide" active={pathname?.startsWith('/help') ?? false} />
        {/* Réservé aux comptes isPlatformAdmin — jamais affiché sinon, même si l'utilisateur
            est OWNER de sa propre organisation (accès transverse distinct du RBAC par tenant). */}
        {user?.isPlatformAdmin && (
          <NavLink href="/admin" label="Administration" active={pathname?.startsWith('/admin') ?? false} />
        )}
        <button
          onClick={() => logout(router)}
          style={{ fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: '#5f5e5a' }}
        >
          Déconnexion
        </button>
      </div>
    </nav>
  );
}
