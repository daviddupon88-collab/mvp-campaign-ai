'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, Button, Field, ErrorText } from '@/components/ui';
import { LanguageSwitcher } from '@/components/language-switcher';

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations('auth.login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { accessToken } = await api.login({ email, password });
      localStorage.setItem('accessToken', accessToken);
      router.push('/dashboard');
    } catch {
      // Le backend renvoie un message d'erreur non traduit (logique d'authentification hors
      // périmètre de cette internationalisation) — on affiche systématiquement le message
      // traduit plutôt que de laisser fuiter du texte brut dans une UI en une autre langue.
      setError(t('genericError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <LanguageSwitcher />
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 24 }}>{t('title')}</h1>
      <Card>
        <form onSubmit={handleSubmit}>
          <Field label={t('email')} type="email" value={email} onChange={setEmail} required />
          <Field label={t('password')} type="password" value={password} onChange={setPassword} required />
          <ErrorText message={error} />
          <Button type="submit" disabled={loading}>
            {loading ? t('submitting') : t('submit')}
          </Button>
        </form>
      </Card>
      <p style={{ marginTop: 16, fontSize: 14, color: 'var(--text-secondary)' }}>
        {t('noAccount')} <Link href="/register">{t('createAccount')}</Link>
      </p>
    </main>
  );
}
