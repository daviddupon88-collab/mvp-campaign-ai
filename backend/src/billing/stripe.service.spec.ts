import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

// StripeService instancie un vrai client `Stripe` dans son constructeur (aucun appel réseau
// à la construction — c'est sûr avec une clé bidon) puis on remplace ce client par un mock
// après coup, même pattern que les autres tests de ce projet qui instancient directement le
// service avec des dépendances mockées plutôt que de monter un TestingModule complet.
function buildService(overrides?: { subscription?: any; organization?: any }) {
  const config = { get: (_key: string, fallback?: string) => fallback ?? '' } as unknown as ConfigService;

  const subscriptionUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    subscription: {
      findUnique: jest.fn().mockResolvedValue(overrides?.subscription ?? null),
      // onPaymentFailed/onPaymentSucceeded retrouvent l'abonnement par stripeCustomerId
      // (findFirst), pas par organizationId (findUnique) — les deux doivent être mockés.
      findFirst: jest.fn().mockResolvedValue(overrides?.subscription ?? null),
      update: subscriptionUpdate,
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue(overrides?.organization ?? null),
    },
  } as unknown as PrismaService;

  const notifyOrganization = jest.fn().mockResolvedValue(undefined);
  const notifications = { notifyOrganization } as unknown as NotificationsService;

  const service = new StripeService(config, prisma, notifications);

  const stripeMock = {
    webhooks: { constructEvent: jest.fn() },
  };
  (service as any).stripe = stripeMock;

  return { service, stripeMock, prisma, subscriptionUpdate, notifyOrganization };
}

function fakeEvent(type: string, object: any) {
  return { type, data: { object } };
}

// Vérifie explicitement la correction de deux bugs réels du chantier "Économie de l'IA" :
// l'ancienne logique gonflait aiCreditsIncluded de façon permanente à l'achat d'un pack de
// crédits (au lieu d'alimenter extraCredits, qui s'épuise réellement à l'usage), et le reset
// mensuel des crédits ne se déclenchait pas de façon fiable au bon événement Stripe.
describe('StripeService.handleWebhookEvent', () => {
  it('rejette un webhook dont la signature est invalide, sans traiter l\'événement', async () => {
    const { service, stripeMock, prisma } = buildService();
    stripeMock.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('signature invalide');
    });

    await expect(service.handleWebhookEvent(Buffer.from('{}'), 'mauvaise-signature')).rejects.toThrow(BadRequestException);
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('checkout.session.completed (type=credit_pack) ajoute au solde extraCredits, jamais à aiCreditsIncluded', async () => {
    const { service, stripeMock, subscriptionUpdate } = buildService();
    stripeMock.webhooks.constructEvent.mockReturnValue(
      fakeEvent('checkout.session.completed', {
        metadata: { organizationId: 'org-1', type: 'credit_pack', credits: '500' },
      }),
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(subscriptionUpdate).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      data: { extraCredits: { increment: 500 } },
    });
  });

  it('checkout.session.completed (abonnement) active le plan et fixe le quota du plan', async () => {
    const { service, stripeMock, subscriptionUpdate } = buildService();
    stripeMock.webhooks.constructEvent.mockReturnValue(
      fakeEvent('checkout.session.completed', {
        metadata: { organizationId: 'org-1', plan: 'growth' },
        subscription: 'sub_123',
      }),
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(subscriptionUpdate).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      data: expect.objectContaining({
        plan: 'growth',
        stripeSubscriptionId: 'sub_123',
        status: 'active',
        cancelAtPeriodEnd: false,
      }),
    });
  });

  it('customer.subscription.deleted résilie l\'abonnement sans résiliation programmée résiduelle', async () => {
    const { service, stripeMock, subscriptionUpdate } = buildService();
    stripeMock.webhooks.constructEvent.mockReturnValue(
      fakeEvent('customer.subscription.deleted', { metadata: { organizationId: 'org-1' } }),
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(subscriptionUpdate).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      data: { status: 'canceled', cancelAtPeriodEnd: false },
    });
  });

  it('invoice.payment_failed passe l\'abonnement en past_due et notifie OWNER/ADMIN', async () => {
    const { service, stripeMock, subscriptionUpdate, notifyOrganization } = buildService({
      subscription: { id: 'sub-row-1', organizationId: 'org-1', stripeCustomerId: 'cus_1' },
    });
    stripeMock.webhooks.constructEvent.mockReturnValue(
      fakeEvent('invoice.payment_failed', { customer: 'cus_1' }),
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(subscriptionUpdate).toHaveBeenCalledWith({ where: { id: 'sub-row-1' }, data: { status: 'past_due' } });
    expect(notifyOrganization).toHaveBeenCalledWith('org-1', ['OWNER', 'ADMIN'], expect.objectContaining({ type: 'PAYMENT_FAILED' }));
  });

  it('invoice.payment_succeeded (renouvellement) réinitialise aiCreditsUsed à 0', async () => {
    const { service, stripeMock, subscriptionUpdate } = buildService({
      subscription: { id: 'sub-row-1', organizationId: 'org-1', stripeCustomerId: 'cus_1', status: 'active' },
    });
    stripeMock.webhooks.constructEvent.mockReturnValue(
      fakeEvent('invoice.payment_succeeded', { customer: 'cus_1', billing_reason: 'subscription_cycle' }),
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(subscriptionUpdate).toHaveBeenCalledWith({
      where: { id: 'sub-row-1' },
      data: { aiCreditsUsed: 0, status: 'active' },
    });
  });

  it('invoice.payment_succeeded (régularisation après échec) lève le past_due sans toucher aux crédits déjà consommés', async () => {
    const { service, stripeMock, subscriptionUpdate } = buildService({
      subscription: { id: 'sub-row-1', organizationId: 'org-1', stripeCustomerId: 'cus_1', status: 'past_due' },
    });
    stripeMock.webhooks.constructEvent.mockReturnValue(
      fakeEvent('invoice.payment_succeeded', { customer: 'cus_1', billing_reason: 'manual' }),
    );

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(subscriptionUpdate).toHaveBeenCalledWith({ where: { id: 'sub-row-1' }, data: { status: 'active' } });
    expect(subscriptionUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ aiCreditsUsed: expect.anything() }) }));
  });

  it('un événement sans organizationId en métadonnée est ignoré silencieusement (pas d\'exception, pas d\'écriture)', async () => {
    const { service, stripeMock, subscriptionUpdate } = buildService();
    stripeMock.webhooks.constructEvent.mockReturnValue(fakeEvent('checkout.session.completed', { metadata: {} }));

    await expect(service.handleWebhookEvent(Buffer.from('{}'), 'sig')).resolves.toEqual({ received: true });
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });

  it('un type d\'événement non géré ne fait rien et ne plante pas', async () => {
    const { service, stripeMock, subscriptionUpdate } = buildService();
    stripeMock.webhooks.constructEvent.mockReturnValue(fakeEvent('customer.updated', {}));

    await expect(service.handleWebhookEvent(Buffer.from('{}'), 'sig')).resolves.toEqual({ received: true });
    expect(subscriptionUpdate).not.toHaveBeenCalled();
  });
});
