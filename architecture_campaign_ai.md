# Campaign-ai — Architecture technique idéale

Ce document propose une architecture cible détaillée, cohérente avec la vision décrite dans le business plan (Volume 1, chapitres 9 et 10 ; Volume 2, chapitre 5) : une plateforme SaaS d'orchestration marketing multi-fournisseurs d'IA, organisée en ~20 modules fonctionnels, devant tenir 100 000 organisations et plusieurs pétaoctets de médias à 5 ans.

---

## 1. Principes directeurs

1. **Modulaire avant distribué** — démarrer en monolithe modulaire pour aller vite, découper en microservices uniquement là où la charge ou l'équipe le justifient.
2. **Multi-fournisseurs d'IA par design** — aucun composant métier n'appelle directement un fournisseur d'IA ; tout passe par une couche d'abstraction (AI Gateway).
3. **Asynchrone par défaut pour tout ce qui est long** — génération vidéo/image, publication multicanale, analyses : jamais dans le cycle requête/réponse HTTP.
4. **Multi-tenant strict** — isolation des données par organisation dès le schéma de base, pas ajoutée après coup.
5. **Coût = donnée de première classe** — chaque génération IA est tracée (fournisseur, modèle, tokens, coût, latence) pour piloter la rentabilité en continu.
6. **Portabilité infra** — conteneurisé, IaC, pas de verrou propriétaire fort sur un cloud (cohérent avec l'objectif Docker/Kubernetes/AWS/Azure/GCP/OVH/Scaleway du document).

---

## 2. Vue d'ensemble en couches

```
Clients (Web / Mobile / API publique)
        │
Edge : CDN + WAF + API Gateway (auth, rate limiting, routing)
        │
Services applicatifs (BFF + domaines métier)
        │
Couche IA : AI Orchestrator → AI Gateway → fournisseurs externes
        │
Données : PostgreSQL • Redis • Object Storage • Vector DB • warehouse analytics
        │
File d'attente & workers asynchrones (transverse à toutes les couches ci-dessus)
```

Chaque couche est remplaçable indépendamment : changer de fournisseur cloud, de fournisseur d'IA ou de base de données ne doit jamais nécessiter de réécrire la couche métier.

---

## 3. Frontend

| Composant | Choix recommandé | Justification |
|---|---|---|
| Web app | Next.js (React, TypeScript), rendu hybride SSR/CSR | SEO pour les landing pages générées, bonnes perfs perçues |
| Mobile | React Native (ou report en Phase 2/3) | Mutualisation du code avec l'équipe web au démarrage |
| Design system | Composants partagés (ex. shadcn/ui + Tailwind) | Cohérence visuelle sur 500+ écrans annoncés |
| État temps réel | WebSocket / SSE pour suivre la génération IA en direct | L'utilisateur doit voir la progression d'une génération vidéo/campagne sans recharger |

Le **BFF (Backend For Frontend)** expose des endpoints agrégés adaptés à l'UI, en s'appuyant sur les services métier — cela évite que le frontend fasse 10 appels pour afficher un écran de campagne.

---

## 4. Edge et sécurité

- **CDN** (Cloudflare ou équivalent) pour les assets statiques, images et vidéos générées.
- **WAF** + protection anti-bot/anti-DDoS en amont.
- **API Gateway** (Kong, ou service managé équivalent) : authentification, rate limiting par plan d'abonnement, routage vers les services, versionnage de l'API publique.
- **Authentification** : JWT + refresh tokens, MFA, SSO Enterprise (SAML/OIDC) pour les gros comptes — comme prévu au chapitre 10.
- **Autorisation** : RBAC multi-niveaux (Owner, Admin, Marketing Manager, Editor, Viewer), vérifié à la fois côté Gateway (grossier) et côté service (fin, par ressource).

---

## 5. Backend applicatif

### Phase 1 — MVP : monolithe modulaire

Un backend **NestJS (Node.js/TypeScript)** organisé en modules internes fortement découplés, chacun avec ses propres tables et une interface claire :

- `Auth` · `User` · `Organization`
- `Brand` (mémoire de marque : logo, charte, ton, personas, historique)
- `Campaign` · `Content` · `Strategy`
- `AI` (façade vers l'AI Orchestrator)
- `Billing` (Stripe, quotas, crédits IA)

Cette approche accélère le développement initial et simplifie le déploiement (un seul artefact à livrer), conformément à la recommandation du chapitre 10.

### Phase 2 — Extraction ciblée de services

Dès que la charge ou l'autonomie d'équipe le justifie, extraire en services indépendants les modules à cycle de vie ou à charge différents :

- **AI Gateway** (appels IA à fort volume, scaling indépendant)
- **Media Processing Service** (rendu vidéo/image, CPU/GPU intensif)
- **Publishing Service** (connecteurs réseaux sociaux, gestion des quotas d'API externes)
- **Analytics Service** (ingestion d'événements, agrégations)
- **Notification Service**
- **Billing Service**

### Phase 3 — Microservices complets

Chacun des ~20 modules fonctionnels (Brand Intelligence, Product Intelligence, Competitor Intelligence, Video Studio, AI Optimizer, Marketplace, etc.) devient un service autonome avec sa base de données dédiée, communiquant via API interne et événements. Cette étape n'est justifiée qu'à partir d'une échelle où plusieurs équipes travaillent en parallèle sur des domaines distincts.

**Langages complémentaires** : garder Node/TypeScript comme socle pour la cohérence, mais isoler les traitements médias lourds (transcodage vidéo, traitement d'image) dans des workers en Python ou Go si les bibliothèques le justifient — sans jamais coupler ce choix à la couche métier.

---

## 6. Couche IA : le cœur stratégique

### 6.1 AI Orchestrator

Composant décisionnel qui reçoit une intention métier (« générer une campagne complète ») et la décompose en sous-tâches routées vers le bon moteur :

```
Analyse produit → Gemini Flash
Analyse marketing / personas → Claude ou GPT-5
Copywriting → GPT-5
Images → GPT Image / Flux / Ideogram
Vidéos → Google Veo
Traduction → Gemini
```

Pour chaque tâche, il arbitre selon : **coût estimé, qualité attendue, latence, disponibilité, confidentialité, quotas restants**. Il applique un système de notation continue des fournisseurs (taux d'erreur, coût réel, satisfaction utilisateur) pour affiner ses choix dans le temps — logique déjà posée au chapitre 5 du Volume 2, à opérationnaliser via une base de scoring versionnée.

**Résilience** : détection de panne fournisseur → bascule automatique vers un fournisseur de secours → nouvelle tentative → journalisation. Pattern **circuit breaker** classique (ex. bibliothèque type Opossum côté Node) pour éviter qu'un fournisseur en panne ne dégrade tout le système.

### 6.2 AI Gateway

Interface unifiée type `generateText()`, `generateImage()`, `generateVideo()`, `transcribeAudio()`, `translate()`, `reason()`, indépendante du fournisseur sous-jacent (s'appuyer sur un pattern proche de LiteLLM/Portkey plutôt que réinventer un adaptateur par fournisseur). Ajouter un fournisseur ne doit toucher que cette couche.

### 6.3 Mémoire de marque (Brand Intelligence) — complément recommandé

Le document mentionne une « mémoire permanente de la marque » mais ne précise pas son implémentation technique. Recommandation : une **base vectorielle** (pgvector sur PostgreSQL pour rester simple en MVP, ou solution dédiée type Pinecone/Qdrant à l'échelle) pour stocker les embeddings de la charte éditoriale, des campagnes passées et des personas, injectés en RAG dans chaque prompt afin de garantir la cohérence de ton sans réécrire tout le contexte à chaque appel.

### 6.4 Traçabilité IA

Chaque génération enregistre : prompt et sa version, fournisseur, modèle, tokens, coût estimé, temps de traitement, validation utilisateur. Cette table alimente à la fois l'audit, la facturation précise et l'amélioration continue des prompts — c'est la donnée qui permet de vérifier réellement la rentabilité par campagne évoquée au chapitre 11 du Volume 1.

---

## 7. Données

| Store | Rôle |
|---|---|
| **PostgreSQL** | Source de vérité : utilisateurs, organisations, campagnes, contenus, personas, stratégies, prompts, facturation. Isolation multi-tenant via `organization_id` sur chaque table + row-level security. |
| **Redis** | Cache, sessions, rate limiting, verrous distribués, backend de la file de jobs légers. |
| **Object Storage** (S3-compatible : AWS S3, Cloudflare R2, Backblaze B2, MinIO) | Images, vidéos, PDF, exports, assets — avec politique d'archivage/tiering pour maîtriser les coûts à mesure que le volume de médias croît. |
| **Vector DB** (pgvector puis dédié) | Mémoire de marque, recherche sémantique, RAG. |
| **Entrepôt analytique** (ex. ClickHouse ou ce que propose le cloud choisi) | Événements produit et marketing à fort volume (CTR, conversions, performance des contenus), séparé de la base transactionnelle pour ne pas la ralentir. |

---

## 8. Traitement asynchrone

Toute opération longue passe par une **file d'attente** (RabbitMQ, ou SQS/Cloud Tasks selon le cloud, ou BullMQ sur Redis en MVP) consommée par des **workers** dédiés :

- génération vidéo, génération en masse de publications, export PDF, synchronisation Shopify/WooCommerce/Prestashop/Amazon, analyse concurrentielle, tâche nocturne de l'AI Optimizer.

Cela garantit une interface toujours réactive, quel que soit le temps réel de génération IA côté fournisseur.

---

## 9. Sécurité

- Chiffrement TLS en transit, chiffrement au repos pour les données sensibles.
- Gestion des secrets via un coffre dédié (Vault, ou secrets manager du cloud) avec rotation des clés.
- Journalisation systématique des actions sensibles : connexion, création/suppression, publication, génération IA, paiement.
- Isolation stricte entre organisations à tous les niveaux (base de données, stockage objet, cache).

---

## 10. Observabilité, CI/CD, déploiement

- **Observabilité** : métriques, logs, traces distribuées (OpenTelemetry), alerting — indispensable dès que l'AI Orchestrator arbitre entre plusieurs fournisseurs, pour détecter une dégradation de qualité ou une dérive de coût en temps réel.
- **CI/CD** : GitHub → tests → lint → build → image Docker → registry → staging → tests automatiques → production.
- **Déploiement** : conteneurisé (Docker/Kubernetes), pensé pour rester portable entre AWS, Azure, GCP, OVHcloud, Scaleway — cohérent avec la volonté de ne pas dépendre d'un seul fournisseur d'infrastructure.

### Cibles de performance (reprises du business plan)

| Indicateur | Objectif |
|---|---|
| Temps de réponse API (hors IA) | < 300 ms |
| Génération d'un texte | < 10 s |
| Génération d'une image | < 30 s |
| Génération d'une vidéo courte | < 120 s |
| Disponibilité | 99,9 % (MVP) → 99,95 % |
| Reprise après incident | < 30 min |

---

## 11. Feuille de route technique en 3 phases

| Phase | Architecture | Infra cible | Objectif |
|---|---|---|---|
| **MVP** | Monolithe modulaire NestJS + AI Gateway simple + queue Redis/BullMQ | 1 environnement cloud unique, coût 300–800 €/mois | Valider le produit avec les premiers clients |
| **Croissance (100–1 000 clients)** | Extraction AI Gateway, Media Processing, Publishing, Analytics en services séparés | Auto-scaling, CDN, coût 1 000–8 000 €/mois | Acquisition PME/e-commerçants |
| **Expansion / Enterprise (10 000+ clients)** | Microservices complets par module, multi-région | Kubernetes multi-cloud, coût 20 000–45 000 €/mois | International, SSO Enterprise, marketplace, API publique |

Cette trajectoire respecte l'estimation de coûts d'infrastructure déjà posée dans le chapitre 11 du Volume 1, en la reliant explicitement aux paliers d'architecture.

---

## 12. Ce que j'ajouterais par rapport au document existant

Le business plan pose de très bonnes bases (chapitres 9-10 du Volume 1, chapitre 5 du Volume 2). Trois compléments concrets pour passer du plan à l'exécution :

1. **Vector DB / RAG explicite** pour la mémoire de marque — mentionnée fonctionnellement mais pas comme composant d'architecture.
2. **Circuit breaker et scoring de fournisseurs formalisés** dans l'AI Orchestrator, pas seulement décrits en prose, pour vraiment garantir la continuité de service promise.
3. **Séparation base transactionnelle / entrepôt analytique** dès que le module Analytics Intelligence devient actif, pour éviter que les tableaux de bord ne dégradent les performances de l'application principale.
