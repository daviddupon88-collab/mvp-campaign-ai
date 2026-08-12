import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { PrismaService } from '../prisma/prisma.service';
import { EntitlementsService } from '../plans/entitlements.service';
import { CampaignTemplatesService } from '../campaign-templates/campaign-templates.service';

function buildService(overrides?: { campaignFindFirst?: any; assetFindFirst?: any }) {
  const campaignCreate = jest.fn().mockResolvedValue({ id: 'campaign-1' });
  const campaignUpdate = jest.fn().mockResolvedValue({});
  const assetFindFirst = jest.fn().mockResolvedValue(overrides?.assetFindFirst);
  const prisma = {
    campaign: {
      create: campaignCreate,
      update: campaignUpdate,
      findFirst: jest.fn().mockResolvedValue(overrides?.campaignFindFirst ?? { id: 'campaign-1', status: 'REJECTED', channels: [] }),
    },
    asset: {
      findFirst: assetFindFirst,
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
  return { service, prisma, queue, entitlements, assertChannelsAllowed, campaignCreate, campaignUpdate, assetFindFirst };
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

// Vérifie le flux d'upload photo dans le wizard de création ("une photo suffit", cf. gap
// identifié entre la promesse de la landing page et le wizard réel — jusqu'ici aucune photo
// n'était jamais transmise à l'Orchestrator IA).
describe('CampaignsService — photo produit à la création', () => {
  const IMAGE_ASSET = { id: 'asset-1', organizationId: 'org-1', type: 'IMAGE', url: 'https://storage.example.com/asset-1.png' };

  it('refuse la création si ni description ni photo ne sont fournies', async () => {
    const { service, campaignCreate } = buildService();

    await expect(
      service.create('org-1', { name: 'Campagne', objective: 'Objectif' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(campaignCreate).not.toHaveBeenCalled();
  });

  it('autorise la création avec une photo seule, sans description texte', async () => {
    const { service, campaignCreate, assetFindFirst } = buildService({ assetFindFirst: IMAGE_ASSET });

    await service.create('org-1', { name: 'Campagne', objective: 'Objectif', productImageAssetId: 'asset-1' } as any);

    expect(assetFindFirst).toHaveBeenCalledWith({ where: { id: 'asset-1', organizationId: 'org-1', type: 'IMAGE' } });
    expect(campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productImageUrl: 'https://storage.example.com/asset-1.png' }) }),
    );
  });

  it('transmet productImageUrl résolue au job de génération, en plus de la persister sur la campagne', async () => {
    const { service, queue } = buildService({ assetFindFirst: IMAGE_ASSET });

    await service.create('org-1', { name: 'Campagne', objective: 'Objectif', productImageAssetId: 'asset-1' } as any);

    expect(queue.add).toHaveBeenCalledWith(
      'generate',
      expect.objectContaining({ productImageUrl: 'https://storage.example.com/asset-1.png' }),
    );
  });

  it('refuse (NotFoundException) si l\'asset référencé n\'existe pas ou n\'appartient pas à l\'organisation — jamais d\'URL externe acceptée telle quelle', async () => {
    const { service, campaignCreate } = buildService({ assetFindFirst: null });

    await expect(
      service.create('org-1', { name: 'Campagne', objective: 'Objectif', productImageAssetId: 'asset-inconnu' } as any),
    ).rejects.toThrow(NotFoundException);
    expect(campaignCreate).not.toHaveBeenCalled();
  });

  it('sans productImageAssetId, ne consulte jamais la table asset et ne fixe pas productImageUrl', async () => {
    const { service, campaignCreate, assetFindFirst } = buildService();

    await service.create('org-1', { name: 'Campagne', objective: 'Objectif', productDescription: 'Un produit' } as any);

    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productImageUrl: undefined }) }),
    );
  });

  it('régénération : réutilise la photo déjà enregistrée sur la campagne quand aucune nouvelle photo n\'est fournie', async () => {
    const { service, campaignUpdate, assetFindFirst } = buildService({
      campaignFindFirst: { id: 'campaign-1', status: 'REJECTED', channels: [], productImageUrl: 'https://storage.example.com/ancienne.png' },
    });

    await service.regenerate('org-1', 'campaign-1', { name: 'Campagne', productDescription: 'Produit', objective: 'Objectif' } as any);

    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productImageUrl: 'https://storage.example.com/ancienne.png' }) }),
    );
  });

  it('régénération : une nouvelle photo fournie remplace l\'ancienne', async () => {
    const { service, campaignUpdate } = buildService({
      campaignFindFirst: { id: 'campaign-1', status: 'REJECTED', channels: [], productImageUrl: 'https://storage.example.com/ancienne.png' },
      assetFindFirst: IMAGE_ASSET,
    });

    await service.regenerate('org-1', 'campaign-1', {
      name: 'Campagne',
      productDescription: 'Produit',
      objective: 'Objectif',
      productImageAssetId: 'asset-1',
    } as any);

    expect(campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ productImageUrl: 'https://storage.example.com/asset-1.png' }) }),
    );
  });
});
