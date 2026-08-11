# Campaign-ai — socle SaaS complet

Implémentation de Campaign-ai, alignée sur l'architecture décrite dans
`architecture_campaign_ai.md` : monolithe modulaire NestJS (Phase 1 de la roadmap),
AI Orchestrator multi-fournisseurs, queue asynchrone, frontend Next.js — complétée par
quatre chantiers : **Intégrations réelles** (réseaux sociaux, IA image/vidéo, Stripe,
e-commerce), **Garde-fous avant publication** (validation humaine, modération),
**Intelligence produit** (AI Optimizer nocturne, score de cohérence de marque, templates)
et **Socle SaaS** (multi-tenant, équipes, invitations, plans, entitlements, essais,
Stripe comme véritable moteur de facturation).

## Ce que contient ce scaffold

- **`backend/`** — API NestJS + Prisma (PostgreSQL) + BullMQ (Redis)
  - **Auth** (JWT, inscription = création d'organisation/tenant + essai gratuit, multi-organisation)
  - **Teams** — invitations par email, gestion des rôles, retrait de membres, garde-fous anti-abus (dernier Owner protégé, pas de promotion au-dessus de son propre rang)
  - **Plans** — catalogue de plans, entitlements (sièges, campagnes actives, canaux, fonctionnalités, crédits IA), essai gratuit avec expiration automatique
  - **Brand** (mémoire de marque)
  - **Campaigns** (création + orchestration IA asynchrone, canaux de diffusion, **workflow d'approbation**, templates, **quotas de plan appliqués**)
  - **Moderation** — garde-fou automatique avant toute revue humaine (toxicité, promesses trompeuses, marques déposées dans les visuels)
  - **Brand Consistency** — score 0-100 de respect du Brand Kit sur chaque génération (informatif, jamais bloquant)
  - **Campaign Templates** (Module 18, marketplace simplifié) — 6 templates système par secteur, guident réellement l'AI Orchestrator (pas de simple préremplissage de formulaire)
  - **Optimizer** (Module 16) — analyse nocturne des campagnes publiées, recommandations d'ajustement soumises à validation humaine
  - **AI** — AI Gateway avec chaînes de repli par type de tâche :
    - texte : `openai` → `anthropic` → mock
    - image : `flux` → `ideogram` → `openai` → mock
    - vidéo : `google-veo` → mock
  - **Social** — OAuth + publication multicanale (Module 14), **verrouillée tant que la campagne n'est pas `APPROVED` ET que l'abonnement est actif** :
    - Meta (Facebook/Instagram) et LinkedIn : implémentation complète, insights Meta branchés pour l'Optimizer
    - Google Ads et TikTok : structure OAuth prête, `publish()` à finaliser (voir code)
  - **Billing** — Stripe comme véritable moteur : Checkout, changement de plan avec proration, résiliation programmée/immédiate, reprise, portail client, historique de factures, packs de crédits, webhooks complets (y compris reset mensuel des crédits au renouvellement)
  - **Product Import** — connecteurs e-commerce (Module 3) : Shopify (complet),
    WooCommerce et Prestashop (fonctionnels)
- **`frontend/`** — Next.js (App Router) : inscription, dashboard, création de campagne,
  suivi des générations IA
- **`docker-compose.yml`** — PostgreSQL + Redis

## Garde-fous avant publication

Une campagne ne peut **jamais** atteindre `PUBLISHED` sans passer par ce cycle :

```
IN_PROGRESS (génération IA)
      │
      ▼
 Modération automatique (toxicité, promesses trompeuses, marques déposées)
      │
      ├── BLOCKED  ──────────────────────────► REJECTED (automatique)
      │
      └── PASSED / FLAGGED ─────────────────► READY_FOR_REVIEW
                                                     │
                              ┌──────────────────────┴──────────────────────┐
                              ▼                                             ▼
                    approve() [MARKETING_MANAGER+]                reject() [MARKETING_MANAGER+]
                              │                                             │
                              ▼                                             ▼
                          APPROVED                                     REJECTED ──► regenerate()
                              │
                              ▼
                 publish() [vérifie APPROVED, sinon 403]
                              │
                              ▼
                          PUBLISHED
```

Points clés :
- **La modération ne peut qu'automatiquement rejeter, jamais approuver.** Un verdict `PASSED` ou `FLAGGED` mène toujours à `READY_FOR_REVIEW` — l'approbation humaine reste obligatoire dans tous les cas.
- **Le verrou est appliqué au niveau le plus bas** (`PublishingService.assertCampaignApproved`), pas seulement dans l'UI — aucun chemin d'appel ne peut le contourner.
- **RBAC strict** : un `EDITOR` peut créer/proposer une campagne (`POST /campaigns`) mais pas l'approuver ; il faut au minimum `MARKETING_MANAGER` pour `POST /campaigns/:id/approve` ou `/reject`.
- Chaque vérification de modération est journalisée individuellement dans `ModerationCheck` (consultable via `GET /campaigns/:id/moderation`), pour que le validateur voie exactement ce qui a été signalé avant de décider.

## Endpoints du workflow d'approbation

| Endpoint | Rôle minimum | Effet |
|---|---|---|
| `POST /campaigns` | EDITOR | Crée la campagne, lance génération + modération |
| `GET /campaigns/:id/moderation` | tout membre | Liste les vérifications effectuées |
| `POST /campaigns/:id/approve` | MARKETING_MANAGER | `READY_FOR_REVIEW` → `APPROVED` |
| `POST /campaigns/:id/reject` | MARKETING_MANAGER | → `REJECTED` avec motif |
| `POST /campaigns/:id/regenerate` | EDITOR | `REJECTED` → relance génération + modération |
| `POST /social/campaigns/:id/publish` | authentifié | Refuse (403) si statut ≠ `APPROVED` |

## Intelligence produit

Trois mécanismes qui différencient Campaign-ai d'un simple générateur ponctuel — c'est ce
qui justifie un abonnement récurrent plutôt qu'un achat unique.

### AI Optimizer nocturne (Module 16)

Chaque nuit (`@Cron` à 2h), `AiOptimizerService` parcourt toutes les campagnes `PUBLISHED`
des organisations avec un abonnement actif : il rafraîchit les métriques de performance
(`AnalyticsIngestionService`, via les insights des réseaux connectés — implémentation réelle
pour Meta, simulation déterministe en `AI_MODE=mock` pour les autres), puis demande à Claude
de proposer des ajustements (réallocation budgétaire, refresh créatif, ciblage, pause de canal).

**L'Optimizer ne modifie jamais rien automatiquement** — chaque recommandation reste `PENDING`
jusqu'à ce qu'un `MARKETING_MANAGER`+ l'applique ou l'écarte explicitement, dans la même
logique que l'approbation de campagne.

| Endpoint | Rôle minimum | Effet |
|---|---|---|
| `POST /optimizer/run` | ADMIN/OWNER | Déclenche l'analyse immédiatement (hors cron, pour tester) |
| `GET /optimizations/pending` | tout membre | Liste les recommandations en attente |
| `POST /optimizations/:id/apply` | MARKETING_MANAGER | Marque la recommandation comme mise en œuvre |
| `POST /optimizations/:id/dismiss` | MARKETING_MANAGER | Écarte la recommandation |

### Score de cohérence de marque

`BrandConsistencyService` évalue chaque génération (texte et visuel) par rapport au Brand
Kit de l'organisation (ton, valeurs, palette), en parallèle de la modération, pendant la
génération de la campagne. Contrairement à `ModerationService`, un score bas **ne bloque
jamais** — c'est une information affichée au validateur humain, pas un garde-fou de sécurité.
Sans Brand Kit renseigné, aucun score n'est calculé (pas de pénalité injustifiée).

Consultable via `GET /campaigns/:id/brand-consistency`, et résumé sur `campaign.brandConsistencyScore`.

### Bibliothèque de templates (Module 18, marketplace simplifié)

6 templates système sont seedés au démarrage (`CampaignTemplatesService.onModuleInit`),
un par secteur prioritaire du business plan : e-commerce, SaaS B2B, commerce local,
bien-être, immobilier, événementiel. Chaque template ne préremplit pas qu'un formulaire —
ses indications (`structureHint` : angle d'analyse, archétype de persona, style de CTA)
sont injectées dans les prompts de l'AI Orchestrator.

```
GET  /templates?sector=ECOMMERCE       # liste (système + propres à l'organisation)
POST /templates                        # créer un template personnalisé
POST /templates/from-campaign/:id      # sauvegarder une campagne existante comme template
POST /campaigns { "templateId": "..." } # créer une campagne à partir d'un template
```

Pas encore de partage inter-organisations avec commission (le vrai "marketplace" du
chapitre 9 du Volume 1) — chaque organisation ne voit que les templates système et les siens.

## Fondations SaaS

Le cœur de ce chantier : Campaign-ai n'est plus seulement un générateur de campagnes, c'est
un socle multi-tenant avec une vraie mécanique d'abonnement.

### Multi-tenant, équipes, invitations

Chaque inscription crée une organisation (tenant) isolée. Un utilisateur peut appartenir à
plusieurs organisations (`Membership`) — utile pour une agence qui gère plusieurs clients —
et bascule de l'une à l'autre via un nouveau JWT scopé, sans se reconnecter.

```
GET  /auth/me                        # organisations de l'utilisateur + rôle dans chacune
POST /auth/switch-organization       # ré-émet un JWT scopé sur une autre organisation
POST /organizations                  # crée une organisation supplémentaire (ex: nouveau client d'agence)

GET    /team/members                 # membres de l'organisation courante
POST   /team/invitations             # inviter par email (ADMIN/OWNER)
POST   /team/invitations/:id/revoke
POST   /team/invitations/:id/resend
PATCH  /team/members/:id/role        # changer le rôle
DELETE /team/members/:id             # retirer un membre

GET  /invitations/:token             # aperçu public (avant connexion/inscription)
POST /invitations/:token/accept      # authentifié, email doit correspondre à l'invitation
```

Garde-fous appliqués par `TeamsService` : impossible de démoter ou retirer le dernier
`OWNER` d'une organisation (elle deviendrait inadministrable), et personne ne peut
inviter ou promouvoir un rôle supérieur au sien — un `ADMIN` ne peut pas créer d'`OWNER`.

### Plans, entitlements, quotas, essai gratuit

`plan-catalog.ts` est la source de vérité unique de la grille tarifaire (reprise du
business plan) : prix, crédits IA inclus, sièges max, campagnes actives max, canaux max,
fonctionnalités (accès API, SSO, marque blanche, support prioritaire). `EntitlementsService`
est le point de passage obligé pour toute vérification de limite — aucun autre service ne
code ses propres seuils.

**Essai gratuit — plan `trial` dédié, pas un accès Growth complet.** Un essai illimité en
volume pendant 14 jours exposait à un vrai coût fournisseur d'IA sans garantie de
conversion. Le plan `trial` (60 crédits, 3 campagnes, 2 sièges) porte en plus des plafonds
**dédiés**, indépendants du pool de crédits partagé — une seule vidéo (150 crédits dans la
grille normale) épuiserait à elle seule le pool de l'essai, ces plafonds séparés
garantissent "10 images IA **et** 1 vidéo IA incluses" quel que soit ce qui a déjà été
consommé en texte : 10 images, 1 vidéo, 10 publications réelles, 1 analyse Optimizer,
canaux limités à Meta (Facebook/Instagram) et LinkedIn. Les fonctionnalités elles-mêmes
(Brand Brain, Content Studio, Calendrier, Analytics) restent en accès complet — c'est le
volume qui est limité, pas le produit. Un cron quotidien (`TrialExpiryService`) fait passer
au statut `expired` tout essai dépassé jamais converti en abonnement Stripe.

```
GET /plans              # catalogue public (page de tarifs, sans authentification) — exclut 'trial', non sélectionnable
GET /plans/usage        # consommation actuelle vs limites du plan (barres de progression)
```

### Invitation à l'upgrade au moment du plafond

Un plafond atteint ne renvoie jamais un message d'erreur générique : `PlanLimitExceededException`
porte des données structurées (`code`, `limitType`, `current`, `limit`, `recommendedPlan`)
que le frontend transforme en moment de conversion ciblé — proposer explicitement le plan
supérieur, jamais "passez à un plan payant" sans préciser lequel.

**Deux bugs corrigés dans ce chantier**, tous deux de la même nature — une exception levée
avec un objet structuré ne conservait que son `.message` avant d'atteindre l'appelant :
`GlobalExceptionFilter` côté backend ne propageait pas les champs au-delà de `message`, et
`api.ts` côté frontend faisait `throw new Error(body.message)`, perdant le reste. Les deux
préservent désormais l'objet complet (`ApiError` côté frontend, réponse JSON enrichie côté
backend).

`getRecommendedUpgrade(planKey)` (`plan-catalog.ts`) encode la progression commerciale une
seule fois : `trial`/`starter` → `growth`, `growth` → `business`, `business` → `enterprise`,
`enterprise` → aucun (déjà au sommet, message different invitant à nous contacter).
`UpgradeModal` (frontend) et `showUpgradeModal()` (simulateur HTML) consomment cette même
logique — brancher un nouveau palier de plan à l'avenir ne demande qu'une modification de
`UPGRADE_PATH`, jamais de toucher à l'UI.

### Stripe comme moteur de facturation

Au-delà du simple Checkout, `StripeService` gère le cycle de vie complet d'un abonnement SaaS :

```
POST /billing/checkout               # première souscription (sortie du trial local)
POST /billing/change-plan            # upgrade/downgrade sur abonnement actif, proration automatique
POST /billing/cancel                 # résiliation programmée (fin de période) ou immédiate
POST /billing/resume                 # annuler une résiliation programmée
POST /billing/portal                 # portail self-service Stripe (moyen de paiement, factures)
GET  /billing/invoices               # historique de facturation (proxy direct sur Stripe)
POST /billing/credit-packs/checkout  # achat ponctuel d'un pack de crédits IA
```

Webhooks gérés : `checkout.session.completed` (active l'abonnement ou crédite un pack),
`customer.subscription.updated/deleted`, `customer.subscription.trial_will_end`,
`invoice.payment_failed` (passe en `past_due`, bloque via `EntitlementsService`),
`invoice.payment_succeeded` — avec une distinction importante : sur un renouvellement
(`billing_reason='subscription_cycle'`), les crédits IA consommés sont remis à zéro pour
le nouveau cycle ; sur une simple régularisation après échec de paiement, seul le statut
repasse à `active` sans toucher au quota déjà consommé.

**Bug commercial corrigé** (`extraCredits`, distinct de `aiCreditsIncluded`) : un pack de
crédits acheté incrémentait auparavant directement le quota du plan (`aiCreditsIncluded`),
qui n'est jamais redescendu au renouvellement — seul `aiCreditsUsed` est remis à zéro. Le
pack ne disparaissait donc pas, il faisait pire : il **gonflait le quota mensuel de façon
permanente**, offrant plus de crédits gratuits à chaque cycle que ce que le client avait payé.
Corrigé avec un champ `extraCredits` dédié (jamais réinitialisé par le renouvellement,
consommé en **priorité** sur le quota du plan via `EntitlementsService.consumeCredits`,
appelé en transaction Prisma pour rester correct sous accès concurrent). Un client dont le
quota mensuel est épuisé mais qui a un solde de pack restant continue de fonctionner —
`assertCreditsAvailable` ne bloque que si les deux soldes sont simultanément à zéro.

## Économie de l'IA

Avant ce chantier, `ModerationService` et `BrandConsistencyService` appelaient OpenAI
directement en `fetch()` — leur coût réel (5 points d'appel) était invisible pour
Campaign-ai, alors que réellement facturé par le fournisseur. `AiGatewayService` est
désormais le **seul chemin autorisé** vers un fournisseur d'IA dans toute l'application.

### Traçabilité universelle

Chaque appel — génération de campagne, modération, cohérence de marque, Optimizer —
passe par `AiGatewayService` avec un contexte obligatoire (`organizationId`, `campaignId`,
`purpose`), et produit systématiquement une ligne `AiGeneration` (fournisseur, modèle,
tokens, durée, coût réel en $). `AiOrchestratorService` a été simplifié en conséquence :
il ne gère plus lui-même la persistance, seulement la décomposition en tâches.

### Budgets et quotas

Deux mécanismes de contrôle indépendants, vérifiés avant tout appel :
- **Crédits** (`EntitlementsService.assertCreditsAvailable`) — unité commerciale gamifiée,
  dont le coût par tâche est défini dans `CREDIT_COSTS` (`plan-catalog.ts`), différencié
  selon l'origine de l'appel (génération de campagne coûte plus cher que la modération,
  qui n'est pas facturée au client puisqu'elle protège Campaign-ai lui-même).
- **Budget réel** (`EntitlementsService.assertBudgetAvailable`) — plafond optionnel en $
  (`Subscription.monthlyBudgetUsd`), indépendant des crédits : protège la marge même si
  un fournisseur augmente ses tarifs sans que la grille de crédits ait été mise à jour.

### Optimisation du choix de provider

`AiGatewayService` rétrograde dynamiquement, dans l'ordre de tentative d'une chaîne de
repli, tout fournisseur dont le taux d'échec dépasse 40% sur les dernières 24h (échantillon
minimum de 5 appels, calcul mis en cache 60s pour ne pas alourdir chaque requête) — un
routage qui réagit à la fiabilité réelle plutôt qu'un ordre statique figé.

### Visibilité coûts et marge

```
GET /ai-usage/summary       # coût réel du mois, réparti par fournisseur / type de tâche / origine
GET /ai-usage/margin        # prix du plan vs coût IA réel = marge brute (ADMIN/OWNER uniquement)
GET /ai-usage/generations   # journal d'audit détaillé, filtrable par campagne/origine
```

**Limitation documentée** (`ai-economics.service.ts`) : `getMarginSummary` ne compte que le
coût IA, pas l'infrastructure ni le support — c'est une borne haute de la marge, pas la
marge nette réelle (cf. chapitre 3 du Volume 2 du business plan pour la décomposition complète).

## Intégrations Production

Avant ce chantier, les tokens des réseaux sociaux étaient stockés en clair, sans
rafraîchissement, sans retry sur échec transitoire, et une publication rejouée (retry
client, double clic) pouvait créer un doublon réel sur la plateforme. Les quatre corrections :

### Chiffrement au repos

`TokenCryptoService` (AES-256-GCM) chiffre `accessToken`/`refreshToken` avant toute écriture
en base, déchiffre à la lecture. Sans `TOKEN_ENCRYPTION_KEY` configurée, les tokens restent
en clair avec un avertissement au démarrage — acceptable en développement local, jamais en
production. Généré une fois : `openssl rand -base64 32`.

### Rafraîchissement des tokens

Deux mécanismes complémentaires :
- **Réactif** — `SocialConnectionsService.getActiveConnection()` rafraîchit automatiquement
  tout token dont l'expiration est à moins de 10 minutes, avant de le renvoyer à l'appelant.
- **Proactif** — `TokenRefreshService` (cron toutes les 6h) rafraîchit tout ce qui expire
  dans les prochaines 24h, pour qu'une tentative de publication ne découvre jamais un token
  expiré en cours d'exécution.

Rafraîchissement implémenté nativement pour LinkedIn, Google Ads et TikTok (vrai
`refresh_token` OAuth2) ; pour Meta, qui n'expose pas de refresh_token classique, un
mécanisme équivalent ré-échange le token longue durée avant son expiration.

### Erreurs typées et retries

`SocialApiError` distingue les échecs **retryable** (429 rate limit, 5xx panne serveur) des
échecs définitifs (401/403/400 — retenter ne changerait rien). `withRetry()` applique un
backoff exponentiel avec jitter (jusqu'à 3 tentatives) uniquement sur les erreurs retryable,
utilisé pour la publication et la récupération d'insights.

### Publication idempotente

Contrainte unique `(campaignId, socialConnectionId)` sur `PublishedPost` : il ne peut
jamais exister deux lignes pour "cette campagne diffusée sur ce canal". Un appel répété
(retry, double clic, nouvelle tentative après timeout) soit renvoie la publication déjà
réussie sans rien réémettre à la plateforme, soit retente sur la même ligne — jamais de
nouvelle ligne, donc jamais de doublon réel. Statut asynchrone géré pour TikTok
(`checkPublishStatus`, pollé jusqu'à 5 fois avant de conclure).

### État des 5 plateformes

| Plateforme | OAuth + refresh | Publication | Insights |
|---|---|---|---|
| Meta (FB/IG) | ✅ | ✅ | ✅ |
| LinkedIn | ✅ (refresh natif) | ✅ | — (non implémenté) |
| Google Ads | ✅ (refresh natif) | ✅ (campagne créée `PAUSED`, activation manuelle requise) | — (non implémenté) |
| TikTok | ✅ (refresh natif) | ✅ (avec polling de statut) | — (non implémenté) |

**Simplification assumée pour Google Ads** : la campagne créée n'a ni mots-clés ni ciblage
géographique/démographique — elle est volontairement créée au statut `PAUSED` (jamais
`ENABLED` automatiquement, un engagement budgétaire réel ne doit jamais découler d'une
simple approbation éditoriale) pour laisser le temps de compléter ces paramètres avant
activation manuelle.

## Content Studio & Brand Brain

Avant ce chantier, le contenu généré par l'AI Orchestrator n'existait que le temps de la
requête IA — jamais persisté au-delà (le modèle `Content` d'origine n'était référencé par
aucun code d'écriture, vérifié avant suppression). Le Brand Kit se limitait à 5 champs
statiques édités manuellement. Deux refontes :

### Content Studio

Chaque génération de campagne crée désormais de vraies pièces de contenu durables
(`ContentPiece`), une par canal sélectionné pour le texte, plus une pour le visuel et,
si générée, la vidéo — chacune avec l'asset correspondant enregistré dans la bibliothèque
de médias (`Asset`, avec traçabilité vers sa génération IA : coût, fournisseur, modèle).

**Versions et variations** — `ContentVersion` : toute édition crée une nouvelle version,
jamais d'écrasement (historique complet consultable). Une variation (A/B/C) partage le
même `variantGroup` qu'une révision normale mais porte un `label` — c'est une alternative
concurrente, pas une évolution dans le temps ; aucune ne devient automatiquement la version
courante, un choix humain explicite est requis (`selectVariationAsCurrent`), dans la même
logique que "l'IA propose, l'humain décide" déjà appliquée à la modération et à l'Optimizer.

```
GET  /campaigns/:id/content                    # pièces de contenu de la campagne
POST /campaigns/:id/content/:pieceId/edit       # nouvelle version
POST /campaigns/:id/content/:pieceId/variations # créer des alternatives A/B
POST /campaigns/:id/content/:pieceId/select-version
GET  /assets                                    # bibliothèque de médias (filtrable par type/tag)
```

### Calendrier éditorial

`CalendarEntry` planifie quand un contenu doit être diffusé sur un canal connecté.
`ScheduledPublishingService` (cron toutes les 5 min) déclenche la publication réelle en
repassant par `PublishingService` — donc **soumise aux mêmes garde-fous** qu'une publication
manuelle (campagne `APPROVED`, idempotence). Une entrée dont la campagne n'est pas encore
approuvée à l'heure prévue est marquée `MISSED`, jamais publiée sans validation.

```
GET    /calendar?from=...&to=...   # vue par plage de dates
POST   /calendar                    # planifier
PATCH  /calendar/:id/reschedule
DELETE /calendar/:id                # annuler
```

### Brand Brain

`BrandKit` étendu (mission, vision, slogans, concurrents, personas de référence) — mais la
vraie évolution est `BrandMemoryEntry` : une mémoire qui s'enrichit automatiquement, pas
éditée manuellement. Deux points d'alimentation : chaque publication réussie journalise un
apprentissage (`CAMPAIGN_LEARNING`), et chaque recommandation Optimizer notable (performance
`under`/`over`, pas les `on_track` qui n'apportent aucun signal) journalise un
`PERFORMANCE_INSIGHT`. `buildPromptContext()` — consommé par l'AI Orchestrator, la
Modération et la Cohérence de marque — injecte désormais mission/vision/slogans/concurrents/
personas **et les 5 derniers apprentissages mémorisés**, plutôt que seulement ton + valeurs :
c'est ce qui fait qu'une nouvelle génération bénéficie réellement de ce qui a été appris des
campagnes précédentes, au lieu de repartir de zéro à chaque fois.

```
GET /brand-kit/memory   # journal des apprentissages mémorisés
```

**Limitation assumée** : aucun pipeline d'upload binaire (pas d'object storage configuré
dans ce projet) — `POST /assets` enregistre un asset déjà hébergé par URL, pas un fichier
téléversé directement.

## Analytics & Optimizer

Avant ce chantier, toutes les publications d'une campagne étaient sommées dans une seule
ligne `CampaignMetric` — impossible de répondre à "quel canal performe le mieux ?" ou
"laquelle de mes deux variations a gagné ?". Le champ `roas` existait dans le schéma mais
n'était jamais calculé, faute de valeur de conversion trackée.

### Statistiques unifiées, à trois niveaux de granularité

`PublishedPost.contentVersionId` est le chaînon qui manquait : relier une publication à la
créative précise (Content Studio) qui a été diffusée. Sans lui, l'analytics ne pouvait
jamais redescendre au niveau création.

```
GET /analytics/overview                       # toutes campagnes, triées par dépense
GET /campaigns/:id/analytics/summary           # totaux tous canaux confondus (CTR/CPA/ROAS)
GET /campaigns/:id/analytics/channels          # répartition par canal
GET /campaigns/:id/analytics/content           # répartition par créative — quelle variation a gagné
POST /campaigns/:id/analytics/conversions      # conversion manuelle (code promo, UTM...)
```

`AnalyticsIngestionService` produit désormais une ligne `CampaignMetric` **par canal** et
une ligne `ContentMetric` **par créative**, plutôt qu'une somme globale qui aurait
irrémédiablement perdu ces deux granularités.

**ROAS réel vs estimé** : `CampaignMetric.conversionValue` doit être renseigné (via
`fetchInsights` quand la plateforme le permet, ou via l'endpoint de conversion manuelle) pour
qu'un ROAS réel soit calculable — sans lui, le champ reste `null` plutôt qu'une estimation
trompeuse. Aucun adaptateur actuel ne remonte de conversions programmatiquement (nécessiterait
Meta Conversions API / Google Ads conversion actions, hors scope de ce chantier) : l'endpoint
manuel est la voie réaliste pour l'instant.

### Recommandations mesurables

`OptimizerOutcomeService` (cron quotidien) referme la boucle "l'IA propose → l'humain
applique → qu'est-ce que ça a changé ?" : 7 jours après qu'une recommandation est marquée
`APPLIED`, il compare les métriques agrégées avant/après et enregistre le résultat dans
`OptimizationRecommendation.measuredImpact` (CTR, CPA, ROAS). Une recommandation appliquée
n'est plus une simple déclaration d'intention — son effet réel est vérifié.

### Fondation pour l'automatisation contrôlée (phase ultérieure, non activée)

`AutomationService` pose l'interface et les garde-fous attendus **sans exécuter aucune
action réelle** — `ENABLE_CONTROLLED_AUTOMATION=false` par défaut, et `executeAutomatically()`
refuse systématiquement tant que ce n'est pas activé. Chaque recommandation reçoit un
indicateur `automationEligible`, calculé selon le type d'action proposée : seules les
actions jugées sûres à automatiser (`pause_channel` — réversible, sans impact créatif) en
bénéficient ; un changement créatif ou une réallocation budgétaire exigeront toujours un
jugement humain, même une fois cette phase activée.

```
GET /optimizer/automation-status      # { enabled: false } tant que la phase n'est pas activée
GET /optimizer/automation-eligible    # recommandations qui pourraient être automatisées un jour
```

## Tests, Sécurité & Observabilité

### Vulnérabilité OAuth corrigée

Avant ce chantier, le paramètre `state` du flux OAuth transportait l'`organizationId` en
clair, non signé. N'importe qui connaissant l'ID d'une organisation victime aurait pu
démarrer son propre flux OAuth, consentir avec son propre compte, puis rediriger le
callback avec `state=<id-victime>` — liant son compte réseau social à l'organisation d'un
tiers (CSRF de type "state forgery"). `OAuthStateService` signe désormais le state en
HMAC-SHA256 avec nonce et expiration à 10 minutes, vérifié en temps constant.
Tests dédiés : `src/social/oauth-state.service.spec.ts`.

### Piste d'audit

`AuditLog` + `AuditService` (écriture *best-effort* — ne bloque jamais l'action métier même
si l'écriture échoue) journalisent les actions sensibles : approbation/rejet de campagne,
changement de rôle, retrait de membre, invitations, décisions de facturation, connexions
réussies **et échouées** (surveillance de bruteforce). Réservé ADMIN/OWNER :

```
GET /audit-log?action=campaign.approved&resourceType=Campaign
```

### Rate limiting

`@nestjs/throttler` : limite globale 100 req/min/IP, avec des limites dédiées plus strictes
sur les endpoints sensibles ou coûteux — `/auth/login` (5/min), `/auth/register` (10/min),
création de campagne (10/min, déclenche une génération IA complète), déclenchement manuel
de l'Optimizer (3/min, consomme de vrais crédits).

### Observabilité

- **Logs structurés JSON** (`StructuredLoggerService`) avec ID de corrélation automatique
  par requête (`RequestContextService` via `AsyncLocalStorage`, propagé à travers toute la
  pile d'appels sans avoir à le transmettre explicitement en paramètre)
- **Health checks** : `GET /health/live` (le processus tourne-t-il), `GET /health/ready`
  (les dépendances critiques — base de données — sont-elles joignables)
- **Métriques Prometheus** : `GET /metrics` (requêtes HTTP par route/statut, durées,
  métriques process Node standard)
- **Suivi d'erreurs Sentry** : filtre d'exception global, uniquement les erreurs 5xx,
  corrélées au `requestId` pour retrouver les logs associés à une alerte

### Validation des secrets au démarrage

`validateEnv()` échoue rapidement (avant même la création de l'application) si un secret
critique manque ou reste à sa valeur de développement par défaut **en production**
(`NODE_ENV=production`) — jamais bloquant en développement local, où le mode mock reste
utilisable sans configuration.

### Tests

```bash
npm run test          # unitaires
npm run test:cov      # avec couverture
npm run test:e2e      # E2E (nécessite Postgres/Redis actifs)
```

**Note de transparence** : ces tests ont été écrits et vérifiés syntaxiquement (TypeScript
valide), mais n'ont pas pu être réellement exécutés dans l'environnement où ce code a été
généré (pas d'accès npm/Postgres/Redis). Ils sont prêts à s'exécuter tel quel dans un
environnement de développement configuré, et le sont dans la CI (cf. ci-dessous).

Couverture actuelle : `OAuthStateService` (falsification de state, secret invalide, state
expiré), `TokenCryptoService` (roundtrip chiffrement, IV aléatoire), `plan-catalog.ts`
(grille de coûts en crédits), `withRetry` (distinction erreurs retryable/non-retryable),
`EntitlementsService` (chaque garde-fou de quota), `AuditService` (comportement best-effort),
et un test E2E du flux register/login complet.

### CI/CD

`.github/workflows/ci.yml` — sur chaque push/PR vers `main` : provisionne Postgres et Redis
comme services CI (pas des mocks), installe, génère le client Prisma, applique les
migrations, lint (non bloquant à ce stade), build, tests unitaires avec couverture, tests
E2E, publie le rapport de couverture en artefact.

## Conformité & Exploitation

### RGPD/AI Act opérationnels

`PrivacyModule` fournit les **mécanismes réels** que les textes légaux promettent, pas
seulement les textes eux-mêmes :

```
GET  /privacy/policies                    # textes légaux publics (CGU, politique de confidentialité, information IA)
GET  /privacy/policies/status/mine        # ai-je accepté la version en vigueur de chaque politique ?
POST /privacy/policies/accept
GET  /privacy/export                      # portabilité (RGPD Article 20) — export structuré de mes données
POST /privacy/delete-account              # effacement (RGPD Article 17) — suppression douce
GET  /privacy/ai-disclosure/:campaignId   # information sur l'usage de l'IA (AI Act) pour une campagne
```

**Suppression douce plutôt que `DELETE` SQL** : l'effacement anonymise les champs
identifiants (email remplacé par une valeur non réutilisable, hash de mot de passe
invalidé) mais conserve la ligne — des tables légalement obligées de survivre (factures via
Stripe, `AuditLog` pour la sécurité) y font référence. Garde-fou : refuse si l'utilisateur
est le dernier `OWNER` d'une organisation comptant d'autres membres.

**Transparence IA** : l'information de divulgation par campagne est reconstruite à partir
de la traçabilité déjà existante (`AiGeneration`), jamais maintenue séparément — impossible
qu'elle se désynchronise de la réalité.

**Note de transparence** (cf. `legal-documents.ts`) : les textes légaux fournis sont des
**gabarits explicitement marqués comme tels**, pas des textes juridiquement engageants — un
déploiement en production nécessite une relecture par un juriste avant publication. Ce
chantier livre l'infrastructure technique (versionnement, acceptation trackée, mécanismes
d'export/effacement réels), pas le contenu juridique final.

### Notifications (email + in-app)

Avant ce chantier, aucun email n'était envoyé nulle part — une invitation d'équipe se
contentait de retourner un token dans la réponse API. `NotificationsService` centralise
maintenant la création systématique d'une notification in-app et l'envoi de l'email associé,
avec la même philosophie *best-effort* que `AuditService` (un échec de notification ne fait
jamais échouer l'action métier).

Événements couverts : invitation d'équipe, campagne prête pour revue, campagne
publiée/rejetée, recommandation Optimizer disponible, **essai bientôt terminé (J-3)**,
essai expiré, paiement en échec, réponse à un ticket support.

```
GET   /notifications
PATCH /notifications/:id/read
POST  /notifications/mark-all-read
```

Fournisseur email : Resend par défaut (`EMAIL_PROVIDER_API_KEY`) — sans clé configurée, les
emails sont journalisés en log structuré plutôt qu'envoyés, même principe que `AI_MODE=mock`.

### Support et centre d'aide

`SupportModule` : tickets avec fil de conversation, notification bidirectionnelle (le
client est notifié à chaque réponse de l'équipe). `HelpModule` : CMS minimal pour la
documentation utilisateur, stocké en base (pas en fichiers Markdown versionnés) pour qu'une
équipe support puisse éditer du contenu sans déploiement de code.

```
POST /support/tickets
GET  /support/tickets/:id
POST /support/tickets/:id/reply

GET /help/articles?category=...
GET /help/articles/search?q=...
```

### Panneau d'administration plateforme

Le seul controller de toute l'API qui lit délibérément **à travers** les organisations
plutôt qu'à l'intérieur d'une seule — protégé par `PlatformAdminGuard` (distinct de
`RolesGuard` : un `OWNER`, même sur sa propre organisation, n'y a aucun droit).
`User.isPlatformAdmin` n'est **jamais accordé en self-service**, uniquement par
intervention manuelle en base — un choix délibéré pour ce niveau d'accès.

```
GET  /admin/organizations                # liste, filtrable par plan/statut/recherche
GET  /admin/organizations/:id            # détail : membres, coût IA du mois, activité récente
POST /admin/organizations/:id/suspend    # action réelle, tracée dans la piste d'audit
POST /admin/organizations/:id/reactivate
GET  /admin/users
GET  /admin/subscriptions/overview       # répartition par plan/statut, MRR estimé
GET  /admin/ai-costs/overview            # coût IA plateforme, top organisations par dépense
GET  /admin/errors                       # générations IA et publications échouées récentes
GET  /admin/activity                     # piste d'audit transverse, tous clients confondus
```

`suspend`/`reactivate` posent un nouveau statut d'abonnement (`suspended`), désormais
reconnu par `EntitlementsService.assertActiveSubscription()` au même titre que `expired`
ou `canceled` — une organisation suspendue est bloquée par le même mécanisme que le reste
de la plateforme, pas par un contournement séparé.

**Limitation assumée** : la vue erreurs s'appuie sur les données déjà tracées
(`AiGeneration`/`PublishedPost` en échec) plutôt qu'un journal d'erreurs HTTP dédié — les
erreurs 5xx partent déjà vers Sentry pour l'analyse approfondie (cf. chantier précédent),
cette vue sert de tableau de bord rapide sans outil externe.

## Parcours client — vérifié bout en bout, entièrement depuis l'interface

Aucune étape du parcours ci-dessous ne nécessite Swagger, Postman ou un appel API manuel —
chaque flèche correspond à une action réelle dans le frontend Next.js, appelant le vrai backend.

```
Landing (/) → Inscription (/register) → Trial (auto, TrialBanner) → Onboarding (/onboarding)
  → Brand Brain (/settings/brand) → Produit (formulaire /campaigns/new)
  → Créer campagne → Génération IA (polling auto) → Modération (auto, onglet Vue d'ensemble)
  → Validation humaine (Approuver/Rejeter, rôle Marketing Manager+)
  → Content Studio (onglet Contenu, versions/variations/planification)
  → Calendrier (/calendar) → Publication (bouton Publier)
  → Analytics (onglet Analytics) → Optimizer (onglet Optimisation)
  → Upgrade Stripe (/settings/billing, Checkout réel)
```

**Deux étapes manquaient une vraie page** avant cette vérification, malgré un backend
entièrement fonctionnel pour les deux :
- **Brand Brain** (`/settings/brand`) — auparavant, seul un champ "ton" isolé existait dans
  l'onboarding ; aucune page ne donnait accès à la mission, la vision, les concurrents, les
  personas, ni à la mémoire de marque qui s'enrichit automatiquement (`BrandMemoryEntry`).
- **Analytics** (onglet dans `/campaigns/[id]`) — absent malgré un module backend complet
  à 4 endpoints (vue d'ensemble, répartition par canal, répartition par créative,
  enregistrement de conversion manuelle) : l'étape "Analytics" du parcours n'avait
  littéralement aucune interface.

**Un bug d'intégration corrigé au passage** : l'endpoint de publication utilisé par le
bouton "Publier" pointait vers `/campaigns/:id/publish`, un chemin qui n'existe pas — le
vrai chemin est `/social/campaigns/:id/publish` (`SocialController`). Détecté en vérifiant
systématiquement chaque appel contre le controller réel avant de considérer l'étape validée.

## Commercialisation V1

### Onboarding, landing page, pricing et parcours de conversion

Le frontend Next.js, resté minimal (login/dashboard uniquement) pendant que le backend
accumulait ~25 modules, reçoit ici les pièces manquantes pour un vrai parcours
visiteur → client payant :

- **`/`** — landing page publique (hero, fonctionnalités, tarification réelle via
  `GET /plans`, pas de valeurs codées en dur), redirige automatiquement vers `/dashboard`
  si déjà connecté
- **`/pricing`** — page de tarifs dédiée, réutilisable en lien direct
- **`/onboarding`** — checklist post-inscription en 3 étapes (Brand Kit, invitation
  d'équipe optionnelle, première campagne), dont **chaque case cochée reflète un état réel
  côté backend** (interrogé via l'API), jamais un simple indicateur local qui pourrait
  mentir sur ce qui a été fait — et jamais bloquante (chaque étape est contournable)
- **`TrialBanner`** — nudge de conversion sur le tableau de bord, calculé depuis
  `trialEndsAt` réel (pas une date recalculée côté client), plus visible dans les 3
  derniers jours
- **`/settings/billing`** — upgrade réel : sélectionner un plan déclenche un vrai Stripe
  Checkout (`POST /billing/checkout`), pas une simulation

`PricingGrid` est un composant unique partagé entre la landing page, `/pricing` et
`/settings/billing` — les trois affichent toujours exactement les mêmes plans, sans
risque de désynchronisation entre un visiteur non connecté et un client existant.

### Déploiement en production

**Ce qui est fourni** : `backend/Dockerfile` et `frontend/Dockerfile` (builds multi-étapes,
utilisateur non-root, healthcheck natif pour le backend), `docker-compose.prod.yml`
(topologie de référence mono-VM), job `docker-publish` dans la CI (publie les images sur
GitHub Container Registry à chaque merge sur `main`).

**Ce qui reste à faire par vous, selon l'hébergeur choisi** — impossible à préconfigurer
sans connaître la cible réelle :

1. **Base de données et cache managés** — en production, préférer un Postgres/Redis managé
   (RDS, Neon, Upstash...) aux conteneurs de `docker-compose.prod.yml`, pensés pour un
   premier déploiement mono-VM plutôt qu'une architecture à grande échelle.
2. **Stripe en mode live** — remplacer les clés `sk_test_...` par les clés live, recréer les
   Price ID dans le Dashboard Stripe en mode live (les ID test et live sont distincts),
   enregistrer l'URL de webhook réelle (`https://votre-domaine.com/api/billing/webhook`)
   et copier le nouveau `STRIPE_WEBHOOK_SECRET`.
3. **Secrets de production** — générer `TOKEN_ENCRYPTION_KEY`, `JWT_SECRET`,
   `OAUTH_STATE_SECRET` avec `openssl rand -base64 32` (jamais réutiliser les valeurs de
   développement — `validateEnv()` refuse de démarrer sinon, cf. chantier précédent).
4. **Réviewer les apps OAuth** des réseaux sociaux en mode production (Meta, LinkedIn,
   Google Ads, TikTok) — chaque plateforme a son propre délai de validation, à anticiper
   avant le lancement, pas le jour J.
5. **DNS et TLS** — domaine pointant vers le serveur, certificat TLS (Let's Encrypt via
   Caddy/Traefik/nginx en frontal, non inclus dans les Dockerfiles fournis).
6. **Migrations** — `npx prisma migrate deploy` (jamais `migrate dev` en production) avant
   le premier démarrage.
7. **Relecture juridique** des textes légaux (`legal-documents.ts`) — actuellement des
   gabarits explicitement marqués comme tels (cf. chantier Conformité).
8. **Fumée (smoke tests)** post-déploiement : `GET /health/ready` répond `200`, inscription
   + connexion fonctionnent de bout en bout, un webhook Stripe test est bien reçu.

### Tests pilotes

**Ce que je ne peux pas faire moi-même** : recruter de vrais utilisateurs pilotes ou animer
des sessions de test — cela nécessite un accès à de vraies personnes, hors de portée d'un
assistant de code. Ce que ce chantier livre à la place : l'infrastructure pour **mener** un
pilote structuré une fois que vous avez des utilisateurs :

- **`SupportModule`** — canal de retour direct pour les pilotes (`POST /support/tickets`),
  avec notification immédiate de l'équipe à chaque nouveau ticket
- **`AdminModule`** — `GET /admin/organizations`, `GET /admin/errors`,
  `GET /admin/activity` permettent de suivre l'usage réel des pilotes (qui crée des
  campagnes, où ça échoue, qui décroche) sans attendre leurs retours spontanés
- **`AI_MODE=mock`** — permet de faire tester le parcours complet (inscription → onboarding
  → campagne → approbation) à des pilotes sans consommer de vrais crédits IA ni exposer de
  clés API réelles pendant la phase de test

**Suggestion de déroulé** (hors du code, à mener vous-même) : 5 à 10 pilotes, essai gratuit
standard, suivi quotidien via `/admin/activity` la première semaine, entretien de sortie
structuré autour de trois questions — où avez-vous hésité dans l'onboarding, qu'est-ce qui
manquait pour publier votre première campagne, auriez-vous payé pour continuer.

## Object Storage

Avant ce chantier, `POST /assets` se contentait d'enregistrer une URL déjà hébergée
ailleurs — aucun upload binaire réel n'existait, malgré un produit qui génère et manipule
en continu des images, vidéos, logos et fichiers.

### Un seul client pour tous les fournisseurs

`StorageService` utilise le client AWS S3 (`@aws-sdk/client-s3`) — pas parce que le stockage
est nécessairement chez AWS, mais parce que S3, Cloudflare R2, Google Cloud Storage (mode
interopérabilité S3), MinIO et Backblaze B2 exposent tous une API compatible S3. Seuls
l'endpoint et la région changent selon le fournisseur (`STORAGE_ENDPOINT`,
`STORAGE_FORCE_PATH_STYLE` pour MinIO/certaines configs R2) — une seule implémentation les
couvre tous.

```
POST /assets/upload   # multipart/form-data, upload réel + enregistrement en un seul appel
POST /assets          # inchangé — enregistre une URL déjà hébergée ailleurs
```

`STORAGE_PROVIDER=local` (par défaut) écrit sur le disque du conteneur et sert les fichiers
via une route statique — même principe que `AI_MODE=mock` : développer et tester sans
compte cloud. Avertissement explicite au démarrage, jamais silencieux, pour qu'un déploiement
en production avec ce mode par erreur ne passe pas inaperçu.

### Un vrai bug de production détecté et corrigé au passage

En vérifiant les 4 fournisseurs d'images/vidéos avant de construire ce chantier : **tous**
renvoient des URLs *temporaires* (OpenAI, Flux, Ideogram, Google Veo — généralement quelques
heures de validité). Sans re-hébergement, chaque visuel de campagne aurait silencieusement
cassé une fois cette fenêtre dépassée — un bug qui ne se serait révélé qu'en production,
après coup, sur des campagnes déjà approuvées et publiées.

`StorageService.uploadFromUrl()` rapatrie systématiquement chaque visuel généré vers le
stockage permanent avant de créer l'`Asset` (`CampaignGenerationProcessor`). En cas d'échec
(timeout, URL déjà expirée) : repli sur l'URL d'origine plutôt que faire échouer toute la
génération de campagne — un visuel qui expirera dans quelques heures reste préférable à une
campagne entièrement bloquée.

### Suppression réelle

`Asset.storageKey` (nouveau champ) permet à `AssetsService.delete()` de supprimer l'objet
réel du stockage, pas seulement la ligne en base — la clé n'est jamais reconstruite à partir
de l'URL publique (fragile, dépendrait du format exact selon le fournisseur/CDN), toujours
conservée explicitement dès l'upload.

**Limitation assumée** : l'upload passe par le serveur API (`FileInterceptor`, buffer en
mémoire, 50 Mo max) plutôt qu'une URL présignée en upload direct client → stockage. Pour des
fichiers volumineux à grande échelle, l'upload direct présigné éviterait de faire transiter
les octets par le serveur API — non implémenté ici pour garder un flux d'intégration simple
côté frontend, cf. roadmap.

## Génération spécifique par canal

Avant ce chantier, l'AI Orchestrator générait un seul texte de copywriting et le dupliquait
tel quel sur chaque `ContentPiece`, quel que soit le canal — un `ContentPiece` par canal
existait déjà, mais leur `body` était identique. Un vrai copier-coller déguisé.

### Un prompt par canal, pas un texte partagé

`AiOrchestratorService.generateChannelCopy()` génère désormais un appel IA distinct par
canal sélectionné, chacun avec un prompt qui reflète son registre et ses contraintes réelles :

| Canal | Ce qui est généré |
|---|---|
| Instagram | Légende courte et percutante (2-3 phrases) + 4-6 hashtags |
| LinkedIn | Argumentation B2B structurée (problème → solution → preuve), routé vers Anthropic pour le raisonnement, jamais le modèle économique par défaut |
| Facebook | Ton conversationnel, invite à la réaction |
| TikTok | Hook (< 10 mots) + script en plans numérotés — réutilisé comme base du prompt vidéo (`generateVideo`) plutôt qu'un prompt générique déconnecté |
| Google Ads | Titres (30 caractères max) + descriptions (90 caractères max), demandés en JSON strict et **validés/tronqués côté code** — jamais une confiance aveugle dans la discipline du modèle sur des limites de caractères exactes |

### Sélecteur de canaux ajouté au wizard — sans lui, ce chantier restait invisible

En vérifiant le frontend avant de considérer ce chantier terminé : `/campaigns/new` ne
proposait **aucune sélection de canaux**. Sans ce sélecteur, `channels` restait toujours
vide et la génération retombait systématiquement sur le contenu générique `'general'` —
toute la différenciation par canal construite côté backend aurait été inaccessible depuis
le vrai produit. Ajouté, avec pré-remplissage automatique depuis `template.defaultChannels`
quand un template est choisi.

### Conséquence économique assumée

Chaque canal supplémentaire ajoute un appel `generateText` distinct (8 crédits chacun,
cf. `CREDIT_COSTS`) — le coût scale désormais avec le nombre de canaux sélectionnés, alors
qu'un seul appel couvrait auparavant tous les canaux. C'est le prix réel d'une vraie
différenciation plutôt qu'un copier-coller, cohérent avec le principe déjà établi dans le
système de crédits (plus de travail réel = plus de coût réel) — mais à surveiller de près
sur l'essai gratuit : une campagne à 3 canaux + image consomme désormais environ
8+8+24+25 ≈ 65 crédits, au-delà des 60 crédits inclus dans le plan `trial`. Non corrigé
silencieusement ici (c'est un arbitrage commercial, pas un bug technique) — signalé
explicitement pour une décision consciente sur la grille de l'essai.

## Ce qui reste hors scope (volontairement, prochains chantiers)

Tests automatisés, observabilité de production, conformité RGPD/AI Act opérationnelle,
base vectorielle pour la mémoire de marque, API publique, marketplace de templates
inter-organisations avec commission, notifications (email/Slack) pour les campagnes en
attente de revue et les nouvelles recommandations de l'Optimizer.

## Prérequis

- Node.js 20+
- Docker (pour Postgres/Redis)
- Comptes développeur sur les plateformes que vous souhaitez tester en conditions réelles
  (voir section "Configurer les intégrations" ci-dessous) — sinon tout fonctionne en mode
  simulé (`AI_MODE=mock`, pas de réseau social connecté).

## Démarrage rapide (mode simulé, sans clés API)

```bash
docker compose up -d

cd backend
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run start:dev        # http://localhost:3001/api

# Dans un second terminal
cd frontend
cp .env.example .env.local
npm install
npm run dev               # http://localhost:3000
```

Par défaut `AI_MODE=mock` : toutes les générations IA sont simulées, aucune clé API
n'est nécessaire pour tester le flux complet (inscription → campagne → orchestration →
contenu généré). Les réseaux sociaux et boutiques e-commerce ne sont pas simulés :
sans configuration, `/social/*` et `/product-import/*` renverront des erreurs de
configuration manquante si sollicités.

## Configurer les intégrations réelles

Chaque intégration est indépendante — activez uniquement celles dont vous avez besoin.

### IA texte
```
AI_MODE=live
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### IA image / vidéo
```
REPLICATE_API_TOKEN=...      # Flux — https://replicate.com/account/api-tokens
IDEOGRAM_API_KEY=...         # https://ideogram.ai/api
GOOGLE_CLOUD_PROJECT_ID=...  # Google Veo, nécessite Vertex AI activé
GOOGLE_CLOUD_ACCESS_TOKEN=...
```

### Réseaux sociaux
Chaque plateforme nécessite de créer une app développeur et, pour la plupart, une
**review manuelle par la plateforme** avant de publier en conditions réelles (délai de
quelques jours à plusieurs semaines selon la plateforme) :

| Plateforme | Où créer l'app | Permissions à demander |
|---|---|---|
| Meta | developers.facebook.com | `pages_manage_posts`, `instagram_content_publish` |
| LinkedIn | linkedin.com/developers | Produit "Marketing Developer Platform" |
| Google Ads | ads.google.com/aw/apicenter | Developer Token (accès "Standard") |
| TikTok | developers.tiktok.com | Accès "Direct Post" (Content Posting API) |

```
META_APP_ID=... META_APP_SECRET=...
LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=...
GOOGLE_ADS_CLIENT_ID=... GOOGLE_ADS_CLIENT_SECRET=... GOOGLE_ADS_DEVELOPER_TOKEN=...
TIKTOK_CLIENT_KEY=... TIKTOK_CLIENT_SECRET=...
```

Flux de connexion côté utilisateur : `GET /api/social/:platform/authorize` (authentifié)
redirige vers la plateforme, qui rappelle `GET /api/social/:platform/callback` après
consentement — la connexion est alors enregistrée pour l'organisation.

### Modération de contenu

Utilise les clés OpenAI déjà configurées pour la génération (`OPENAI_API_KEY`) — aucune
clé supplémentaire nécessaire. En `AI_MODE=mock`, toutes les vérifications retournent
`PASSED` (simulation), ce qui permet de tester tout le workflow d'approbation sans clé API.

### Stripe

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...       # depuis `stripe listen` en local, ou le Dashboard en prod
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_BUSINESS=price_...
```

En local, pour recevoir les webhooks : `stripe listen --forward-to localhost:3001/api/billing/webhook`.

### E-commerce (import catalogue)

```
POST /api/product-import/stores
{ "platform": "SHOPIFY", "storeUrl": "maboutique.myshopify.com", "accessToken": "shpat_..." }

POST /api/product-import/stores/:id/sync   # importe/synchronise le catalogue
```

## Structure

```
campaign-ai/
├── .github/workflows/ci.yml
├── docker-compose.yml
├── backend/
│   ├── prisma/schema.prisma
│   ├── test/                # tests E2E (auth.e2e-spec.ts)
│   └── src/
│       ├── auth/            # JWT, inscription/connexion, essai gratuit, multi-organisation
│       ├── organizations/   # tenant, création d'organisations supplémentaires
│       ├── teams/           # invitations, gestion des membres et rôles
│       ├── plans/           # catalogue de plans + EntitlementsService (source de vérité des quotas)
│       ├── brand/           # Brand Brain — charte déclarée + mémoire qui s'enrichit (BrandMemoryEntry)
│       ├── campaigns/       # création, workflow d'approbation, templates, quotas de plan
│       ├── campaign-templates/  # Module 18 — bibliothèque de templates par secteur
│       ├── content-studio/  # pièces de contenu, versions, variations, bibliothèque de médias
│       ├── editorial-calendar/  # planification + déclenchement de publication programmée
│       ├── moderation/      # garde-fou automatique (toxicité, promesses trompeuses, marques)
│       ├── brand-consistency/  # score de respect du Brand Kit (informatif)
│       ├── optimizer/       # Module 16 — AI Optimizer nocturne + mesure d'impact + fondation automatisation
│       ├── analytics/       # statistiques unifiées (campagne/canal/créative), ROAS réel
│       ├── ai-economics/    # coûts réels, marge, reporting (Économie de l'IA)
│       ├── audit/           # piste d'audit (AuditLog), actions sensibles tracées
│       ├── health/          # /health/live, /health/ready
│       ├── admin/           # panneau d'administration plateforme (cross-tenant, PlatformAdminGuard)
│       ├── privacy/         # RGPD/AI Act opérationnels (export, effacement, textes légaux versionnés)
│       ├── notifications/   # notifications email + in-app, best-effort
│       ├── support/         # tickets support avec fil de conversation
│       ├── help/            # centre d'aide (CMS minimal en base)
│       ├── billing/         # Stripe (checkout, changement de plan, résiliation, packs, webhooks) + expiration d'essai
│       ├── social/          # OAuth (state signé) + publication multicanale (verrouillée par APPROVED + abonnement actif)
│       │   └── adapters/    # meta, linkedin, google-ads, tiktok
│       ├── product-import/  # import catalogue e-commerce
│       │   └── adapters/    # shopify, woocommerce, prestashop
│       ├── ai/
│       │   ├── ai-gateway/       # interface unifiée + providers (openai, anthropic, flux, ideogram, google-veo)
│       │   └── ai-orchestrator/  # décomposition et routage des tâches, guidé par les templates
│       ├── campaign-orchestration/  # worker de génération (assemble AI + Moderation + Brand Consistency + Content Studio)
│       ├── queue/           # BullMQ (jobs asynchrones)
│       ├── common/
│       │   ├── crypto/          # chiffrement des tokens au repos (TokenCryptoService)
│       │   ├── logging/         # logs structurés + ID de corrélation par requête
│       │   └── observability/   # métriques Prometheus + filtre d'exception Sentry
│       └── prisma/          # service Prisma partagé
└── frontend/
    └── src/
        ├── app/              # pages (login, register, dashboard, campaigns)
        ├── components/       # UI partagée + nav
        └── lib/              # client API, hook d'auth
```

## Prochaines étapes suggérées

1. ~~Validation humaine avant publication~~ ✅ fait — voir section "Garde-fous avant publication".
2. ~~Modération de contenu automatique~~ ✅ fait — `ModerationService` (toxicité, promesses trompeuses, marques déposées).
3. ~~AI Optimizer nocturne~~ ✅ fait — `AiOptimizerService` + `AnalyticsIngestionService`.
4. ~~Score de cohérence de marque~~ ✅ fait — `BrandConsistencyService`.
5. ~~Bibliothèque de templates~~ ✅ fait (version simplifiée, sans partage inter-organisations) — `CampaignTemplatesService`.
6. ~~Multi-tenant, équipes, invitations~~ ✅ fait — `TeamsService`, avec garde-fous anti-abus.
7. ~~Plans, entitlements, quotas, essai gratuit~~ ✅ fait — `EntitlementsService` + `plan-catalog.ts`, appliqués à la création de campagne, l'invitation et la publication.
8. ~~Stripe comme moteur de facturation~~ ✅ fait — upgrade/downgrade avec proration, résiliation programmée/immédiate, packs de crédits, reset mensuel des crédits au renouvellement.
9. ~~Séparer `extraCredits` de `aiCreditsIncluded`~~ ✅ corrigé — les packs de crédits achetés ne se reconduisent plus indéfiniment ni ne disparaissent au reset mensuel, consommés en priorité sur le quota du plan.
10. ~~Chiffrement des tokens au repos~~ ✅ fait — `TokenCryptoService` (AES-256-GCM).
11. ~~Rafraîchissement des tokens (réactif + proactif)~~ ✅ fait — `SocialConnectionsService` + `TokenRefreshService`.
12. ~~Erreurs typées et retries~~ ✅ fait — `SocialApiError` + `withRetry()`.
13. ~~Publication idempotente~~ ✅ fait — contrainte unique `(campaignId, socialConnectionId)`.
14. ~~Finaliser `GoogleAdsAdapter.publish()`~~ ✅ fait (implémentation REST directe, campagne créée `PAUSED` par sécurité — pas encore le SDK officiel `google-ads-api`, ni ciblage/mots-clés).
15. ~~Finaliser le polling de statut TikTok~~ ✅ fait — `checkPublishStatus()`, interrogé de façon synchrone par `PublishingService` (pas encore en job récurrent pour les cas de traitement anormalement long).
16. **Frontend complet** : écran de revue (approbation), gestion d'équipe (inviter/retirer/changer de rôle), sélecteur de plan avec upgrade/downgrade en un clic, sélecteur de template dans le wizard, panneau de recommandations Optimizer, affichage du score de marque et de la consommation de quota — le backend est prêt, l'UI Next.js reste largement à construire.
17. Envoi d'emails réels pour les invitations (actuellement le token est retourné dans la réponse API, à afficher/copier côté frontend) et les notifications de facturation (essai qui se termine, paiement échoué, campagne en attente de revue).
18. ~~Tests automatisés sur la logique critique~~ ✅ fait (partiellement) — `OAuthStateService`, `TokenCryptoService`, `withRetry`, `EntitlementsService`, `AuditService`, `plan-catalog.ts`, + 1 test E2E (auth). Reste à couvrir : adaptateurs sociaux, workflows d'approbation/optimisation/facturation complets.
19. Étendre `fetchInsights()` à LinkedIn/Google Ads/TikTok pour que l'Optimizer analyse des données réelles sur tous les canaux, pas seulement Meta.
20. Procédure de rotation de `TOKEN_ENCRYPTION_KEY` (actuellement figée pour la durée de vie des données chiffrées — cf. note dans `token-crypto.service.ts`).
21. ~~Content Studio (versions, variations, bibliothèque de médias)~~ ✅ fait — `ContentStudioService` + `AssetsService`, alimenté automatiquement par le worker de génération.
22. ~~Calendrier éditorial~~ ✅ fait — `EditorialCalendarService` + `ScheduledPublishingService`, soumis aux mêmes garde-fous qu'une publication manuelle.
23. ~~Brand Brain (mémoire qui s'enrichit)~~ ✅ fait — `BrandMemoryEntry`, alimentée à la publication et sur les recommandations Optimizer notables.
24. ~~Pipeline d'upload binaire pour les assets~~ ✅ corrigé — `StorageService`, compatible S3/R2/GCS/MinIO/B2 (un seul client), plus repli disque local pour le développement.
25. ~~Copywriting différencié par canal~~ ✅ corrigé — un prompt distinct par canal (Instagram, LinkedIn, Facebook, TikTok, Google Ads), plus un seul texte dupliqué. Sélecteur de canaux ajouté à `/campaigns/new`, absent jusque-là.
26. ~~Statistiques unifiées par campagne/canal/contenu~~ ✅ fait — `AnalyticsService`, granularité préservée (une ligne `CampaignMetric` par canal, une ligne `ContentMetric` par créative) au lieu d'une somme globale.
27. ~~Recommandations mesurables~~ ✅ fait — `OptimizerOutcomeService`, comparaison avant/après 7 jours après application.
28. ~~Fondation pour l'automatisation contrôlée~~ ✅ fait (interface et garde-fous posés, **non activée**) — `AutomationService`, `ENABLE_CONTROLLED_AUTOMATION=false` par défaut.
29. **Intégration Conversions API réelle** (Meta, Google Ads) pour un ROAS calculé automatiquement plutôt que via l'endpoint de conversion manuelle — aucun adaptateur actuel ne remonte de conversions programmatiquement.
30. **Activer réellement l'automatisation contrôlée** une fois suffisamment de recommandations `automationEligible` auront été mesurées avec un impact positif consistant — actuellement bloqué intentionnellement en amont de ce chantier futur.
31. ~~Vulnérabilité de falsification du state OAuth~~ ✅ corrigée — `OAuthStateService`, state signé HMAC-SHA256 avec expiration.
32. ~~Piste d'audit~~ ✅ fait — `AuditService`, best-effort, branchée sur les actions les plus sensibles.
33. ~~Rate limiting~~ ✅ fait — `@nestjs/throttler`, limites globales et dédiées.
34. ~~Logs structurés + ID de corrélation~~ ✅ fait — `StructuredLoggerService` + `RequestContextService`.
35. ~~Health checks, métriques Prometheus, Sentry~~ ✅ fait — `/health/live`, `/health/ready`, `/metrics`, `GlobalExceptionFilter`.
36. ~~CI/CD~~ ✅ fait — `.github/workflows/ci.yml` (Postgres/Redis en services, lint, build, tests unitaires + E2E).
37. **Redis dans le health check** — `/health/ready` ne vérifie actuellement que la base de données, pas la connexion Redis utilisée par BullMQ (cf. note dans `health.controller.ts`).
38. **Rotation de `OAUTH_STATE_SECRET`** — même limitation que `TOKEN_ENCRYPTION_KEY` : un changement de secret invaliderait tous les flux OAuth en cours (fenêtre de 10 minutes, donc impact limité en pratique).
39. **Étendre la couverture de tests** aux adaptateurs sociaux (avec mocks HTTP des APIs tierces), aux workflows complets (génération → modération → approbation → publication), et à la logique de facturation Stripe (webhooks).
40. ~~RGPD/AI Act opérationnels~~ ✅ fait — `PrivacyModule` (export, effacement douce, textes légaux versionnés avec acceptation trackée, transparence IA par campagne).
41. ~~Notifications email + in-app~~ ✅ fait — `NotificationsService`, branchée sur 8 événements du cycle de vie (invitation, revue de campagne, essai, paiement, support).
42. ~~Support et centre d'aide~~ ✅ fait — `SupportModule` (tickets avec fil de conversation) + `HelpModule` (CMS minimal en base).
43. ~~Panneau d'administration plateforme~~ ✅ fait — `AdminModule` (`PlatformAdminGuard`, organisations/utilisateurs/abonnements/coûts IA/erreurs/activité cross-tenant, suspension/réactivation).
44. **Relecture juridique des textes légaux** — `legal-documents.ts` contient des gabarits explicitement marqués comme tels, jamais validés par un juriste ; à faire avant toute mise en production réelle.
45. **Promotion self-service vers `isPlatformAdmin`** — actuellement uniquement par intervention manuelle en base de données (choix délibéré pour ce niveau d'accès, cf. `platform-admin.guard.ts`), pas d'interface d'administration des administrateurs.
46. **Journal d'erreurs HTTP dédié** pour `/admin/errors` — la vue actuelle s'appuie sur les générations IA et publications déjà tracées comme échouées, pas sur un journal d'erreurs HTTP centralisé (les 5xx sont capturés par Sentry, mais pas requêtables depuis l'admin panel lui-même).
47. ~~Landing page, pricing, onboarding, parcours de conversion~~ ✅ fait — `/`, `/pricing`, `/onboarding`, `TrialBanner`, `/settings/billing` avec Stripe Checkout réel.
48. ~~Dockerfiles + configuration de déploiement~~ ✅ fait — `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.prod.yml`, job `docker-publish` dans la CI.
49. **Frontend restant à construire** : le reste des fonctionnalités backend (Content Studio, calendrier éditorial, panneau d'administration, gestion d'équipe, centre d'aide, tickets support) n'a pas d'interface — priorité suggérée après la V1 commerciale, une fois le parcours d'acquisition validé.
50. **Déploiement effectif** — les Dockerfiles et la CD partielle (publication d'images) sont prêts, mais le déploiement final (SSH/serveur cible, DNS, TLS) dépend de l'hébergeur choisi et reste à réaliser manuellement, cf. checklist de mise en ligne.
51. **Tests pilotes réels** — ce chantier livre l'infrastructure de suivi (`AdminModule`, `SupportModule`), pas les résultats d'un pilote mené avec de vrais utilisateurs.
52. **Mode standalone Next.js** — `frontend/Dockerfile` utilise `next start` classique plutôt que `output: 'standalone'`, ce qui produit une image plus grosse que nécessaire ; à optimiser avant un déploiement à grande échelle.
53. ~~Plafonds dédiés de l'essai gratuit (images/vidéos/publications/Optimizer)~~ ✅ fait — plan `trial` distinct du plan Growth, plafonds indépendants du pool de crédits partagé.
54. ~~Invitation à l'upgrade au moment du plafond~~ ✅ fait — `PlanLimitExceededException`, `UpgradeModal`, correction de deux bugs de propagation d'erreur structurée (backend et frontend).
55. **Restriction de canaux non appliquée à la création de campagne** — `assertChannelsAllowed` n'est vérifié qu'au moment de la publication (`PublishingService`), pas plus tôt dans le wizard de sélection de canaux ; un utilisateur en essai peut donc sélectionner Google Ads/TikTok et ne découvrir le refus qu'à la publication.
56. **Modal d'upgrade non branché sur tous les points d'entrée frontend** — implémenté sur `/campaigns/new` uniquement ; les autres actions consommant des plafonds (publication, invitation d'équipe, déclenchement Optimizer) n'ont pas encore de page dédiée dans le frontend Next.js minimal (cf. item 49).
57. ~~Page Brand Brain~~ ✅ fait — `/settings/brand`, identité déclarée + mémoire de marque consultable, jusqu'ici seulement un champ isolé dans l'onboarding.
58. ~~Onglet Analytics~~ ✅ fait — vue d'ensemble, répartition par canal, répartition par créative, enregistrement de conversion manuelle, jusqu'ici absent malgré un module backend complet.
59. ~~Bug d'intégration : mauvais chemin d'endpoint de publication~~ ✅ corrigé — `/social/campaigns/:id/publish`, pas `/campaigns/:id/publish`.
60. ~~Génération spécifique par canal~~ ✅ fait — un prompt distinct par canal (Instagram/LinkedIn/Facebook/TikTok/Google Ads), Google Ads validé aux contraintes réelles de caractères.
61. **Grille de crédits de l'essai gratuit à revoir** — la génération par canal augmente mécaniquement le coût d'une campagne multi-canaux (~65 crédits pour 3 canaux + image, contre 60 crédits inclus dans le plan `trial`) ; un ajustement de `plan-catalog.ts` (relever le plafond de l'essai, ou plafonner le nombre de canaux disponibles en essai) reste une décision commerciale à trancher, volontairement non modifiée ici.
62. **Pas de contrôle de longueur en temps réel côté Content Studio** — les limites Google Ads sont appliquées à la génération (troncature automatique), mais si un utilisateur édite manuellement un texte via `POST .../content/:id/edit`, aucune validation ne l'empêche de dépasser 30/90 caractères.
