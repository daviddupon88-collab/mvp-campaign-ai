import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  organizationId?: string;
  userId?: string;
}

// Propage un identifiant de corrélation à travers toute la durée de traitement d'une
// requête (middleware -> controller -> service -> logs), sans avoir à le faire transiter
// explicitement en paramètre de chaque appel de fonction — c'est ce qui permet de retrouver
// tous les logs d'une même requête HTTP en filtrant sur un seul requestId, y compris ceux
// émis depuis un service profondément imbriqué qui n'a jamais reçu la requête HTTP elle-même.
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(context: RequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  get(): RequestContext | undefined {
    return this.storage.getStore();
  }

  setUser(organizationId: string, userId: string): void {
    const ctx = this.storage.getStore();
    if (ctx) {
      ctx.organizationId = organizationId;
      ctx.userId = userId;
    }
  }
}
