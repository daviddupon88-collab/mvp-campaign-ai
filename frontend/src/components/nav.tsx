'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { logout } from '@/lib/use-require-auth';
import { useCurrentUser } from '@/lib/use-current-user';
import { LanguageSwitcher } from '@/components/language-switcher';

const LINK_STYLE_BASE = { fontSize: 14, textDecoration: 'none' as const };

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link href={href} style={{ ...LINK_STYLE_BASE, color: active ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: active ? 600 : 400 }}>
      {label}
    </Link>
  );
}

export function Nav() {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useCurrentUser();
  const t = useTranslations('navigation');

  return (
    <nav
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '16px 24px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-panel)',
        flexWrap: 'wrap',
        gap: 12,
      }}
    >
      <Link href="/dashboard" style={{ fontFamily: 'var(--font-space-grotesk)', fontWeight: 600, textDecoration: 'none', color: 'var(--text-primary)' }}>
        Campaign-ai
      </Link>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <NavLink href="/campaigns" label={t('campaigns')} active={pathname?.startsWith('/campaigns') ?? false} />
        <NavLink href="/calendar" label={t('calendar')} active={pathname === '/calendar'} />
        <NavLink href="/settings/brand" label={t('brandBrain')} active={pathname === '/settings/brand'} />
        <NavLink href="/settings/team" label={t('team')} active={pathname === '/settings/team'} />
        <NavLink href="/settings/billing" label={t('billing')} active={pathname === '/settings/billing'} />
        <NavLink href="/support" label={t('support')} active={pathname?.startsWith('/support') ?? false} />
        <NavLink href="/help" label={t('help')} active={pathname?.startsWith('/help') ?? false} />
        {/* Réservé aux comptes isPlatformAdmin — jamais affiché sinon, même si l'utilisateur
            est OWNER de sa propre organisation (accès transverse distinct du RBAC par tenant). */}
        {user?.isPlatformAdmin && (
          <NavLink href="/admin" label={t('admin')} active={pathname?.startsWith('/admin') ?? false} />
        )}
        <NavLink href="/settings/account" label={t('account')} active={pathname === '/settings/account'} />
        <LanguageSwitcher accountLanguage={user?.preferredLanguage} />
        <button
          onClick={() => logout(router)}
          style={{ fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
        >
          {t('logout')}
        </button>
      </div>
    </nav>
  );
}
