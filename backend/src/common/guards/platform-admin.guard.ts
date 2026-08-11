import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

// Distinct de RolesGuard (qui vérifie le rôle RBAC PAR ORGANISATION, ex: OWNER, ADMIN) :
// ce guard vérifie un accès PLATEFORME transverse, hors du principe d'isolation multi-tenant
// — réservé à l'équipe opérant Campaign-ai elle-même (support, ops), jamais accordé à un
// client aussi haut placé soit-il dans sa propre organisation. cf. User.isPlatformAdmin,
// jamais activé automatiquement (pas de rôle qui s'y convertit), seulement via une
// intervention manuelle en base — volontairement sans self-service pour ce niveau d'accès.
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!request.user?.isPlatformAdmin) {
      throw new ForbiddenException('Accès réservé à l\'équipe Campaign-ai');
    }
    return true;
  }
}
