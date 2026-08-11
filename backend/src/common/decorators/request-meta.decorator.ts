import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Extrait IP et user-agent de la requête pour les inclure dans un AuditContext, sans
// dupliquer cette logique dans chaque controller qui journalise une action sensible.
export const RequestMeta = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return {
    ipAddress: request.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? request.ip,
    userAgent: request.headers['user-agent'],
  };
});
