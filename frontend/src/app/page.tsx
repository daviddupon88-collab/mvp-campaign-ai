'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';
import { PricingGrid } from '@/components/pricing-grid';

const FEATURES = [
  { title: 'Analyse produit par IA', desc: "Une photo suffit : l'IA détecte catégorie, prix, forces et USP automatiquement." },
  { title: 'Stratégie & personas', desc: "Objectifs SMART, personas détaillés et positionnement générés à partir de votre produit." },
  { title: 'Contenus multicanaux', desc: "Textes, visuels et vidéos adaptés à Facebook, Instagram, LinkedIn, TikTok et Google Ads." },
  { title: 'Validation humaine', desc: "Aucune publication sans approbation — modération et cohérence de marque vérifiées automatiquement." },
  { title: 'Optimisation continue', desc: "Chaque nuit, l'IA analyse vos campagnes publiées et propose des ajustements mesurables." },
  { title: 'Multi-équipe', desc: "Invitez votre équipe, gérez les rôles, suivez qui a approuvé quoi." },
];

export default function LandingPage() {
  const router = useRouter();
  const [plans, setPlans] = useState<any[]>([]);

  useEffect(() => {
    // Un visiteur déjà connecté n'a aucune raison de revoir la landing page.
    const token = localStorage.getItem('accessToken');
    if (token) {
      router.replace('/dashboard');
      return;
    }
    api.listPlans().then(setPlans).catch(() => setPlans([]));
  }, [router]);

  return (
    <main>
      {/* Barre de navigation */}
      <nav style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 32px', borderBottom: '1px solid #e5e3dd' }}>
        <span style={{ fontWeight: 600, fontSize: 16 }}>Campaign-ai</span>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <Link href="/pricing" style={{ fontSize: 14, color: '#5f5e5a', textDecoration: 'none' }}>Tarifs</Link>
          <Link href="/login" style={{ fontSize: 14, color: '#5f5e5a', textDecoration: 'none' }}>Connexion</Link>
          <Link href="/register"><Button>Essai gratuit 14 jours</Button></Link>
        </div>
      </nav>

      {/* Hero */}
      <section style={{ maxWidth: 720, margin: '0 auto', padding: '80px 24px 60px', textAlign: 'center' }}>
        <h1 style={{ fontSize: 40, lineHeight: 1.15, margin: '0 0 20px', fontWeight: 600 }}>
          De votre produit à votre campagne marketing complète.
        </h1>
        <p style={{ fontSize: 17, color: '#5f5e5a', margin: '0 0 32px', lineHeight: 1.6 }}>
          Campaign-ai analyse votre produit, crée votre stratégie, génère vos contenus et visuels,
          puis vous aide à les publier sur vos réseaux.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <Link href="/register"><Button>Démarrer gratuitement</Button></Link>
          <a href="#features"><Button variant="secondary">Voir les fonctionnalités</Button></a>
        </div>
        <p style={{ fontSize: 13, color: '#9a9992', marginTop: 16 }}>
          14 jours gratuits · Sans carte bancaire
        </p>
      </section>

      {/* Fonctionnalités */}
      <section id="features" style={{ maxWidth: 960, margin: '0 auto', padding: '40px 24px 80px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20 }}>
          {FEATURES.map((f) => (
            <Card key={f.title}>
              <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{f.title}</h3>
              <p style={{ fontSize: 13.5, color: '#5f5e5a', margin: 0, lineHeight: 1.6 }}>{f.desc}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Tarifs (données réelles, GET /plans public) */}
      <section style={{ background: '#fff', borderTop: '1px solid #e5e3dd', padding: '64px 24px' }}>
        <div style={{ maxWidth: 1040, margin: '0 auto' }}>
          <h2 style={{ textAlign: 'center', fontSize: 24, marginBottom: 8 }}>Un plan pour chaque étape</h2>
          <p style={{ textAlign: 'center', fontSize: 14, color: '#5f5e5a', marginBottom: 40 }}>
            Tous les plans incluent 14 jours d'essai gratuit — aucune carte bancaire requise pour commencer.
          </p>
          <PricingGrid plans={plans} ctaHref="/register" />
        </div>
      </section>

      <footer style={{ textAlign: 'center', padding: '32px 24px', fontSize: 12.5, color: '#9a9992' }}>
        © Campaign-ai · <Link href="/pricing" style={{ color: 'inherit' }}>Tarifs</Link>
      </footer>
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e3dd', borderRadius: 12, padding: 20 }}>
      {children}
    </div>
  );
}
