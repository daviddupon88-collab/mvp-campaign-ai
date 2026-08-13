'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api, ApiError } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, Field, ErrorText } from '@/components/ui';
import { UpgradeModal } from '@/components/upgrade-modal';

// Identifiants exacts attendus par AiOrchestratorService.buildChannelPrompt côté backend —
// chacun reçoit désormais un prompt de génération réellement adapté à son registre (texte
// court + hashtags pour Instagram, argumentation B2B pour LinkedIn, hook + script pour
// TikTok, titres/descriptions validés aux contraintes réelles pour Google Ads...), pas un
// texte générique dupliqué sur tous les canaux comme auparavant.
const AVAILABLE_CHANNELS = [
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'googleads', label: 'Google Ads' },
  { id: 'email', label: 'Email' },
];

export default function NewCampaignPage() {
  const ready = useRequireAuth();
  const router = useRouter();
  const t = useTranslations('campaigns.new');

  const [templates, setTemplates] = useState<any[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateChosen, setTemplateChosen] = useState(false); // distingue "aucun template" de "pas encore choisi"

  const [name, setName] = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [objective, setObjective] = useState('');
  const [budget, setBudget] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limitError, setLimitError] = useState<ApiError | null>(null);

  // "Une photo suffit" (page d'accueil) — l'upload se fait dès la sélection du fichier, pas
  // à la soumission du formulaire : l'utilisateur voit l'aperçu et sait immédiatement si
  // l'upload a échoué, avant d'avoir rempli le reste du formulaire. photoPreviewUrl est une
  // URL locale (object URL du fichier), distincte de photoAsset.url (l'URL réelle une fois
  // hébergée) — utilisée pour l'aperçu pendant l'upload, avant que ce dernier ne réponde.
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoAsset, setPhotoAsset] = useState<{ id: string; url: string } | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [ready]);

  if (!ready) return null;

  // Un template préremplit l'objectif (defaultObjective) et guide l'Orchestrator (toneHint,
  // structureHint côté backend) sans jamais figer le contenu généré — l'utilisateur garde
  // la main sur chaque champ avant de lancer la génération.
  function chooseTemplate(t: any | null) {
    setTemplateId(t?.id ?? null);
    setTemplateChosen(true);
    if (t?.defaultObjective) setObjective(t.defaultObjective);
    if (t?.defaultChannels?.length) setSelectedChannels(t.defaultChannels);
  }

  function toggleChannel(id: string) {
    setSelectedChannels((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError(null);
    setPhotoPreviewUrl(URL.createObjectURL(file));
    setUploadingPhoto(true);
    try {
      const asset = await api.uploadAsset(file);
      setPhotoAsset({ id: asset.id, url: asset.url });
    } catch (err: any) {
      setPhotoError(err.message ?? t('photoUploadError'));
      setPhotoPreviewUrl(null);
    } finally {
      setUploadingPhoto(false);
    }
  }

  function removePhoto() {
    setPhotoPreviewUrl(null);
    setPhotoAsset(null);
    setPhotoError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Miroir du contrôle serveur (CampaignsService.create) : au moins l'un des deux est
    // requis, jamais aucun — mais la vérification échoue vite ici, avant tout appel réseau.
    if (!productDescription.trim() && !photoAsset) {
      setError(t('missingPhotoOrDescription'));
      return;
    }

    setLoading(true);
    try {
      // La création empile immédiatement un job d'orchestration IA côté backend
      // (queue BullMQ) — l'utilisateur est redirigé sans attendre la génération.
      const campaign = await api.createCampaign({
        name,
        productDescription: productDescription.trim() || undefined,
        productImageAssetId: photoAsset?.id,
        objective,
        budget: budget ? Number(budget) : undefined,
        templateId: templateId ?? undefined,
        channels: selectedChannels.length > 0 ? selectedChannels : undefined,
      });
      router.push(`/campaigns/${campaign.id}`);
    } catch (err: any) {
      // Un plafond de plan atteint (essai ou payant) déclenche le moment de conversion
      // ciblé plutôt qu'un message d'erreur — cf. UpgradeModal.
      if (err instanceof ApiError && err.isPlanLimit) {
        setLimitError(err);
      } else {
        setError(err.message ?? t('genericError'));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Nav />
      <UpgradeModal error={limitError} onClose={() => setLimitError(null)} />
      <main style={{ maxWidth: 620, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 24 }}>{t('title')}</h1>

        {!templateChosen ? (
          <>
            <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginTop: 0, marginBottom: 16 }}>
              {t('templateIntro')}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 12 }}>
              {templates.map((tpl) => (
                <Card key={tpl.id} style={{ padding: 16, cursor: 'pointer' }}>
                  <button
                    type="button"
                    onClick={() => chooseTemplate(tpl)}
                    style={{ display: 'block', width: '100%', textAlign: 'start', background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
                  >
                    <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>{tpl.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{tpl.sector}</div>
                    {tpl.description && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{tpl.description}</div>}
                  </button>
                </Card>
              ))}
            </div>
            <button
              onClick={() => chooseTemplate(null)}
              style={{ fontSize: 13, background: 'none', border: 'none', color: 'var(--text-secondary)', textDecoration: 'underline', cursor: 'pointer' }}
            >
              {t('blankTemplate')}
            </button>
          </>
        ) : (
          <Card>
            <button
              type="button"
              onClick={() => setTemplateChosen(false)}
              style={{ fontSize: 12.5, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', marginBottom: 12, padding: 0 }}
            >
              {t('changeTemplate')}
            </button>
            <form onSubmit={handleSubmit}>
              <Field label={t('nameLabel')} value={name} onChange={setName} required />

              <label style={{ display: 'block', marginBottom: 16 }}>
                <span style={{ display: 'block', fontSize: 13, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  {t('photoLabel')}
                </span>
                {photoPreviewUrl ? (
                  <div style={{ border: '1px solid var(--border-strong)', borderRadius: 8, overflow: 'hidden' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- aperçu local avant upload, pas un asset optimisable par next/image */}
                    <img src={photoPreviewUrl} alt={t('photoPreviewAlt')} style={{ width: '100%', maxHeight: 220, objectFit: 'cover', display: 'block' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-raised)', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      <span>{uploadingPhoto ? t('photoUploading') : photoAsset ? t('photoUploaded') : ''}</span>
                      <button type="button" onClick={removePhoto} style={{ fontSize: 12, background: 'none', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', textDecoration: 'underline' }}>
                        {t('removePhoto')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ position: 'relative', border: '1.5px dashed var(--border-strong)', borderRadius: 8, padding: 28, textAlign: 'center', cursor: 'pointer' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>{t('photoDropzoneTitle')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('photoDropzoneHint')}</div>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handlePhotoChange}
                      style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                    />
                  </div>
                )}
                <ErrorText message={photoError} />
              </label>

              <Field
                label={t('descriptionLabel')}
                value={productDescription}
                onChange={setProductDescription}
                placeholder={t('descriptionPlaceholder')}
              />
              <Field
                label={t('objectiveLabel')}
                value={objective}
                onChange={setObjective}
                required
                placeholder={t('objectivePlaceholder')}
              />
              <Field label={t('budgetLabel')} type="number" value={budget} onChange={setBudget} />

              {/* <div>, pas <label> : ce groupe contient plusieurs boutons de bascule, pas un
                  champ de formulaire unique. Un <label> enveloppant plusieurs contrôles fait
                  fuiter tout son texte dans le nom accessible de CHAQUE bouton (calcul ARIA
                  du navigateur) — cassant à la fois les lecteurs d'écran et tout sélecteur par
                  rôle/nom (ex: tests). */}
              <div style={{ marginBottom: 16 }} role="group" aria-label={t('channelsGroupLabel')}>
                <span style={{ display: 'block', fontSize: 13, marginBottom: 8, color: 'var(--text-secondary)' }}>
                  {t('channelsLabel')}
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {AVAILABLE_CHANNELS.map((c) => {
                    const active = selectedChannels.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleChannel(c.id)}
                        style={{
                          padding: '7px 14px',
                          borderRadius: 20,
                          border: `1px solid ${active ? 'var(--accent-brand)' : 'var(--border-strong)'}`,
                          background: active ? 'var(--accent-brand)' : 'transparent',
                          color: active ? 'var(--bg-page)' : 'var(--text-primary)',
                          fontSize: 13,
                          cursor: 'pointer',
                        }}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
                {selectedChannels.length === 0 && (
                  <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
                    {t('noChannelSelected')}
                  </p>
                )}
              </div>

              <ErrorText message={error} />
              <Button type="submit" disabled={loading || uploadingPhoto}>
                {loading ? t('launching') : uploadingPhoto ? t('uploadingPhoto') : t('generate')}
              </Button>
            </form>
          </Card>
        )}
      </main>
    </>
  );
}
