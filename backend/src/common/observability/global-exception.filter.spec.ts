import { HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { RequestContextService } from '../logging/request-context.service';
import { PrismaService } from '../../prisma/prisma.service';

function buildHost(method = 'GET', url = '/api/campaigns') {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { method, url };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as any;
  return { host, status, json };
}

// Vérifie explicitement l'ajout du journal d'erreurs HTTP dédié (README item 46) : une
// erreur serveur (5xx) doit être persistée dans HttpErrorLog, jamais une 4xx (comportement
// attendu de l'API, pas un incident) — et un échec d'écriture de ce journal ne doit jamais
// empêcher la réponse d'être envoyée (même logique best-effort qu'AuditService).
describe('GlobalExceptionFilter — journal d\'erreurs HTTP', () => {
  const requestContext = { get: () => ({ requestId: 'req-1', organizationId: 'org-1' }) } as unknown as RequestContextService;

  it('persiste une erreur serveur (500) dans HttpErrorLog', async () => {
    const httpErrorLogCreate = jest.fn().mockResolvedValue({});
    const prisma = { httpErrorLog: { create: httpErrorLogCreate } } as unknown as PrismaService;
    const filter = new GlobalExceptionFilter(requestContext, prisma);
    const { host, status } = buildHost('POST', '/api/campaigns');

    filter.catch(new Error('base indisponible'), host);
    // fire-and-forget : laisse le microtask de .create() s'exécuter avant d'asserter.
    await Promise.resolve();
    await Promise.resolve();

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(httpErrorLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        method: 'POST',
        path: '/api/campaigns',
        statusCode: 500,
        message: 'base indisponible',
        requestId: 'req-1',
        organizationId: 'org-1',
      }),
    });
  });

  it('ne persiste jamais une erreur 4xx (comportement attendu de l\'API, pas un incident)', async () => {
    const httpErrorLogCreate = jest.fn().mockResolvedValue({});
    const prisma = { httpErrorLog: { create: httpErrorLogCreate } } as unknown as PrismaService;
    const filter = new GlobalExceptionFilter(requestContext, prisma);
    const { host, status } = buildHost();

    filter.catch(new BadRequestException('Champ invalide'), host);
    await Promise.resolve();

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(httpErrorLogCreate).not.toHaveBeenCalled();
  });

  it('un échec d\'écriture du journal ne bloque ni ne retarde la réponse déjà envoyée', () => {
    const prisma = { httpErrorLog: { create: jest.fn().mockRejectedValue(new Error('DB down')) } } as unknown as PrismaService;
    const filter = new GlobalExceptionFilter(requestContext, prisma);
    const { host, status, json } = buildHost();

    // Ne doit pas lever, même si l'écriture du journal échouera de façon asynchrone —
    // la réponse HTTP est déjà envoyée de façon synchrone avant que ce rejet ne survienne.
    expect(() => filter.catch(new Error('panne'), host)).not.toThrow();
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalled();
  });

  it('fonctionne toujours sans PrismaService fourni (constructeur sans second argument)', () => {
    const filter = new GlobalExceptionFilter(requestContext);
    const { host, status } = buildHost();

    expect(() => filter.catch(new Error('panne'), host)).not.toThrow();
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('propage les champs structurés d\'une exception (ex: PlanLimitExceededException), pas seulement .message', () => {
    const filter = new GlobalExceptionFilter(requestContext);
    const { host, json } = buildHost();

    filter.catch(new HttpException({ message: 'Plafond atteint', code: 'PLAN_LIMIT_EXCEEDED', recommendedPlan: 'growth' }, HttpStatus.FORBIDDEN), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Plafond atteint', code: 'PLAN_LIMIT_EXCEEDED', recommendedPlan: 'growth' }),
    );
  });
});
