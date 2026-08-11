import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import { TrialExpiryService } from './trial-expiry.service';

@Module({
  providers: [BillingService, StripeService, TrialExpiryService],
  controllers: [BillingController, StripeWebhookController],
  exports: [BillingService, StripeService],
})
export class BillingModule {}
