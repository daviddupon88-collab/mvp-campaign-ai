'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/lib/use-require-auth';
import { useCurrentUser, canApprove } from '@/lib/use-current-user';
import { api, ApiError } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, Textarea, StatusPill, ScoreBar, Tabs, ErrorText } from '@/components/ui';
import { UpgradeModal } from '@/components/upgrade-modal';

const GENERATION_STATUS_LABELS: Record<string, string> = {
  PENDING: 'En attente', RUNNING: 'En cours', SUCCEEDED: 'Terminé', FAILED: 'Échec',
};

export default function CampaignDetailPage() {
  const ready = useRequireAuth();
  const { user } = useCurrentUser();
  const params = useParams();
  const campaignId = params.id as string;

  const [campaign, setCampaign] = useState<any>(null);
  const [tab, setTab] = useState('Vue d\'ensemble');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await api.getCampaign(campaignId);
    setCampaign(data);
    return data;
  }, [campaignId]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    // Polling tant que la génération tourne en tâche de fond (worker BullMQ) — une fois
    // READY_FOR_REVIEW/REJECTED atteint, plus besoin de rafraîchir automatiquement.
    async function poll() {
      const data = await load();
      if (!cancelled && (data.status === 'DRAFT' || data.status === 'IN_PROGRESS')) {
        setTimeout(poll, 3000);
      }
    }
    poll();
    return () => { cancelled = true; };
  }, [ready, load]);

  if (!ready || !campaign) return null;

  async function handleApprove() {
    setBusy(true); setError(null);
    try { await api.approveCampaign(campaignId); await load(); }
    catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function handleReject() {
    const reason = prompt('Motif du rejet (5 caractères minimum) :');
    if (!reason) return;
    setBusy(true); setError(null);
    try { await api.rejectCampaign(campaignId, reason); await load(); }
    catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  }

  const isGenerating = campaign.status === 'DRAFT' || campaign.status === 'IN_PROGRESS';
  const canReview = campaign.status === 'READY_FOR_REVIEW' || campaign.status === 'APPROVED';

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 820, margin: '40px auto', padding: '0 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, gap: 16 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            {campaign.productImageUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- photo produit hébergée par l'utilisateur/le stockage, pas un asset buildé
              <img
                src={campaign.productImageUrl}
                alt="Photo du produit"
                style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover', border: '1px solid var(--border)', flexShrink: 0 }}
              />
            )}
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>{campaign.name}</h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 4 }}>{campaign.objective}</p>
            </div>
          </div>
          <StatusPill status={campaign.status} />
        </div>

        {isGenerating && (
          <Card style={{ marginBottom: 20 }}>
            <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: 0 }}>
              L'orchestration IA est en cours (analyse → stratégie → copywriting → visuel)...
              Cette page se rafraîchit automatiquement.
            </p>
          </Card>
        )}

        <ErrorText message={error} />

        <Tabs
          tabs={['Vue d\'ensemble', 'Contenu', 'Analytics', 'Optimisation']}
          active={tab}
          onChange={setTab}
        />

        {tab === 'Vue d\'ensemble' && (
          <OverviewTab
            campaign={campaign}
            canReview={canReview}
            canApproveRole={canApprove(user?.role)}
            busy={busy}
            onApprove={handleApprove}
            onReject={handleReject}
            onPublished={load}
          />
        )}
        {tab === 'Contenu' && <ContentStudioTab campaignId={campaignId} />}
        {tab === 'Analytics' && <AnalyticsTab campaignId={campaignId} campaign={campaign} />}
        {tab === 'Optimisation' && (
          <OptimizerTab campaignId={campaignId} campaign={campaign} canApproveRole={canApprove(user?.role)} onChange={load} />
        )}
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Onglet Vue d'ensemble : générations IA, garde-fou modération + score de marque,
// approbation/rejet, publication.
// ---------------------------------------------------------------------------
function OverviewTab({ campaign, canReview, canApproveRole, busy, onApprove, onReject, onPublished }: any) {
  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Générations IA</h2>
        {(!campaign.generations || campaign.generations.length === 0) && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Aucune génération pour le moment.</p>
        )}
        {campaign.generations?.map((g: any) => (
          <div key={g.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <strong>{g.taskType}</strong>
            <span style={{ color: 'var(--text-secondary)' }}>{GENERATION_STATUS_LABELS[g.status] ?? g.status} · {g.provider}</span>
          </div>
        ))}
      </Card>

      {/* Garde-fou avant publication — miroir exact de PublishingService côté backend :
          jamais de publication sans passer par ce bloc (modération + cohérence de marque). */}
      {canReview && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h2 style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>Validation avant publication</h2>
            {campaign.moderationVerdict && <StatusPill status={campaign.moderationVerdict} />}
          </div>

          {campaign.moderationChecks?.map((m: any) => (
            <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
              <span style={{ width: 160, flexShrink: 0 }}>{m.checkType}</span>
              <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{m.summary}</span>
              <StatusPill status={m.status} />
            </div>
          ))}

          {campaign.brandConsistencyScore != null && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Cohérence de marque : <strong style={{ color: 'var(--text-primary)' }}>{campaign.brandConsistencyScore}/100</strong>
              </div>
              {campaign.brandConsistencyChecks?.map((b: any) => (
                <ScoreBar key={b.id} label={b.label} value={b.score} />
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <Button onClick={onApprove} disabled={busy || campaign.status === 'APPROVED' || !canApproveRole}>
              {campaign.status === 'APPROVED' ? 'Approuvée ✓' : 'Approuver'}
            </Button>
            <Button variant="secondary" onClick={onReject} disabled={busy || campaign.status === 'APPROVED' || !canApproveRole}>
              Rejeter
            </Button>
          </div>
          {!canApproveRole && (
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
              Réservé au rôle Marketing Manager et au-dessus.
            </p>
          )}
        </Card>
      )}

      {campaign.status === 'REJECTED' && (
        <Card style={{ marginBottom: 16, borderColor: 'var(--accent-danger)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-danger)', marginBottom: 4 }}>Campagne rejetée</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{campaign.rejectionReason}</div>
        </Card>
      )}

      {campaign.status === 'APPROVED' && (
        <PublishBlock campaignId={campaign.id} onPublished={onPublished} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Publication — verrouillée par le statut APPROVED côté backend (PublishingService),
// et idempotente : republier ne crée jamais de doublon sur la plateforme réelle.
// ---------------------------------------------------------------------------
function PublishBlock({ campaignId, onPublished }: { campaignId: string; onPublished: () => void }) {
  const [connections, setConnections] = useState<any[]>([]);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<ApiError | null>(null);

  useEffect(() => {
    api.listSocialConnections().then(setConnections).catch(() => setConnections([]));
  }, []);

  async function publish(connectionId: string) {
    setPublishing(connectionId);
    setError(null);
    try {
      await api.publishCampaign(campaignId, [{ socialConnectionId: connectionId }]);
      onPublished();
    } catch (err: any) {
      // Plafond de publications ou de canal non autorisé (essai) : moment de conversion
      // ciblé plutôt qu'un message d'erreur générique, même logique que /campaigns/new.
      if (err instanceof ApiError && err.isPlanLimit) setLimitError(err);
      else setError(err.message);
    } finally {
      setPublishing(null);
    }
  }

  return (
    <Card>
      <UpgradeModal error={limitError} onClose={() => setLimitError(null)} />
      <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Publication</h2>
      <ErrorText message={error} />
      {connections.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
          Aucun réseau social connecté pour le moment.
        </p>
      ) : (
        connections.map((c) => (
          <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: 13.5 }}>{c.platform} — {c.externalAccountName}</span>
            <Button onClick={() => publish(c.id)} disabled={publishing === c.id}>
              {publishing === c.id ? 'Publication...' : 'Publier'}
            </Button>
          </div>
        ))
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Onglet Analytics : vue d'ensemble (CTR/CPA/ROAS agrégés), répartition par canal,
// répartition par créative (quelle variation A/B a réellement gagné). Uniquement
// significatif une fois la campagne PUBLISHED — cf. AnalyticsService côté backend.
// ---------------------------------------------------------------------------
function AnalyticsTab({ campaignId, campaign }: { campaignId: string; campaign: any }) {
  const [summary, setSummary] = useState<any>(null);
  const [channels, setChannels] = useState<any[]>([]);
  const [content, setContent] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conversionCount, setConversionCount] = useState('');
  const [conversionValue, setConversionValue] = useState('');
  const [savingConversion, setSavingConversion] = useState(false);

  useEffect(() => {
    if (campaign.status !== 'PUBLISHED') return;
    api.getCampaignAnalyticsSummary(campaignId).then(setSummary).catch((err) => setError(err.message));
    api.getCampaignAnalyticsChannels(campaignId).then(setChannels).catch(() => setChannels([]));
    api.getCampaignAnalyticsContent(campaignId).then(setContent).catch(() => setContent([]));
  }, [campaignId, campaign.status]);

  if (campaign.status !== 'PUBLISHED') {
    return <Card><p style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: 0 }}>Les statistiques ne sont disponibles qu'une fois la campagne publiée.</p></Card>;
  }

  async function submitConversion(e: React.FormEvent) {
    e.preventDefault();
    if (!conversionCount || !conversionValue) return;
    setSavingConversion(true); setError(null);
    try {
      await api.recordConversion(campaignId, { count: Number(conversionCount), value: Number(conversionValue) });
      setConversionCount(''); setConversionValue('');
      setSummary(await api.getCampaignAnalyticsSummary(campaignId));
    } catch (err: any) { setError(err.message); }
    finally { setSavingConversion(false); }
  }

  return (
    <>
      <ErrorText message={error} />

      {summary && (
        <Card style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Vue d'ensemble</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Stat label="Impressions" value={summary.impressions?.toLocaleString('fr-FR') ?? '0'} />
            <Stat label="CTR" value={summary.ctr != null ? `${summary.ctr.toFixed(1)}%` : '—'} />
            <Stat label="CPA" value={summary.cpa != null ? `${summary.cpa.toFixed(2)}€` : '—'} />
            <Stat label="ROAS" value={summary.roas != null ? `${summary.roas.toFixed(1)}x` : 'Non calculable'} />
          </div>
          {summary.roas == null && (
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10, marginBottom: 0 }}>
              ROAS non calculable sans valeur de conversion enregistrée (cf. formulaire ci-dessous).
            </p>
          )}
        </Card>
      )}

      <Card style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Répartition par canal</h2>
        {channels.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Aucune donnée pour le moment.</p>
        ) : (
          channels.map((c: any) => (
            <div key={c.platform} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
              <span>{c.platform}</span>
              <span className="mono">{c.impressions ?? 0} impr. · {c.ctr != null ? `${c.ctr.toFixed(1)}%` : '—'} CTR</span>
            </div>
          ))
        )}
      </Card>

      <Card style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Répartition par créative</h2>
        <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: -6, marginBottom: 10 }}>Quelle variation a réellement gagné.</p>
        {content.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Aucune donnée pour le moment.</p>
        ) : (
          content.map((c: any, i: number) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
              <span>{c.version?.label ? `Variation ${c.version.label}` : `Version ${c.version?.versionNumber ?? ''}`} — {c.version?.contentPiece?.channel}</span>
              <span className="mono">{c.impressions ?? 0} impr. · {c.ctr != null ? `${c.ctr.toFixed(1)}%` : '—'} CTR</span>
            </div>
          ))
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>Enregistrer une conversion</h2>
        <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: -6, marginBottom: 12 }}>
          Aucun adaptateur ne remonte de conversions programmatiquement — code promo, UTM ou déclaration commerciale.
        </p>
        <form onSubmit={submitConversion} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12 }}>
            <span style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: 4 }}>Nombre</span>
            <input type="number" min={1} value={conversionCount} onChange={(e) => setConversionCount(e.target.value)} style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-strong)', width: 90 }} />
          </label>
          <label style={{ fontSize: 12 }}>
            <span style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: 4 }}>Valeur totale (€)</span>
            <input type="number" min={0} value={conversionValue} onChange={(e) => setConversionValue(e.target.value)} style={{ fontSize: 13, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-strong)', width: 110 }} />
          </label>
          <Button type="submit" disabled={savingConversion || !conversionCount || !conversionValue}>
            {savingConversion ? 'Enregistrement...' : 'Enregistrer'}
          </Button>
        </form>
      </Card>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onglet Content Studio : pièces de contenu par canal, historique de versions,
// édition (nouvelle version), variations A/B, sélection de la version courante.
// ---------------------------------------------------------------------------
function ContentStudioTab({ campaignId }: { campaignId: string }) {
  const [pieces, setPieces] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [schedulingId, setSchedulingId] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [scheduleConnectionId, setScheduleConnectionId] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listContentPieces(campaignId).then(setPieces).catch((err) => setError(err.message));
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.listSocialConnections().then(setConnections).catch(() => setConnections([])); }, []);

  async function schedule(pieceId: string) {
    if (!scheduleConnectionId || !scheduleAt) return;
    try {
      await api.scheduleCalendarEntry({ contentPieceId: pieceId, socialConnectionId: scheduleConnectionId, scheduledAt: new Date(scheduleAt).toISOString() });
      setSchedulingId(null);
    } catch (err: any) { setError(err.message); }
  }

  async function saveEdit(pieceId: string) {
    try {
      await api.editContentPiece(campaignId, pieceId, { body: draftBody, changeNote: 'Édition manuelle' });
      setEditingId(null);
      load();
    } catch (err: any) { setError(err.message); }
  }

  async function createVariation(pieceId: string, body: string) {
    try {
      await api.createContentVariations(campaignId, pieceId, [{ label: 'B', body }]);
      load();
    } catch (err: any) { setError(err.message); }
  }

  async function selectVersion(pieceId: string, versionId: string) {
    try {
      await api.selectContentVersion(campaignId, pieceId, versionId);
      load();
    } catch (err: any) { setError(err.message); }
  }

  if (pieces.length === 0) {
    return <Card><p style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: 0 }}>Aucun contenu généré pour le moment — le Content Studio se peuple automatiquement dès que l'orchestration IA produit un résultat.</p></Card>;
  }

  return (
    <>
      <ErrorText message={error} />
      {pieces.map((piece) => (
        <Card key={piece.id} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13.5 }}>{piece.channel} · {piece.type}</strong>
            <StatusPill status={piece.status} />
          </div>

          {piece.currentVersion?.asset?.url && (
            <img src={piece.currentVersion.asset.url} alt="" style={{ maxWidth: '100%', borderRadius: 8, marginBottom: 10 }} />
          )}

          {editingId === piece.id ? (
            <>
              <Textarea value={draftBody} onChange={setDraftBody} rows={4} />
              <div style={{ display: 'flex', gap: 10 }}>
                <Button onClick={() => saveEdit(piece.id)}>Enregistrer (nouvelle version)</Button>
                <Button variant="secondary" onClick={() => setEditingId(null)}>Annuler</Button>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>{piece.currentVersion?.body}</p>
              <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                <Button variant="secondary" onClick={() => { setEditingId(piece.id); setDraftBody(piece.currentVersion?.body ?? ''); }}>
                  Éditer
                </Button>
                <Button variant="secondary" onClick={() => createVariation(piece.id, piece.currentVersion?.body ?? '')}>
                  Créer une variation
                </Button>
                <Button variant="secondary" onClick={() => setSchedulingId(schedulingId === piece.id ? null : piece.id)}>
                  Planifier
                </Button>
              </div>
              {schedulingId === piece.id && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10, padding: 12, background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <label style={{ fontSize: 12 }}>
                    <span style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: 4 }}>Canal connecté</span>
                    <select value={scheduleConnectionId} onChange={(e) => setScheduleConnectionId(e.target.value)} style={{ fontSize: 12.5, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-strong)' }}>
                      <option value="">Sélectionner...</option>
                      {connections.map((c) => <option key={c.id} value={c.id}>{c.platform} — {c.externalAccountName}</option>)}
                    </select>
                  </label>
                  <label style={{ fontSize: 12 }}>
                    <span style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: 4 }}>Date et heure</span>
                    <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} style={{ fontSize: 12.5, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-strong)' }} />
                  </label>
                  <Button onClick={() => schedule(piece.id)}>Confirmer</Button>
                </div>
              )}
            </>
          )}

          {/* Historique de versions — jamais d'écrasement, une variation A/B partage le même
              variantGroup mais porte un label différent (cf. ContentVersion côté backend). */}
          {piece.versions?.length > 1 && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>Versions</div>
              {piece.versions.map((v: any) => (
                <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
                  <span>
                    {v.label ? `Variation ${v.label}` : `Version ${v.versionNumber}`}
                    {v.id === piece.currentVersionId ? ' — actuelle' : ''}
                  </span>
                  {v.id !== piece.currentVersionId && (
                    <button onClick={() => selectVersion(piece.id, v.id)} style={{ fontSize: 11.5, background: 'none', border: 'none', color: 'var(--text-secondary)', textDecoration: 'underline', cursor: 'pointer' }}>
                      Utiliser celle-ci
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Onglet Optimizer : recommandations existantes + déclenchement manuel +
// appliquer/écarter (réservé Marketing Manager+, jamais automatique).
// ---------------------------------------------------------------------------
function OptimizerTab({ campaignId, campaign, canApproveRole, onChange }: any) {
  const [optimizations, setOptimizations] = useState<any[]>(campaign.optimizationRecommendations ?? []);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    api.listOptimizations(campaignId).then(setOptimizations).catch((err) => setError(err.message));
  }, [campaignId]);

  async function runNow() {
    setRunning(true); setError(null);
    try { await api.runOptimizerNow(); await load(); }
    catch (err: any) {
      // Plafond d'analyses Optimizer (essai) : moment de conversion ciblé plutôt qu'un
      // message d'erreur générique, même logique que /campaigns/new.
      if (err instanceof ApiError && err.isPlanLimit) setLimitError(err);
      else setError(err.message);
    }
    finally { setRunning(false); }
  }

  async function review(id: string, action: 'apply' | 'dismiss') {
    try {
      if (action === 'apply') await api.applyOptimization(id); else await api.dismissOptimization(id);
      load(); onChange();
    } catch (err: any) { setError(err.message); }
  }

  if (campaign.status !== 'PUBLISHED') {
    return <Card><p style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: 0 }}>L'Optimizer analyse les campagnes publiées — revenez ici une fois cette campagne diffusée.</p></Card>;
  }

  return (
    <>
      <UpgradeModal error={limitError} onClose={() => setLimitError(null)} />
      <ErrorText message={error} />
      <div style={{ marginBottom: 16 }}>
        <Button onClick={runNow} disabled={running}>{running ? 'Analyse en cours...' : 'Lancer une analyse maintenant'}</Button>
      </div>

      {optimizations.length === 0 ? (
        <Card><p style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: 0 }}>Aucune recommandation pour le moment.</p></Card>
      ) : (
        optimizations.map((o: any) => (
          <Card key={o.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <strong style={{ fontSize: 13.5, maxWidth: '75%' }}>{o.summary}</strong>
              <StatusPill status={o.status} />
            </div>
            {o.details?.actions?.map((a: any, i: number) => (
              <div key={i} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.type}</div>
                <div style={{ fontSize: 13 }}>{a.description}</div>
                <div style={{ fontSize: 11.5, color: 'var(--accent-done)', marginTop: 2 }}>{a.expectedImpact}</div>
              </div>
            ))}
            {o.status === 'PENDING' && (
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <Button onClick={() => review(o.id, 'apply')} disabled={!canApproveRole}>Appliquer</Button>
                <Button variant="secondary" onClick={() => review(o.id, 'dismiss')} disabled={!canApproveRole}>Écarter</Button>
              </div>
            )}
          </Card>
        ))
      )}
    </>
  );
}
