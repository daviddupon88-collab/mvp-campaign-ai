import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { roleLevel } from '../role-hierarchy';

// Applique la hiérarchie RBAC décrite dans le business plan :
// Owner > Admin > Marketing Manager > Editor > Viewer.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('Utilisateur non authentifié');

    const userLevel = roleLevel(user.role);
    const minRequiredLevel = Math.min(...requiredRoles.map((r) => roleLevel(r)));

    if (userLevel < minRequiredLevel) {
      throw new ForbiddenException('Rôle insuffisant pour cette action');
    }
    return true;
  }
}
