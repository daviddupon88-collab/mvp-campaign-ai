'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card, Button, Field, ErrorText } from '@/components/ui';

export default function RegisterPage() {
  const router = useRouter();
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
      setError(err.message ?? "Échec de l'inscription");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 400, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Créer votre compte Campaign-ai</h1>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>14 jours d'essai gratuit — aucune carte bancaire requise.</p>
      <Card>
        <form onSubmit={handleSubmit}>
          <Field label="Nom complet" value={fullName} onChange={setFullName} required />
          <Field label="Nom de l'organisation" value={organizationName} onChange={setOrganizationName} required />
          <Field label="Email" type="email" value={email} onChange={setEmail} required />
          <Field label="Mot de passe" type="password" value={password} onChange={setPassword} required />
          <ErrorText message={error} />
          <Button type="submit" disabled={loading}>
            {loading ? 'Création...' : 'Créer mon compte'}
          </Button>
        </form>
      </Card>
      <p style={{ marginTop: 16, fontSize: 14, color: 'var(--text-secondary)' }}>
        Déjà un compte ? <Link href="/login">Se connecter</Link>
      </p>
    </main>
  );
}
