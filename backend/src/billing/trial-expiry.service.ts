import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { emailTemplates } from '../notifications/email/email-templates';

const WARNING_DAYS_BEFORE = 3;

// Sans ce mécanisme, un essai gratuit (14 jours, cf. AuthService.register) resterait actif
// indéfiniment — l'organisation garderait un accès complet au plan Growth sans jamais payer.
// C'est la pièce qui referme la boucle : EntitlementsService.assertActiveSubscription()
// bloque déjà les organisations au statut 'expired', mais rien ne les faisait passer par
// ce statut avant ce service. Complété : alerte préventive avant l'expiration effective.
@Injectable()
export class TrialExpiryService {
  private readonly logger = new Logger(TrialExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  private frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', 'http://localhost:3000');
  }

  // Vérification quotidienne — un essai qui expire n'a pas besoin d'une granularité plus
  // fine ; contrairement à l'AI Optimizer, il n'y a pas d'avantage à agir en pleine nuit.
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async runDailyChecks() {
    await this.warnEndingSoonTrials();
    await this.expireOverdueTrials();
  }

  // Alerte préventive : 3 jours avant l'expiration, pour laisser le temps de convertir sans
  // subir de coupure de service surprise — une résiliation involontaire par oubli est un
  // mauvais souvenir client évitable, contrairement à une résiliation délibérée.
  private async warnEndingSoonTrials() {
    const warningThreshold = new Date(Date.now() + WARNING_DAYS_BEFORE * 24 * 60 * 60 * 1000);
    const tomorrowThreshold = new Date(Date.now() + (WARNING_DAYS_BEFORE - 1) * 24 * 60 * 60 * 1000);

    // Fenêtre étroite (entre J-2 et J-3) plutôt que "trialEndsAt < warningThreshold" seul —
    // évite de renvoyer la même alerte chaque jour jusqu'à expiration, une seule suffit.
    const endingSoon = await this.prisma.subscription.findMany({
      where: {
        status: 'trialing',
        stripeSubscriptionId: null,
        trialEndsAt: { lt: warningThreshold, gte: tomorrowThreshold },
      },
      include: { organization: { select: { id: true, name: true } } },
    });

    for (const sub of endingSoon) {
      await this.notifications.notifyOrganization(sub.organizationId, ['OWNER', 'ADMIN'], {
        organizationId: sub.organizationId,
        type: 'TRIAL_ENDING_SOON',
        title: 'Votre essai gratuit se termine bientôt',
        body: `L'essai de "${sub.organization.name}" se termine dans ${WARNING_DAYS_BEFORE} jours.`,
        link: '/settings/billing',
        email: {
          to: '', // remplacé par notifyOrganization pour chaque destinataire
          subject: 'Votre essai Campaign-ai se termine bientôt',
          html: emailTemplates.trialEndingSoon({ daysRemaining: WARNING_DAYS_BEFORE, billingUrl: `${this.frontendUrl()}/settings/billing` }),
        },
      });
    }
    if (endingSoon.length > 0) this.logger.log(`${endingSoon.length} alerte(s) d'essai bientôt terminé envoyée(s)`);
  }

  async expireOverdueTrials() {
    // Seules les organisations encore en 'trialing' ET sans stripeSubscriptionId sont
    // concernées : dès qu'un paiement Stripe a été initié, le statut n'est plus 'trialing'
    // (passé à 'active' par le webhook checkout.session.completed) donc jamais touché ici.
    const overdueTrials = await this.prisma.subscription.findMany({
      where: {
        status: 'trialing',
        stripeSubscriptionId: null,
        trialEndsAt: { lt: new Date() },
      },
      include: { organization: { select: { id: true, name: true } } },
    });

    for (const sub of overdueTrials) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'expired' },
      });
      this.logger.log(`Essai expiré sans conversion pour l'organisation "${sub.organization.name}" (${sub.organization.id})`);

      await this.notifications.notifyOrganization(sub.organizationId, ['OWNER', 'ADMIN'], {
        organizationId: sub.organizationId,
        type: 'TRIAL_EXPIRED',
        title: 'Votre essai gratuit est terminé',
        body: `L'essai de "${sub.organization.name}" est terminé — souscrivez un plan pour continuer.`,
        link: '/settings/billing',
        email: {
          to: '',
          subject: 'Votre essai Campaign-ai est terminé',
          html: emailTemplates.trialEndingSoon({ daysRemaining: 0, billingUrl: `${this.frontendUrl()}/settings/billing` }),
        },
      });
    }

    if (overdueTrials.length > 0) {
      this.logger.log(`${overdueTrials.length} essai(s) expiré(s) lors de cette vérification`);
    }
  }
}
