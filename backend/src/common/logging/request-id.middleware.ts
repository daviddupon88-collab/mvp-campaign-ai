import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { RequestContextService } from './request-context.service';

// Réutilise un X-Request-Id entrant s'il existe (utile derrière un load balancer ou une
// passerelle API qui en génère déjà un), sinon en génère un nouveau — et le renvoie
// systématiquement dans la réponse pour que le client puisse le fournir en cas de support.
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly requestContext: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('X-Request-Id', requestId);

    this.requestContext.run({ requestId }, () => next());
  }
}
