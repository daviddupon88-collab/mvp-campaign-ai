import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  sub: string;
  email: string;
  organizationId: string;
  role: string;
  isPlatformAdmin?: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'dev-secret-change-me'),
    });
  }

  // Le retour de validate() devient request.user — c'est ici que
  // organizationId circule ensuite dans tous les guards/services (isolation multi-tenant),
  // et isPlatformAdmin dans PlatformAdminGuard (accès transverse, hors isolation par tenant).
  async validate(payload: JwtPayload) {
    return {
      userId: payload.sub,
      email: payload.email,
      organizationId: payload.organizationId,
      role: payload.role,
      isPlatformAdmin: payload.isPlatformAdmin ?? false,
    };
  }
}
