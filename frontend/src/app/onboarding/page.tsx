'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('auth.onboarding');
  const tCommon = useTranslations('common');

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
      setError(err.message ?? t('saveError'));
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
      setError(err.message ?? t('inviteError'));
    } finally {
      setInvitingMember(false);
    }
  }

  const allDone = brandDone && campaignDone;

  return (
    <main style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>{t('welcome')}</h1>
      <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 28 }}>
        {t('subtitle')}
      </p>

      {/* Étape 1 — Brand Kit */}
      <Card style={{ marginBottom: 16, opacity: brandDone ? 0.7 : 1 }}>
        <StepHeader done={brandDone} title={t('step1Title')} />
        {!brandDone && (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
              {t('step1Body')}
            </p>
            <Field label={t('toneLabel')} value={tone} onChange={setTone} placeholder={t('tonePlaceholder')} />
            <Button onClick={saveBrandKit} disabled={savingBrand || !tone.trim()}>
              {savingBrand ? tCommon('status.saving') : tCommon('actions.save')}
            </Button>
          </>
        )}
        {brandDone && <p style={{ fontSize: 13, color: 'var(--accent-done)', margin: 0 }}>✓ {t('brandKitDone')}</p>}
      </Card>

      {/* Étape 2 — Inviter l'équipe (optionnel) */}
      <Card style={{ marginBottom: 16, opacity: teamInvited ? 0.7 : 1 }}>
        <StepHeader done={teamInvited} title={t('step2Title')} />
        {!teamInvited && (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
              {t('step2Body')}
            </p>
            <Field label={t('colleagueEmail')} type="email" value={inviteEmail} onChange={setInviteEmail} placeholder="colleague@company.com" />
            <div style={{ display: 'flex', gap: 10 }}>
              <Button onClick={sendInvite} disabled={invitingMember || !inviteEmail.trim()}>
                {invitingMember ? t('inviting') : t('invite')}
              </Button>
              <Button variant="secondary" onClick={() => setTeamInvited(true)}>{t('skipStep')}</Button>
            </div>
          </>
        )}
        {teamInvited && <p style={{ fontSize: 13, color: 'var(--accent-done)', margin: 0 }}>✓ {t('stepDone')}</p>}
      </Card>

      {/* Étape 3 — Première campagne */}
      <Card style={{ marginBottom: 24, opacity: campaignDone ? 0.7 : 1 }}>
        <StepHeader done={campaignDone} title={t('step3Title')} />
        {!campaignDone && (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 16 }}>
              {t('step3Body')}
            </p>
            <Button onClick={() => router.push('/campaigns/new')}>{t('createCampaign')}</Button>
          </>
        )}
        {campaignDone && <p style={{ fontSize: 13, color: 'var(--accent-done)', margin: 0 }}>✓ {t('firstCampaignDone')}</p>}
      </Card>

      {error && <p style={{ color: 'var(--accent-danger)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          onClick={() => router.push('/dashboard')}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer' }}
        >
          {t('skipToDashboard')}
        </button>
        {allDone && <Button onClick={() => router.push('/dashboard')}>{t('goToDashboard')}</Button>}
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
