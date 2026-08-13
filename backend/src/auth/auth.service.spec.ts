import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

function buildPrismaMock(updateImpl: jest.Mock) {
  return { user: { update: updateImpl } } as unknown as PrismaService;
}

// Couvre uniquement updateLanguage() — la préférence de langue de l'interface, qui ne doit
// jamais toucher/lire la langue de génération de campagne (paramètre indépendant).
describe('AuthService.updateLanguage', () => {
  it('persists the preferred language on the current user only', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'user-1', preferredLanguage: 'de' });
    const service = new AuthService(buildPrismaMock(update), {} as any);

    const result = await service.updateLanguage('user-1', 'de');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { preferredLanguage: 'de' },
      select: { id: true, preferredLanguage: true },
    });
    expect(result).toEqual({ id: 'user-1', preferredLanguage: 'de' });
  });
});
