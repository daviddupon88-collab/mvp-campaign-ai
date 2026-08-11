import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Point d'accès en lecture à l'abonnement. La logique de quotas et de blocage
// (crédits, sièges, campagnes actives, statut d'abonnement) vit désormais entièrement
// dans EntitlementsService (src/plans/entitlements.service.ts) — source de vérité unique
// pour éviter que deux services dérivent silencieusement l'un de l'autre sur les mêmes règles.
@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getSubscription(organizationId: string) {
    return this.prisma.subscription.findUnique({ where: { organizationId } });
  }
}
