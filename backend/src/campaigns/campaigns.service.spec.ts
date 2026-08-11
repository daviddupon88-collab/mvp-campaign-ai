import { ForbiddenException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../plans/entitlements.service';
import { CampaignTemplatesService } from '../campaign-templates/campaign-templates.service';

function buildService(overrides?: { campaignFindFirst?: any }) {
  const campaignCreate = jest.fn().mockResolvedValue({ id: 'campaign-1' });
  const campaignUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    campaign: {
      create: campaignCreate,
      update: campaignUpdate,
      findFirst: jest.fn().mockResolvedValue(overrides?.campaignFindFirst ?? { id: 'campaign-1', status: 'REJECTED', channels: [] }),
    },
  } as unknown as PrismaService;

  const queue = { add: jest.fn().mockResolvedValue({}) } as any;

  const assertChannelsAllowed = jest.fn().mockResolvedValue(undefined);
  const entitlements = {
    assertActiveSubscription: jest.fn().mockResolvedValue(undefined),
    assertActiveCampaignAvailable: jest.fn().mockResolvedValue(undefined),
    assertCreditsAvailable: jest.fn().mockResolvedValue(undefined),
    assertChannelAvailable: jest.fn().mockResolvedValue(undefined),
    assertChannelsAllowed,
  } as unknown as EntitlementsService;

  const templatesService = {} as unknown as CampaignTemplatesService;

  const service = new CampaignsService(prisma, queue, templatesService, entitlements);
  return { service, prisma, queue, entitlements, assertChannelsAllowed, campaignCreate };
}

// Vérifie la correction du gap identifié dans le README (item 55) : la restriction de
// canaux par plateforme (PlanDefinition.allowedChannels, ex: essai limité à Meta/LinkedIn)
// n'était appliquée qu'à la publication réelle (PublishingService), jamais à la création —
// un compte en essai pouvait sélectionner Google Ads/TikTok dans le wizard, payer la
// génération de contenu en crédits, et découvrir le refus seulement à la diffusion.
describe('CampaignsService — restriction de canaux à la création', () => {
  const baseDto = { name: 'Campagne', productDescription: 'Produit', objective: 'Objectif' };

  it('autorise la création avec des canaux mappés vers des plateformes permises', async () => {
    const { service, assertChannelsAllowed, campaignCreate } = buildService();

    await service.create('org-1', { ...baseDto, channels: ['facebook', 'linkedin'] });

    expect(assertChannelsAllowed).toHaveBeenCalledWith('org-1', ['META_FACEBOOK', 'LINKEDIN']);
    expect(campaignCreate).toHaveBeenCalled();
  });

  it('refuse la création si un canal choisi (googleads) n\'est pas autorisé par le plan — AVANT toute création en base', async () => {
    const { service, entitlements, campaignCreate } = buildService();
    (entitlements.assertChannelsAllowed as jest.Mock).mockRejectedValue(
      new ForbiddenException("Le plan Essai gratuit n'inclut pas GOOGLE_ADS"),
    );

    await expect(service.create('org-1', { ...baseDto, channels: ['facebook', 'googleads'] })).rejects.toThrow(ForbiddenException);
    expect(campaignCreate).not.toHaveBeenCalled();
  });

  it('ne vérifie jamais allowedChannels pour "email" — pas un canal de diffusion social', async () => {
    const { service, assertChannelsAllowed } = buildService();

    await service.create('org-1', { ...baseDto, channels: ['email'] });

    expect(assertChannelsAllowed).not.toHaveBeenCalled();
  });

  it("n'appelle pas assertChannelsAllowed quand aucun canal n'est sélectionné", async () => {
    const { service, assertChannelsAllowed } = buildService();

    await service.create('org-1', { ...baseDto });

    expect(assertChannelsAllowed).not.toHaveBeenCalled();
  });

  it('applique la même restriction à la régénération quand des canaux sont explicitement fournis', async () => {
    const { service, assertChannelsAllowed } = buildService();

    await service.regenerate('org-1', 'campaign-1', { ...baseDto, channels: ['tiktok'] });

    expect(assertChannelsAllowed).toHaveBeenCalledWith('org-1', ['TIKTOK']);
  });

  it('la régénération sans nouveaux canaux ne revalide pas ceux déjà enregistrés', async () => {
    const { service, assertChannelsAllowed } = buildService();

    await service.regenerate('org-1', 'campaign-1', { ...baseDto });

    expect(assertChannelsAllowed).not.toHaveBeenCalled();
  });
});
