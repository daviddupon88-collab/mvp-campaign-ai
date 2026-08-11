'use client';

import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, Field, Textarea, ErrorText } from '@/components/ui';

// Contrairement à BrandKit (les champs édités ci-dessous, statiques), la mémoire listée
// en bas de page (BrandMemoryEntry) s'enrichit automatiquement — publication réussie,
// recommandation Optimizer notable — jamais éditée manuellement. C'est cette mémoire,
// injectée dans chaque prompt de génération (cf. BrandService.buildPromptContext côté
// backend), qui distingue un Brand Kit classique d'un vrai "Brand Brain".
export default function BrandBrainPage() {
  const ready = useRequireAuth();
  const [kit, setKit] = useState<any>(null);
  const [memory, setMemory] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [toneOfVoice, setToneOfVoice] = useState('');
  const [mission, setMission] = useState('');
  const [vision, setVision] = useState('');
  const [valuePropsText, setValuePropsText] = useState('');
  const [slogansText, setSlogansText] = useState('');
  const [competitorsText, setCompetitorsText] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [uploadingLogo, setUploadingLogo] = useState(false);

  useEffect(() => {
    if (!ready) return;
    api.getBrandKit().then((data) => {
      if (!data) return;
      setKit(data);
      setToneOfVoice(data.toneOfVoice ?? '');
      setMission(data.mission ?? '');
      setVision(data.vision ?? '');
      setLogoUrl(data.logoUrl ?? '');
      setValuePropsText((data.valueProps ?? []).join('\n'));
      setSlogansText((data.slogans ?? []).join('\n'));
      setCompetitorsText((data.competitors ?? []).map((c: any) => c.name).join('\n'));
    }).catch(() => {});
    api.getBrandMemory(10).then(setMemory).catch(() => setMemory([]));
  }, [ready]);

  if (!ready) return null;

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true); setError(null);
    try {
      // Upload réel vers l'object storage (S3/R2/GCS ou disque local en dev selon
      // STORAGE_PROVIDER côté backend) — auparavant, il n'existait aucun moyen d'héberger
      // un fichier depuis l'interface, seulement d'enregistrer une URL déjà hébergée ailleurs.
      const asset = await api.uploadAsset(file, 'Logo de marque');
      setLogoUrl(asset.url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploadingLogo(false);
    }
  }

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const updated = await api.upsertBrandKit({
        toneOfVoice: toneOfVoice || undefined,
        mission: mission || undefined,
        vision: vision || undefined,
        logoUrl: logoUrl || undefined,
        valueProps: valuePropsText.split('\n').map((s) => s.trim()).filter(Boolean),
        slogans: slogansText.split('\n').map((s) => s.trim()).filter(Boolean),
        competitors: competitorsText.split('\n').map((s) => s.trim()).filter(Boolean).map((name) => ({ name })),
      });
      setKit(updated);
      setSaved(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 640, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Brand Brain</h1>
        <p style={{ fontSize: 13.5, color: '#5f5e5a', marginBottom: 24 }}>
          Chaque génération IA (analyse, stratégie, copywriting) s'appuie sur cette identité —
          plus elle est complète, plus les résultats sont cohérents avec votre marque.
        </p>

        <ErrorText message={error} />

        <Card style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Identité déclarée</h2>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <div style={{ width: 64, height: 64, borderRadius: 10, background: '#f7f7f5', border: '1px solid #e5e3dd', backgroundImage: logoUrl ? `url(${logoUrl})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 }} />
            <div>
              <label style={{ display: 'inline-block', fontSize: 13, padding: '8px 14px', borderRadius: 8, border: '1px solid #d8d6cf', cursor: 'pointer' }}>
                {uploadingLogo ? 'Envoi...' : 'Téléverser un logo'}
                <input type="file" accept="image/*" onChange={handleLogoUpload} disabled={uploadingLogo} style={{ display: 'none' }} />
              </label>
              <p style={{ fontSize: 11.5, color: '#9a9992', margin: '6px 0 0' }}>PNG, JPG ou SVG — stocké de façon permanente.</p>
            </div>
          </div>

          <Field label="Ton éditorial" value={toneOfVoice} onChange={setToneOfVoice} placeholder="Ex: Direct, transparent, orienté résultats" />
          <Field label="Mission" value={mission} onChange={setMission} placeholder="Pourquoi votre entreprise existe" />
          <Field label="Vision" value={vision} onChange={setVision} placeholder="Où vous voulez emmener votre marché" />
          <Textarea label="Arguments clés (un par ligne)" value={valuePropsText} onChange={setValuePropsText} rows={3} />
          <Textarea label="Slogans existants (un par ligne)" value={slogansText} onChange={setSlogansText} rows={2} />
          <Textarea label="Concurrents connus (un nom par ligne)" value={competitorsText} onChange={setCompetitorsText} rows={2} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button onClick={save} disabled={saving}>{saving ? 'Enregistrement...' : 'Enregistrer'}</Button>
            {saved && <span style={{ fontSize: 12.5, color: '#4a9d7f' }}>✓ Enregistré</span>}
          </div>
        </Card>

        <Card>
          <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Mémoire de marque</h2>
          <p style={{ fontSize: 12.5, color: '#9a9992', marginTop: -8, marginBottom: 14 }}>
            S'enrichit automatiquement à chaque publication et recommandation notable — jamais éditée manuellement.
          </p>
          {memory.length === 0 ? (
            <p style={{ fontSize: 13.5, color: '#5f5e5a' }}>
              Aucun apprentissage pour le moment — la mémoire se remplit après votre première campagne publiée.
            </p>
          ) : (
            memory.map((m) => (
              <div key={m.id} style={{ padding: '10px 0', borderTop: '1px solid #eee' }}>
                <div style={{ fontSize: 11, color: '#9a9992', marginBottom: 3 }}>
                  {m.type === 'CAMPAIGN_LEARNING' ? 'Campagne publiée' : m.type === 'PERFORMANCE_INSIGHT' ? 'Performance' : m.type} · {new Date(m.createdAt).toLocaleDateString('fr-FR')}
                </div>
                <div style={{ fontSize: 13 }}>{m.content}</div>
              </div>
            ))
          )}
        </Card>
      </main>
    </>
  );
}
