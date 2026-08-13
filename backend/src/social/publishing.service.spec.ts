import { ForbiddenException } from '@nestjs/common';
import { PublishingService } from './publishing.service';

function buildService(campaign: any, overrides?: { publishedPostFindUnique?: any }) {
  const campaignFindFirst = jest.fn().mockResolvedValue(campaign);
  const campaignFindUnique = jest.fn().mockResolvedValue(campaign);
  const campaignUpdate = jest.fn().mockResolvedValue({});
  const publishedPostFindUnique = jest.fn().mockResolvedValue(overrides?.publishedPostFindUnique ?? null);
  const publishedPostUpsert = jest.fn().mockResolvedValue({ id: 'post-1' });
  const publishedPostUpdate = jest.fn().mockImplementation((args: any) => Promise.resolve({ id: 'post-1', ...args.data }));

  const prisma = {
    campaign: { findFirst: campaignFindFirst, findUnique: campaignFindUnique, update: campaignUpdate },
    publishedPost: { findUnique: publishedPostFindUnique, upsert: publishedPostUpsert, update: publishedPostUpdate },
  } as any;

  const adapterPublish = jest.fn().mockResolvedValue({ externalPostId: 'ext-1' });
  const connectionsService = {
    getActiveConnection: jest.fn().mockResolvedValue({ id: 'conn-1', platform: 'META_FACEBOOK', accessToken: 'token', externalAccountId: 'acc-1' }),
    getAdapterFor: jest.fn().mockReturnValue({ publish: adapterPublish }),
  } as any;

  const entitlements = {
    assertActiveSubscription: jest.fn().mockResolvedValue(undefined),
    assertSocialPostQuotaAvailable: jest.fn().mockResolvedValue(undefined),
    assertChannelsAllowed: jest.fn().mockResolvedValue(undefined),
  } as any;

  const brandService = { logMemory: jest.fn().mockResolvedValue(undefined) } as any;

  const service = new PublishingService(prisma, connectionsService, entitlements, brandService);
  return { service, campaignUpdate, adapterPublish, publishedPostUpsert, prisma };
}

const BASE_REQUEST = { organizationId: 'org-1', campaignId: 'campaign-1', socialConnectionId: 'conn-1' };

// Couvre la correction de l'audit : le calendrier éditorial (ScheduledPublishingService)
// appelait publishToChannel() directement, qui ne vérifiait jamais le statut APPROVED de la
// campagne (contrairement à publishToMultipleChannels) — une campagne DRAFT/REJECTED/bloquée
// par la modération pouvait donc être publiée telle quelle par le cron. Le contrôle est
// désormais fait DANS publishToChannel() elle-même, donc hérité par tout appelant.
describe('PublishingService.publishToChannel — vérification APPROVED', () => {
  it('refuse de publier une campagne qui n\'est pas APPROVED (ex: DRAFT) — le chemin exact contourné avant la correction', async () => {
    const { service, adapterPublish } = buildService({ id: 'campaign-1', status: 'DRAFT' });

    await expect(service.publishToChannel(BASE_REQUEST)).rejects.toThrow(ForbiddenException);
    expect(adapterPublish).not.toHaveBeenCalled();
  });

  it('refuse de publier une campagne REJECTED', async () => {
    const { service, adapterPublish } = buildService({ id: 'campaign-1', status: 'REJECTED' });

    await expect(service.publishToChannel(BASE_REQUEST)).rejects.toThrow(ForbiddenException);
    expect(adapterPublish).not.toHaveBeenCalled();
  });

  it('publie normalement une campagne APPROVED', async () => {
    const { service, adapterPublish } = buildService({ id: 'campaign-1', status: 'APPROVED' });

    const result = await service.publishToChannel(BASE_REQUEST);

    expect(adapterPublish).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('PUBLISHED');
  });

  it('un incident DB transitoire après un succès plateforme est absorbé par un retry, sans jamais rappeler adapter.publish() plusieurs fois', async () => {
    const { service, adapterPublish, prisma } = buildService({ id: 'campaign-1', status: 'APPROVED' });
    prisma.publishedPost.update
      .mockRejectedValueOnce(new Error('DB indisponible'))
      .mockRejectedValueOnce(new Error('DB indisponible'))
      .mockImplementationOnce((args: any) => Promise.resolve({ id: 'post-1', ...args.data }));

    const result = await service.publishToChannel(BASE_REQUEST);

    expect(adapterPublish).toHaveBeenCalledTimes(1); // jamais rappelé pour un problème d'écriture DB
    expect(result.status).toBe('PUBLISHED');
    expect(prisma.publishedPost.update).toHaveBeenCalledTimes(3);
  });

  it("un succès plateforme jamais enregistré (DB indisponible en continu) remonte l'erreur SANS marquer FAILED (qui inviterait à republier en double)", async () => {
    const { service, prisma } = buildService({ id: 'campaign-1', status: 'APPROVED' });
    prisma.publishedPost.update.mockRejectedValue(new Error('DB indisponible'));

    await expect(service.publishToChannel(BASE_REQUEST)).rejects.toThrow('DB indisponible');
    // Aucun appel n'a tenté de marquer le post FAILED — ça aurait laissé croire qu'un
    // nouveau retry pouvait rappeler adapter.publish() sans risque de doublon réel.
    expect(prisma.publishedPost.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
  });

  it("l'idempotence reste prioritaire : une publication déjà PUBLISHED ne revérifie même pas le statut de la campagne", async () => {
    const { service, adapterPublish } = buildService(
      { id: 'campaign-1', status: 'PUBLISHED' }, // la campagne est déjà passée à PUBLISHED après un premier succès
      { publishedPostFindUnique: { id: 'post-1', status: 'PUBLISHED' } },
    );

    const result = await service.publishToChannel(BASE_REQUEST);

    expect(adapterPublish).not.toHaveBeenCalled();
    expect(result.status).toBe('PUBLISHED');
  });
});

describe('PublishingService.publishToMultipleChannels — comportement inchangé pour le flux normal', () => {
  it('publie sur tous les canaux et fait passer la campagne à PUBLISHED en cas de succès', async () => {
    const { service, campaignUpdate } = buildService({ id: 'campaign-1', status: 'APPROVED', name: 'Campagne test', channels: ['facebook'] });

    const results = await service.publishToMultipleChannels([BASE_REQUEST]);

    expect(results).toHaveLength(1);
    expect(campaignUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PUBLISHED' } }));
  });

  it('refuse toujours la publication groupée sur une campagne non APPROVED', async () => {
    const { service } = buildService({ id: 'campaign-1', status: 'DRAFT' });

    await expect(service.publishToMultipleChannels([BASE_REQUEST])).rejects.toThrow(ForbiddenException);
  });
});
