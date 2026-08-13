'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, Field, Textarea, ErrorText } from '@/components/ui';
import { INTL_TAGS, Locale } from '@/i18n/config';

// Brand Brain V2 — au-delà de la charte déclarée (BrandKit, statique), cette page donne
// désormais accès à la mémoire de marque qui s'enrichit réellement : apprentissages avec
// confiance et explicabilité, règles appliquées par du code (BrandRuleGuardService),
// contradictions détectées entre connaissances, et un résumé dynamique (Brand Brief) généré
// à partir des données réelles — jamais codé en dur. cf. rapport d'audit du 2026-08-12 :
// l'ancienne version affichait une liste en lecture seule, jamais réellement injectée dans
// les prompts de génération ; c'est corrigé (BrandContextBuilderService).
export default function BrandBrainPage() {
  const ready = useRequireAuth();
  const t = useTranslations('settings.brandBrain');
  const tCommon = useTranslations('common');
  const [kit, setKit] = useState<any>(null);
  const [brief, setBrief] = useState<any>(null);
  const [memory, setMemory] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [contradictions, setContradictions] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const [toneOfVoice, setToneOfVoice] = useState('');
  const [mission, setMission] = useState('');
  const [vision, setVision] = useState('');
  const [valuePropsText, setValuePropsText] = useState('');
  const [slogansText, setSlogansText] = useState('');
  const [competitorsText, setCompetitorsText] = useState('');
  const [personaNotesText, setPersonaNotesText] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  function loadKit() {
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
      setPersonaNotesText((data.personaNotes ?? []).map((p: any) => p.name).join('\n'));
    }).catch(() => {});
  }

  function loadMemory() {
    // RULE exclue de la liste générale — affichée séparément (section Règles), rôle différent.
    api.getBrandMemory({ status: 'ACTIVE', limit: 30 }).then((data) => setMemory(data.filter((m: any) => m.type !== 'RULE'))).catch(() => setMemory([]));
  }
  function loadRules() {
    api.getBrandRules().then(setRules).catch(() => setRules([]));
  }
  function loadContradictions() {
    api.getBrandContradictions().then(setContradictions).catch(() => setContradictions([]));
  }
  function loadBrief() {
    api.getBrandBrief().then(setBrief).catch(() => setBrief(null));
  }

  useEffect(() => {
    if (!ready) return;
    loadKit();
    loadMemory();
    loadRules();
    loadContradictions();
    loadBrief();
  }, [ready]);

  if (!ready) return null;

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true); setError(null);
    try {
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
        personaNotes: personaNotesText.split('\n').map((s) => s.trim()).filter(Boolean).map((name) => ({ name })),
      });
      setKit(updated);
      setSaved(true);
      loadBrief();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function withActing(id: string, action: () => Promise<void>) {
    setActingId(id); setError(null);
    try {
      await action();
    } catch (err: any) {
      setError(err.message ?? t('actions.actionFailed'));
    } finally {
      setActingId(null);
    }
  }

  function handleConfirm(id: string) {
    return withActing(id, async () => { await api.confirmBrandMemory(id); loadMemory(); loadBrief(); });
  }
  function handleDismiss(id: string) {
    return withActing(id, async () => { await api.dismissBrandMemory(id); loadMemory(); loadBrief(); });
  }
  function handlePromote(id: string) {
    return withActing(id, async () => { await api.promoteBrandMemoryToRule(id); loadMemory(); loadRules(); loadBrief(); });
  }
  function startEdit(entry: any) {
    setEditingId(entry.id);
    setEditText(entry.content);
  }
  function handleSaveEdit(id: string) {
    return withActing(id, async () => { await api.correctBrandMemory(id, { content: editText }); setEditingId(null); loadMemory(); });
  }
  function handleResolve(id: string, resolution: 'RESOLVED_A' | 'RESOLVED_B' | 'CONTEXT_DEPENDENT') {
    return withActing(id, async () => { await api.resolveBrandContradiction(id, resolution); loadContradictions(); loadMemory(); loadBrief(); });
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 720, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>{t('title')}</h1>
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginBottom: 24 }}>
          {t('subtitle')}
        </p>

        <ErrorText message={error} />

        <Card style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>{t('declaredIdentity')}</h2>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <div style={{ width: 64, height: 64, borderRadius: 10, background: 'var(--bg-raised)', border: '1px solid var(--border)', backgroundImage: logoUrl ? `url(${logoUrl})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center', flexShrink: 0 }} />
            <div>
              <label style={{ display: 'inline-block', fontSize: 13, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border-strong)', cursor: 'pointer' }}>
                {uploadingLogo ? t('uploading') : t('uploadLogo')}
                <input type="file" accept="image/*" onChange={handleLogoUpload} disabled={uploadingLogo} style={{ display: 'none' }} />
              </label>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>{t('logoHint')}</p>
            </div>
          </div>

          <Field label={t('toneLabel')} value={toneOfVoice} onChange={setToneOfVoice} placeholder={t('tonePlaceholder')} />
          <Field label={t('missionLabel')} value={mission} onChange={setMission} placeholder={t('missionPlaceholder')} />
          <Field label={t('visionLabel')} value={vision} onChange={setVision} placeholder={t('visionPlaceholder')} />
          <Textarea label={t('valuePropsLabel')} value={valuePropsText} onChange={setValuePropsText} rows={3} />
          <Textarea label={t('slogansLabel')} value={slogansText} onChange={setSlogansText} rows={2} />
          <Textarea label={t('competitorsLabel')} value={competitorsText} onChange={setCompetitorsText} rows={2} />
          <Textarea label={t('personasLabel')} value={personaNotesText} onChange={setPersonaNotesText} rows={2} placeholder={t('personasPlaceholder')} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button onClick={save} disabled={saving}>{saving ? t('saving') : tCommon('actions.save')}</Button>
            {saved && <span style={{ fontSize: 12.5, color: 'var(--accent-done)' }}>{t('saved')}</span>}
          </div>
        </Card>

        {brief && <BriefCard brief={brief} />}

        {rules.length > 0 && (
          <Card style={{ marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>{t('rulesTitle')}</h2>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: -8, marginBottom: 14 }}>
              {t('rulesHint')}
            </p>
            {rules.map((r) => (
              <div key={r.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 13 }}>{r.content}</div>
                {(r.metadata?.forbiddenTerms?.length ?? 0) > 0 && (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--accent-danger)', marginTop: 4 }}>
                    {t('forbiddenTerms')} {r.metadata.forbiddenTerms.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </Card>
        )}

        <Card style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>{t('insightsTitle')}</h2>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: -8, marginBottom: 14 }}>
            {t('insightsHint')}
          </p>
          {memory.length === 0 ? (
            <p style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
              {t('insightsEmpty')}
            </p>
          ) : (
            memory.map((m) => (
              <MemoryEntryRow
                key={m.id}
                entry={m}
                acting={actingId === m.id}
                editing={editingId === m.id}
                editText={editText}
                onEditTextChange={setEditText}
                onConfirm={() => handleConfirm(m.id)}
                onDismiss={() => handleDismiss(m.id)}
                onPromote={() => handlePromote(m.id)}
                onStartEdit={() => startEdit(m)}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={() => handleSaveEdit(m.id)}
              />
            ))
          )}
        </Card>

        {contradictions.length > 0 && (
          <Card>
            <h2 style={{ fontSize: 15, fontWeight: 500, marginTop: 0 }}>{t('contradictionsTitle')}</h2>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: -8, marginBottom: 14 }}>
              {t('contradictionsHint')}
            </p>
            {contradictions.map((c) => (
              <ContradictionRow key={c.id} contradiction={c} acting={actingId === c.id} onResolve={(res) => handleResolve(c.id, res)} />
            ))}
          </Card>
        )}
      </main>
    </>
  );
}

function ConfidenceBadge({ score }: { score: number }) {
  const t = useTranslations('settings.brandBrain');
  const pct = Math.round(score * 100);
  const color = pct >= 70 ? 'var(--accent-done)' : pct >= 40 ? 'var(--accent-signal)' : 'var(--text-muted)';
  return (
    <span className="mono" style={{ fontSize: 11, color, border: `1px solid ${color}`, borderRadius: 20, padding: '2px 8px' }}>
      {t('confidence', { percent: pct })}
    </span>
  );
}

function BriefCard({ brief }: { brief: any }) {
  const t = useTranslations('settings.brandBrain');
  return (
    <Card style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>{t('briefTitle')}</h2>
        {brief.globalConfidenceAverage !== null && <ConfidenceBadge score={brief.globalConfidenceAverage} />}
      </div>

      {brief.positioning && <p style={{ fontSize: 13, marginTop: 0 }}><strong>{t('positioning')}</strong> {brief.positioning}</p>}

      {brief.winningPatterns.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--accent-done)', fontWeight: 600, marginBottom: 4 }}>{t('winningPatterns')}</div>
          {brief.winningPatterns.map((p: any, i: number) => (
            <div key={i} style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>• {p.content}</div>
          ))}
        </div>
      )}

      {brief.losingPatterns.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--accent-danger)', fontWeight: 600, marginBottom: 4 }}>{t('losingPatterns')}</div>
          {brief.losingPatterns.map((p: any, i: number) => (
            <div key={i} style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>• {p.content}</div>
          ))}
        </div>
      )}

      {(brief.topChannels.length > 0 || brief.topPersonas.length > 0) && (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {brief.topChannels.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 4 }}>{t('topChannels')}</div>
              {brief.topChannels.map((c: any) => (
                <div key={c.channel} className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{c.channel} — {Math.round(c.averageConfidence * 100)}%</div>
              ))}
            </div>
          )}
          {brief.topPersonas.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 4 }}>{t('topPersonas')}</div>
              {brief.topPersonas.map((p: any) => (
                <div key={p.persona} className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{p.persona} — {Math.round(p.averageConfidence * 100)}%</div>
              ))}
            </div>
          )}
        </div>
      )}

      {brief.contradictionsCount > 0 && (
        <p style={{ fontSize: 12, color: 'var(--accent-signal)', marginBottom: 0, marginTop: 10 }}>
          {t('contradictionsRemaining', { count: brief.contradictionsCount })}
        </p>
      )}
    </Card>
  );
}

function MemoryEntryRow({
  entry, acting, editing, editText, onEditTextChange, onConfirm, onDismiss, onPromote, onStartEdit, onCancelEdit, onSaveEdit,
}: {
  entry: any; acting: boolean; editing: boolean; editText: string; onEditTextChange: (v: string) => void;
  onConfirm: () => void; onDismiss: () => void; onPromote: () => void;
  onStartEdit: () => void; onCancelEdit: () => void; onSaveEdit: () => void;
}) {
  const t = useTranslations('settings.brandBrain');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const intlTag = INTL_TAGS[locale as Locale] ?? 'en-US';
  const explain = [
    t('observations', { count: entry.evidenceCount }),
    entry.positiveSignals || entry.negativeSignals ? t('positiveNegative', { positive: entry.positiveSignals, negative: entry.negativeSignals }) : null,
    entry.channel ? t('channelLabel', { channel: entry.channel }) : null,
    entry.persona ? t('personaLabel', { persona: entry.persona }) : null,
    entry.category ? entry.category.toLowerCase() : null,
  ].filter(Boolean).join(' · ');

  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {entry.type.toLowerCase()} · {new Date(entry.lastObservedAt ?? entry.createdAt).toLocaleDateString(intlTag)}
        </div>
        <ConfidenceBadge score={entry.confidenceScore} />
      </div>

      {editing ? (
        <div style={{ marginBottom: 6 }}>
          <textarea
            value={editText}
            onChange={(e) => onEditTextChange(e.target.value)}
            rows={2}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-page)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', resize: 'vertical' }}
          />
        </div>
      ) : (
        <div style={{ fontSize: 13, marginBottom: 4 }}>{entry.content}</div>
      )}

      <div title={explain} style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>{explain}</div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {editing ? (
          <>
            <ActionLink label={tCommon('actions.save')} onClick={onSaveEdit} disabled={acting} />
            <ActionLink label={tCommon('actions.cancel')} onClick={onCancelEdit} disabled={acting} />
          </>
        ) : (
          <>
            <ActionLink label={t('actions.confirm')} onClick={onConfirm} disabled={acting} color="var(--accent-done)" />
            <ActionLink label={t('actions.reject')} onClick={onDismiss} disabled={acting} color="var(--accent-danger)" />
            <ActionLink label={t('actions.edit')} onClick={onStartEdit} disabled={acting} />
            <ActionLink label={t('actions.promote')} onClick={onPromote} disabled={acting} color="var(--accent-brand)" />
          </>
        )}
      </div>
    </div>
  );
}

function ContradictionRow({ contradiction, acting, onResolve }: { contradiction: any; acting: boolean; onResolve: (r: 'RESOLVED_A' | 'RESOLVED_B' | 'CONTEXT_DEPENDENT') => void }) {
  const t = useTranslations('settings.brandBrain');
  const unresolved = contradiction.resolutionStatus === 'UNRESOLVED';
  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div className="mono" style={{ fontSize: 11, color: unresolved ? 'var(--accent-danger)' : 'var(--text-muted)', marginBottom: 6 }}>
        {unresolved ? t('unresolved') : contradiction.resolutionStatus.toLowerCase()}
      </div>
      <div style={{ fontSize: 13, marginBottom: 4 }}>A — {contradiction.knowledgeA?.content}</div>
      <div style={{ fontSize: 13, marginBottom: 8 }}>B — {contradiction.knowledgeB?.content}</div>
      {unresolved && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <ActionLink label={t('keepA')} onClick={() => onResolve('RESOLVED_A')} disabled={acting} color="var(--accent-brand)" />
          <ActionLink label={t('keepB')} onClick={() => onResolve('RESOLVED_B')} disabled={acting} color="var(--accent-brand)" />
          <ActionLink label={t('keepBoth')} onClick={() => onResolve('CONTEXT_DEPENDENT')} disabled={acting} />
        </div>
      )}
    </div>
  );
}

function ActionLink({ label, onClick, disabled, color }: { label: string; onClick: () => void; disabled?: boolean; color?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ fontSize: 12, background: 'none', border: 'none', color: color ?? 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, textDecoration: 'underline', padding: 0 }}
    >
      {label}
    </button>
  );
}
