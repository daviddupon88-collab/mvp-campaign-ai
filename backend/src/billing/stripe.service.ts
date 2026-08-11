import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { PLAN_CATALOG, CREDIT_PACKS, getPlan } from '../plans/plan-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { emailTemplates } from '../notifications/email/email-templates';

// Résout dynamiquement le Price ID Stripe depuis la variable d'environnement référencée
// par le catalogue de plans (plan-catalog.ts reste la seule source de vérité tarifaire).
function resolvePriceId(planKey: string): string {
  const plan = getPlan(planKey);
  if (!plan.stripePriceEnvKey) throw new BadRequestException(`Le plan ${plan.name} ne se souscrit pas en self-service`);
  const priceId = process.env[plan.stripePriceEnvKey];
  if (!priceId) throw new BadRequestException(`Price ID Stripe non configuré pour le plan ${plan.name}`);
  return priceId;
}

function resolveCreditPackPriceId(packKey: string): { priceId: string; credits: number } {
  const pack = CREDIT_PACKS[packKey];
  if (!pack) throw new BadRequestException(`Pack de crédits inconnu: ${packKey}`);
  const priceId = process.env[pack.priceEnvKey];
  if (!priceId) throw new BadRequestException(`Price ID Stripe non configuré pour le pack ${packKey}`);
  return { priceId, credits: pack.credits };
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    this.stripe = new Stripe(this.config.get<string>('STRIPE_SECRET_KEY', ''), {
      apiVersion: '2024-06-20',
    });
    this.webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET', '');
  }

  private async getOrCreateCustomer(organizationId: string): Promise<string> {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (subscription?.stripeCustomerId) return subscription.stripeCustomerId;

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { users: { include: { user: true }, take: 1 } },
    });
    const email = org?.users[0]?.user.email;

    const customer = await this.stripe.customers.create({
      name: org?.name,
      email,
      metadata: { organizationId },
    });

    await this.prisma.subscription.update({ where: { organizationId }, data: { stripeCustomerId: customer.id } });
    return customer.id;
  }

  // Première souscription (l'organisation n'a pas encore de stripeSubscriptionId) : passe
  // par Stripe Checkout. Le trial local (cf. AuthService) est indépendant de Stripe — au
  // moment où l'utilisateur souscrit réellement, aucun trial_period_days supplémentaire
  // n'est nécessaire côté Stripe puisqu'il a déjà consommé son essai gratuit maison.
  async createCheckoutSession(organizationId: string, plan: string, successUrl: string, cancelUrl: string) {
    const priceId = resolvePriceId(plan);
    const customerId = await this.getOrCreateCustomer(organizationId);

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { organizationId, plan, type: 'subscription' },
      subscription_data: { metadata: { organizationId, plan } },
    });

    return { checkoutUrl: session.url };
  }

  // Achat ponctuel d'un pack de crédits (mode 'payment', pas 'subscription') — le montant
  // de crédits s'ajoute au quota courant sans toucher au plan ni à son cycle de facturation.
  async createCreditPackCheckoutSession(organizationId: string, packKey: string, successUrl: string, cancelUrl: string) {
    const { priceId, credits } = resolveCreditPackPriceId(packKey);
    const customerId = await this.getOrCreateCustomer(organizationId);

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { organizationId, type: 'credit_pack', credits: String(credits) },
    });

    return { checkoutUrl: session.url };
  }

  // Changement de plan sur un abonnement Stripe déjà actif : met à jour la ligne existante
  // avec proration automatique (Stripe calcule le prorata, à la hausse comme à la baisse).
  // Si l'organisation n'a pas encore d'abonnement Stripe (premier passage du trial local
  // vers un plan payant), redirige vers Checkout — il n'y a rien à "changer" sans premier paiement.
  async changePlan(organizationId: string, newPlan: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription?.stripeSubscriptionId) {
      throw new BadRequestException(
        "Aucun abonnement Stripe actif — utilisez /billing/checkout pour souscrire un premier plan payant",
      );
    }

    const priceId = resolvePriceId(newPlan);
    const stripeSubscription = await this.stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
    const itemId = stripeSubscription.items.data[0].id;

    const updated = await this.stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      items: [{ id: itemId, price: priceId }],
      proration_behavior: 'create_prorations',
      metadata: { organizationId, plan: newPlan },
    });

    // Mise à jour optimiste en local (le webhook customer.subscription.updated confirmera) —
    // évite que le frontend affiche l'ancien plan pendant les quelques centaines de ms
    // avant l'arrivée du webhook.
    const planDef = getPlan(newPlan);
    await this.prisma.subscription.update({
      where: { organizationId },
      data: { plan: newPlan, aiCreditsIncluded: planDef.aiCreditsIncluded, status: updated.status },
    });

    return { plan: newPlan, status: updated.status };
  }

  // Résiliation en fin de période (par défaut) : le client garde l'accès jusqu'à la fin
  // du cycle déjà payé — c'est le standard SaaS, une résiliation immédiate est punitive
  // et rarement ce que l'utilisateur attend en cliquant "Résilier mon abonnement".
  async cancelSubscription(organizationId: string, immediate = false) {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription?.stripeSubscriptionId) {
      // Cas du trial local jamais converti en abonnement payant Stripe : rien à annuler
      // côté Stripe, on marque directement l'abonnement local comme résilié.
      await this.prisma.subscription.update({ where: { organizationId }, data: { status: 'canceled' } });
      return { status: 'canceled' };
    }

    if (immediate) {
      await this.stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
      await this.prisma.subscription.update({ where: { organizationId }, data: { status: 'canceled', cancelAtPeriodEnd: false } });
      return { status: 'canceled' };
    }

    await this.stripe.subscriptions.update(subscription.stripeSubscriptionId, { cancel_at_period_end: true });
    await this.prisma.subscription.update({ where: { organizationId }, data: { cancelAtPeriodEnd: true } });
    return { status: subscription.status, cancelAtPeriodEnd: true };
  }

  // Annule une résiliation programmée — "je me suis ravisé avant la fin de la période".
  async resumeSubscription(organizationId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription?.stripeSubscriptionId) {
      throw new BadRequestException('Aucun abonnement Stripe à reprendre');
    }
    await this.stripe.subscriptions.update(subscription.stripeSubscriptionId, { cancel_at_period_end: false });
    await this.prisma.subscription.update({ where: { organizationId }, data: { cancelAtPeriodEnd: false } });
    return { cancelAtPeriodEnd: false };
  }

  async createPortalSession(organizationId: string, returnUrl: string) {
    const customerId = await this.getOrCreateCustomer(organizationId);
    const session = await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return { portalUrl: session.url };
  }

  // Historique de facturation — proxy direct sur l'API Stripe, pas de duplication locale
  // des factures (Stripe reste la source de vérité comptable).
  async listInvoices(organizationId: string) {
    const subscription = await this.prisma.subscription.findUnique({ where: { organizationId } });
    if (!subscription?.stripeCustomerId) return [];
    const invoices = await this.stripe.invoices.list({ customer: subscription.stripeCustomerId, limit: 12 });
    return invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amountPaid: inv.amount_paid / 100,
      currency: inv.currency,
      createdAt: new Date(inv.created * 1000),
      pdfUrl: inv.invoice_pdf,
    }));
  }

  async handleWebhookEvent(rawBody: Buffer, signature: string) {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch (err) {
      this.logger.error(`Signature webhook Stripe invalide: ${err}`);
      throw new BadRequestException('Signature webhook invalide');
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.updated':
        await this.onSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await this.onSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.trial_will_end':
        await this.onTrialWillEnd(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_failed':
        await this.onPaymentFailed(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_succeeded':
        await this.onPaymentSucceeded(event.data.object as Stripe.Invoice);
        break;
      default:
        this.logger.debug(`Événement Stripe non géré: ${event.type}`);
    }

    return { received: true };
  }

  // Distingue les deux natures possibles d'un Checkout complété : un abonnement
  // (mode='subscription') ou l'achat ponctuel d'un pack de crédits (mode='payment').
  private async onCheckoutCompleted(session: Stripe.Checkout.Session) {
    const organizationId = session.metadata?.organizationId;
    if (!organizationId) return;

    if (session.metadata?.type === 'credit_pack') {
      const credits = parseInt(session.metadata.credits ?? '0', 10);
      if (credits > 0) {
        // extraCredits, jamais aiCreditsIncluded : ce dernier est le quota du PLAN, remis
        // à 0 (aiCreditsUsed) à chaque cycle Stripe — l'incrémenter directement aurait
        // gonflé le quota mensuel de façon permanente au lieu d'ajouter un solde ponctuel
        // qui s'épuise à l'usage (cf. EntitlementsService.consumeCredits, qui le décrémente
        // en priorité).
        await this.prisma.subscription.update({
          where: { organizationId },
          data: { extraCredits: { increment: credits } },
        });
        this.logger.log(`Pack de ${credits} crédits ajouté pour l'organisation ${organizationId}`);
      }
      return;
    }

    const plan = session.metadata?.plan;
    if (!plan) return;
    const planDef = getPlan(plan);

    await this.prisma.subscription.update({
      where: { organizationId },
      data: {
        plan,
        aiCreditsIncluded: planDef.aiCreditsIncluded,
        stripeSubscriptionId: session.subscription as string,
        status: 'active',
        cancelAtPeriodEnd: false,
      },
    });
    this.logger.log(`Abonnement activé pour l'organisation ${organizationId} (plan ${plan})`);
  }

  private async onSubscriptionUpdated(subscription: Stripe.Subscription) {
    const organizationId = subscription.metadata?.organizationId;
    if (!organizationId) return;

    const plan = subscription.metadata?.plan;
    const data: Record<string, unknown> = {
      status: subscription.status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    };
    if (plan) {
      const planDef = getPlan(plan);
      data.plan = plan;
      data.aiCreditsIncluded = planDef.aiCreditsIncluded;
    }

    await this.prisma.subscription.update({ where: { organizationId }, data });
  }

  private async onSubscriptionDeleted(subscription: Stripe.Subscription) {
    const organizationId = subscription.metadata?.organizationId;
    if (!organizationId) return;
    await this.prisma.subscription.update({ where: { organizationId }, data: { status: 'canceled', cancelAtPeriodEnd: false } });
  }

  private async onTrialWillEnd(subscription: Stripe.Subscription) {
    const organizationId = subscription.metadata?.organizationId;
    if (!organizationId) return;
    this.logger.log(`Essai bientôt terminé pour l'organisation ${organizationId}`);
    // Point d'extension : email "votre essai se termine dans 3 jours" (Stripe déclenche
    // cet événement automatiquement 3 jours avant la fin d'un trial_period_days Stripe natif).
  }

  private async onPaymentFailed(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string;
    const subscription = await this.prisma.subscription.findFirst({ where: { stripeCustomerId: customerId } });
    if (!subscription) return;

    await this.prisma.subscription.update({ where: { id: subscription.id }, data: { status: 'past_due' } });
    this.logger.warn(`Échec de paiement pour l'organisation ${subscription.organizationId}`);
    // EntitlementsService.assertActiveSubscription() bloque déjà les actions de création
    // tant que le statut reste past_due, sans attendre une action manuelle.

    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
    await this.notifications.notifyOrganization(subscription.organizationId, ['OWNER', 'ADMIN'], {
      organizationId: subscription.organizationId,
      type: 'PAYMENT_FAILED',
      title: 'Échec de paiement',
      body: 'Le paiement de votre abonnement Campaign-ai a échoué — mettez à jour votre moyen de paiement.',
      link: '/settings/billing',
      email: {
        to: '',
        subject: 'Échec de paiement — action requise',
        html: emailTemplates.paymentFailed({ billingUrl: `${frontendUrl}/settings/billing` }),
      },
    });
  }

  // Distingue deux cas radicalement différents derrière le même événement Stripe :
  //  - facture de RENOUVELLEMENT (billing_reason='subscription_cycle') : un nouveau cycle
  //    commence, les crédits IA doivent repartir à zéro pour ce mois — sans ce reset, un
  //    client payant verrait son quota rester bloqué au niveau du mois précédent indéfiniment.
  //  - facture consécutive à une régularisation après échec de paiement : on lève juste
  //    le statut past_due, sans toucher aux crédits déjà consommés ce cycle-ci.
  private async onPaymentSucceeded(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string;
    const subscription = await this.prisma.subscription.findFirst({ where: { stripeCustomerId: customerId } });
    if (!subscription) return;

    if (invoice.billing_reason === 'subscription_cycle') {
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { aiCreditsUsed: 0, status: 'active' },
      });
      this.logger.log(`Nouveau cycle de facturation pour l'organisation ${subscription.organizationId} — crédits IA réinitialisés`);
      return;
    }

    if (subscription.status === 'past_due') {
      // Un paiement réussi après un past_due signifie que le client a mis à jour son moyen
      // de paiement — on lève le blocage immédiatement plutôt que d'attendre le prochain
      // customer.subscription.updated (qui arrive généralement juste après, mais pas toujours).
      await this.prisma.subscription.update({ where: { id: subscription.id }, data: { status: 'active' } });
      this.logger.log(`Paiement régularisé pour l'organisation ${subscription.organizationId}`);
    }
  }
}
