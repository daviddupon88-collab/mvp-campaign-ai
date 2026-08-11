'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRequireAuth } from '@/lib/use-require-auth';
import { api } from '@/lib/api';
import { Nav } from '@/components/nav';
import { Card, Button, StatusPill, ErrorText } from '@/components/ui';

function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59); }
function formatMonth(d: Date) { return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); }

export default function CalendarPage() {
  const ready = useRequireAuth();
  const [month, setMonth] = useState(() => new Date());
  const [entries, setEntries] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listCalendarEntries(startOfMonth(month).toISOString(), endOfMonth(month).toISOString())
      .then(setEntries)
      .catch((err) => setError(err.message));
  }, [month]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  if (!ready) return null;

  async function cancel(id: string) {
    if (!confirm('Annuler cette publication planifiée ?')) return;
    try { await api.cancelCalendarEntry(id); load(); }
    catch (err: any) { setError(err.message); }
  }

  async function reschedule(id: string) {
    const input = prompt('Nouvelle date et heure (AAAA-MM-JJTHH:MM) :');
    if (!input) return;
    try { await api.rescheduleCalendarEntry(id, new Date(input).toISOString()); load(); }
    catch (err: any) { setError(err.message); }
  }

  return (
    <>
      <Nav />
      <main style={{ maxWidth: 720, margin: '40px auto', padding: '0 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0, textTransform: 'capitalize' }}>{formatMonth(month)}</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>← Précédent</Button>
            <Button variant="secondary" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>Suivant →</Button>
          </div>
        </div>
        <ErrorText message={error} />

        {entries.length === 0 ? (
          <Card><p style={{ fontSize: 13.5, color: '#5f5e5a', margin: 0 }}>Aucune publication planifiée ce mois-ci. La planification se fait depuis l'onglet "Contenu" d'une campagne.</p></Card>
        ) : (
          entries.map((e) => (
            <Card key={e.id} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{e.campaign?.name}</div>
                  <div style={{ fontSize: 12, color: '#9a9992', marginTop: 2 }}>
                    {e.socialConnection?.platform} — {e.socialConnection?.externalAccountName}
                  </div>
                  <div style={{ fontSize: 12, color: '#5f5e5a', marginTop: 4 }}>
                    {new Date(e.scheduledAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}
                  </div>
                </div>
                <StatusPill status={e.status} />
              </div>
              {e.status === 'SCHEDULED' && (
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  <button onClick={() => reschedule(e.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#5f5e5a', cursor: 'pointer' }}>Replanifier</button>
                  <button onClick={() => cancel(e.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: '#a3352d', cursor: 'pointer' }}>Annuler</button>
                </div>
              )}
            </Card>
          ))
        )}
      </main>
    </>
  );
}
