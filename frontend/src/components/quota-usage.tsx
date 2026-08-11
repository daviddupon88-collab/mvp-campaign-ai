'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card } from './ui';

const LABELS: Record<string, string> = {
  seats: 'Sièges', activeCampaigns: 'Campagnes actives', aiCredits: 'Crédits IA',
  images: 'Images IA', videos: 'Vidéos IA', socialPosts: 'Publications', optimizerRuns: 'Analyses Optimizer',
};

// Affiche uniquement les quotas qui ont une limite définie — un plan payant a la plupart
// des champs à `limit: null` (illimité, cf. EntitlementsService.getUsageSummary), qui ne
// méritent pas une barre de progression puisqu'il n'y a rien à approcher.
export function QuotaUsage() {
  const [usage, setUsage] = useState<Record<string, { used: number; limit: number | null }> | null>(null);
  const [extraCredits, setExtraCredits] = useState(0);

  useEffect(() => {
    api.getUsage().then((data) => { setUsage(data.usage); setExtraCredits(data.usage?.extraCredits ?? 0); }).catch(() => setUsage(null));
  }, []);

  if (!usage) return null;
  const bounded = Object.entries(usage).filter(([k, v]) => k !== 'extraCredits' && typeof v === 'object' && v.limit !== null);
  if (bounded.length === 0 && extraCredits === 0) return null;

  return (
    <Card style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 14, fontWeight: 500, marginTop: 0, marginBottom: 14 }}>Consommation de votre plan</h2>
      {bounded.map(([key, v]) => {
        const value = v as { used: number; limit: number | null };
        const pct = value.limit ? Math.min(100, Math.round((value.used / value.limit) * 100)) : 0;
        return (
          <div key={key} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
              <span style={{ color: '#5f5e5a' }}>{LABELS[key] ?? key}</span>
              <span className="mono">{value.used} / {value.limit}</span>
            </div>
            <div style={{ height: 6, background: '#eee', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: pct > 90 ? '#a3552d' : '#1a1a18', borderRadius: 6 }} />
            </div>
          </div>
        );
      })}
      {extraCredits > 0 && (
        // Consommé en priorité sur le quota ci-dessus (cf. EntitlementsService.consumeCredits)
        // — jamais remis à zéro au renouvellement mensuel, donc affiché à part plutôt que
        // mélangé dans une barre de progression qui suggérerait à tort une limite mensuelle.
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginTop: 4, paddingTop: 10, borderTop: '1px solid #eee' }}>
          <span style={{ color: '#5f5e5a' }}>Crédits de pack achetés (consommés en priorité)</span>
          <span className="mono" style={{ color: '#4a9d7f' }}>{extraCredits}</span>
        </div>
      )}
    </Card>
  );
}
