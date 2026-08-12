'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Card, Button, Field } from '@/components/ui';
import { useRequireAuth } from '@/lib/use-require-auth';

// Checklist d'onboarding : chaque étape reflète un état RÉEL côté backend (Brand Kit
// renseigné, membre invité, première campagne créée) — jamais une simple case cochée
// stockée à part, qui pourrait mentir sur ce qui a vraiment été fait. Toutes les étapes
// sont explicitement contournables ("Passer cette étape") : l'onboarding guide, il ne
// bloque jamais l'accès au produit.
export default function OnboardingPage() {
  const ready = useRequireAuth();
  const router = useRouter();

  const [brandDone, setBrandDone] = useState(false);
  const [campaignDone, setCampaignDone] = useState(false);
  const [teamInvited, setTeamInvited] = useState(false);
  const [loading, setLoading] = useState(true);

  const [tone, setTone] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [savingBrand, setSavingBrand] = useState(false);
  const [invitingMember, setInvitingMember] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    Promise.all([
      api.getBrandKit().catch(() => null),
      api.listCampaigns().catch(() => []),
    ]).then(([brandKit, campaigns]) => {
      setBrandDone(!!brandKit?.toneOfVoice);
      setCampaignDone(campaigns.length > 0);
      setLoading(false);
    });
  }, [ready]);

  if (!ready || loading) return null;

  async function saveBrandKit() {
    if (!tone.trim()) return;
    setSavingBrand(true);
    setError(null);
    try {
      await api.upsertBrandKit({ toneOfVoice: tone });
      setBrandDone(true);
    } catch (err: any) {
      setError(err.message ?? 'Échec de l\'enregistrement');
    } finally {
      setSavingBrand(false);
    }
  }

  async function sendInvite() {
    if (!inviteEmail.trim()) return;
    setInvitingMember(true);
    setError(null);
    try {
      await api.inviteTeamMember({ email: inviteEmail, role: 'EDITOR' });
      setTeamInvited(true);
    } catch (err: any) {
      setError(err.message ?? 'Échec de l\'invitation');
    } finally {
      setInvitingMember(false);
    }
  }

  const allDone = brandDone && campaignDone;

  return (
    <main style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Bienvenue sur Campaign-ai</h1>
      <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 28 }}>
        Trois étapes pour tirer le meilleur parti de votre essai gratuit de 14 jours.
      </p>

      {/* Étape 1 — Brand Kit */}
      <Card style={{ marginBottom: 16, opacity: brandDone ? 0.7 : 1 }}>
        <StepHeader done={brandDone} title="Décrivez le ton de votre marque" />
        {!brandDone && (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
              Utilisé pour garder chaque génération cohérente avec votre identité.
            </p>
            <Field label="Ton éditorial" value={tone} onChange={setTone} placeholder="Ex: Chaleureux et direct, orienté résultats" />
            <Button onClick={saveBrandKit} disabled={savingBrand || !tone.trim()}>
              {savingBrand ? 'Enregistrement...' : 'Enregistrer'}
            </Button>
          </>
        )}
        {brandDone && <p style={{ fontSize: 13, color: 'var(--accent-done)', margin: 0 }}>✓ Brand Kit renseigné</p>}
      </Card>

      {/* Étape 2 — Inviter l'équipe (optionnel) */}
      <Card style={{ marginBottom: 16, opacity: teamInvited ? 0.7 : 1 }}>
        <StepHeader done={teamInvited} title="Invitez un collègue (optionnel)" />
        {!teamInvited && (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
              Un Marketing Manager devra approuver vos campagnes avant publication.
            </p>
            <Field label="Email du collègue" type="email" value={inviteEmail} onChange={setInviteEmail} placeholder="collegue@entreprise.com" />
            <div style={{ display: 'flex', gap: 10 }}>
              <Button onClick={sendInvite} disabled={invitingMember || !inviteEmail.trim()}>
                {invitingMember ? 'Envoi...' : 'Inviter'}
              </Button>
              <Button variant="secondary" onClick={() => setTeamInvited(true)}>Passer cette étape</Button>
            </div>
          </>
        )}
        {teamInvited && <p style={{ fontSize: 13, color: 'var(--accent-done)', margin: 0 }}>✓ Étape terminée</p>}
      </Card>

      {/* Étape 3 — Première campagne */}
      <Card style={{ marginBottom: 24, opacity: campaignDone ? 0.7 : 1 }}>
        <StepHeader done={campaignDone} title="Créez votre première campagne" />
        {!campaignDone && (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 16 }}>
              Une photo produit suffit pour lancer l'orchestration IA complète.
            </p>
            <Button onClick={() => router.push('/campaigns/new')}>Créer une campagne</Button>
          </>
        )}
        {campaignDone && <p style={{ fontSize: 13, color: 'var(--accent-done)', margin: 0 }}>✓ Première campagne créée</p>}
      </Card>

      {error && <p style={{ color: 'var(--accent-danger)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          onClick={() => router.push('/dashboard')}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer' }}
        >
          Passer et aller au tableau de bord
        </button>
        {allDone && <Button onClick={() => router.push('/dashboard')}>Accéder au tableau de bord</Button>}
      </div>
    </main>
  );
}

function StepHeader({ done, title }: { done: boolean; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
      <span
        style={{
          width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
          background: done ? 'var(--accent-done)' : 'var(--border)', color: done ? 'var(--bg-page)' : 'var(--text-muted)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
        }}
      >
        {done ? '✓' : ''}
      </span>
      <h3 style={{ fontSize: 15, margin: 0 }}>{title}</h3>
    </div>
  );
}
