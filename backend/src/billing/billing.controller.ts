import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestMeta } from '../common/decorators/request-meta.decorator';
import { AuditService } from '../audit/audit.service';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';
import { CreateCheckoutDto, ChangePlanDto, CancelSubscriptionDto, CreateCreditPackCheckoutDto } from './dto/checkout.dto';

interface AuthUser {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
}

interface Meta {
  ipAddress?: string;
  userAgent?: string;
}

@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly stripeService: StripeService,
    private readonly auditService: AuditService,
  ) {}

  @Get('subscription')
  getSubscription(@CurrentUser() user: AuthUser) {
    return this.billingService.getSubscription(user.organizationId);
  }

  // Souscription initiale — premier passage du trial local vers un plan payant Stripe.
  @Post('checkout')
  @Roles('ADMIN', 'OWNER')
  createCheckout(@CurrentUser() user: AuthUser, @Body() dto: CreateCheckoutDto) {
    return this.stripeService.createCheckoutSession(user.organizationId, dto.plan, dto.successUrl, dto.cancelUrl);
  }

  // Upgrade/downgrade sur un abonnement déjà actif — proration automatique par Stripe.
  // Décision financière : toujours tracée dans la piste d'audit.
  @Post('change-plan')
  @Roles('ADMIN', 'OWNER')
  async changePlan(@CurrentUser() user: AuthUser, @Body() dto: ChangePlanDto, @RequestMeta() meta: Meta) {
    const result = await this.stripeService.changePlan(user.organizationId, dto.plan);
    await this.auditService.record('billing.plan_changed', 'Subscription', user.organizationId, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta }, { newPlan: dto.plan });
    return result;
  }

  @Post('cancel')
  @Roles('OWNER')
  async cancel(@CurrentUser() user: AuthUser, @Body() dto: CancelSubscriptionDto, @RequestMeta() meta: Meta) {
    const result = await this.stripeService.cancelSubscription(user.organizationId, dto.immediate ?? false);
    await this.auditService.record('billing.subscription_canceled', 'Subscription', user.organizationId, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta }, { immediate: dto.immediate ?? false });
    return result;
  }

  @Post('resume')
  @Roles('OWNER')
  async resume(@CurrentUser() user: AuthUser, @RequestMeta() meta: Meta) {
    const result = await this.stripeService.resumeSubscription(user.organizationId);
    await this.auditService.record('billing.subscription_resumed', 'Subscription', user.organizationId, { organizationId: user.organizationId, actorUserId: user.userId, actorEmail: user.email, ...meta });
    return result;
  }

  @Post('portal')
  @Roles('ADMIN', 'OWNER')
  createPortal(@CurrentUser() user: AuthUser, @Body('returnUrl') returnUrl: string) {
    return this.stripeService.createPortalSession(user.organizationId, returnUrl);
  }

  @Get('invoices')
  @Roles('ADMIN', 'OWNER')
  listInvoices(@CurrentUser() user: AuthUser) {
    return this.stripeService.listInvoices(user.organizationId);
  }

  // Achat ponctuel d'un pack de crédits IA — cf. chapitre 6.4 du Volume 2.
  @Post('credit-packs/checkout')
  @Roles('ADMIN', 'OWNER')
  createCreditPackCheckout(@CurrentUser() user: AuthUser, @Body() dto: CreateCreditPackCheckoutDto) {
    return this.stripeService.createCreditPackCheckoutSession(user.organizationId, dto.pack, dto.successUrl, dto.cancelUrl);
  }
}
