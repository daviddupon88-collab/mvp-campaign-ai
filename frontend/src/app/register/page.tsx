'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, Button, Field, ErrorText } from '@/components/ui';
import { LanguageSwitcher } from '@/components/language-switcher';

export default function RegisterPage() {
  const router = useRouter();
  const t = useTranslations('auth.register');
  const [fullName, setFullName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Cet appel crée à la fois l'utilisateur ET son organisation (tenant), avec un essai
      // gratuit de 14 jours au niveau Growth démarré automatiquement (cf. AuthService.register
      // côté backend) — pas de carte bancaire requise à ce stade.
      const { accessToken } = await api.register({ email, password, fullName, organizationName });
      localStorage.setItem('accessToken', accessToken);
      router.push('/onboarding');
    } catch (err: any) {
      // Le backend renvoie des messages non traduits (logique d'authentification hors
      // périmètre de cette internationalisation) — seul le code HTTP (structurel, stable)
      // est utilisé pour choisir un message traduit, jamais le texte brut du backend.
      setError(err.statusCode === 409 ? t('emailExists') : t('genericError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <LanguageSwitcher />
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>{t('title')}</h1>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>{t('subtitle')}</p>
      <Card>
        <form onSubmit={handleSubmit}>
          <Field label={t('fullName')} value={fullName} onChange={setFullName} required />
          <Field label={t('organizationName')} value={organizationName} onChange={setOrganizationName} required />
          <Field label={t('email')} type="email" value={email} onChange={setEmail} required />
          <Field label={t('password')} type="password" value={password} onChange={setPassword} required />
          <ErrorText message={error} />
          <Button type="submit" disabled={loading}>
            {loading ? t('submitting') : t('submit')}
          </Button>
        </form>
      </Card>
      <p style={{ marginTop: 16, fontSize: 14, color: 'var(--text-secondary)' }}>
        {t('hasAccount')} <Link href="/login">{t('signIn')}</Link>
      </p>
    </main>
  );
}
