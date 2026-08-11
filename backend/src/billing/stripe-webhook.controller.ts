import { Controller, Headers, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { StripeService } from './stripe.service';

// Controller volontairement séparé de BillingController : ce endpoint est appelé
// directement par Stripe (pas de JWT possible) et nécessite le corps brut de la requête,
// exclu du parsing JSON global dans main.ts pour cette route précise.
@Controller('billing/webhook')
export class StripeWebhookController {
  constructor(private readonly stripeService: StripeService) {}

  @Post()
  handleWebhook(@Req() req: Request, @Headers('stripe-signature') signature: string) {
    // req.body est ici un Buffer brut (cf. express.raw() configuré sur cette route dans main.ts).
    return this.stripeService.handleWebhookEvent(req.body as Buffer, signature);
  }
}
