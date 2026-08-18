import { CampaignGenerationProcessor } from './campaign-generation.processor';

function buildGenerationResult(overrides: Record<string, any> = {}) {
  return {
    productAnalysis: { content: 'analyse' },
    strategy: { content: 'stratégie' },
    channelContent: { instagram: { content: 'texte instagram' }, linkedin: { content: 'texte linkedin' } },
    visual: { content: 'https://provider.example/image.png', generationId: 'gen-image-1' },
    video: null as any,
    narration: null as any,
    transcript: null as any,
    ...overrides,
  };
}

function buildProcessor(overrides?: {
  generateCampaign?: jest.Mock;
  moderationResult?: any;
  brandResult?: any;
  uploadFromUrl?: jest.Mock;
  upload?: jest.Mock;
  finalize?: jest.Mock;
}) {
  const orchestrator = {
    generateCampaign: overrides?.generateCampaign ?? jest.fn().mockResolvedValue(buildGenerationResult()),
  } as any;
  const moderation = {
    runCampaignModeration: jest.fn().mockResolvedValue(
      overrides?.moderationResult ?? { verdict: 'PASSED', checks: [{ status: 'PASSED', checkType: 'TOXICITY', label: 'x', summary: 'ok' }] },
    ),
  } as any;
  const brandConsistency = {
    runCampaignBrandCheck: jest.fn().mockResolvedValue(overrides?.brandResult ?? { overallScore: 82, checks: [] }),
  } as any;
  const createPiece = jest.fn().mockResolvedValue({ id: 'piece-1' });
  const contentStudio = { createPiece } as any;
  // Compteur plutôt qu'un id fixe par type : deux Assets VIDEO peuvent désormais être
  // enregistrés dans le même job (la vidéo brute ET, si l'assemblage réussit, la vidéo finale
  // composite) — un id fixe par type masquerait un bug de confusion entre les deux.
  let registerCallCount = 0;
  const register = jest.fn().mockImplementation((data) => Promise.resolve({ id: `asset-${data.type}-${++registerCallCount}`, ...data }));
  const assets = { register } as any;
  const uploadFromUrl = overrides?.uploadFromUrl ?? jest.fn().mockResolvedValue({ url: 'https://storage.example/rehosted.png', key: 'key-1' });
  const upload = overrides?.upload ?? jest.fn().mockResolvedValue({ url: 'https://storage.example/final.mp4', key: 'key-final' });
  const storage = { uploadFromUrl, upload } as any;
  const campaignUpdate = jest.fn().mockResolvedValue({ id: 'campaign-1', name: 'Campagne test' });
  const prisma = { campaign: { update: campaignUpdate } } as any;
  const notifyOrganization = jest.fn().mockResolvedValue(undefined);
  const notifications = { notifyOrganization } as any;
  // Par défaut : "skipped", comme en mode mock/dev sans média réel à assembler — les tests qui
  // veulent un assemblage réussi ou un échec le précisent explicitement.
  const finalize = overrides?.finalize ?? jest.fn().mockResolvedValue({ status: 'skipped', reason: 'narration non réelle (test)' });
  const videoFinalization = { finalize } as any;

  const processor = new CampaignGenerationProcessor(
    orchestrator,
    moderation,
    brandConsistency,
    contentStudio,
    assets,
    storage,
    prisma,
    notifications,
    videoFinalization,
  );

  return { processor, orchestrator, campaignUpdate, notifyOrganization, createPiece, register, uploadFromUrl, upload, finalize, moderation, brandConsistency };
}

function buildJob(attemptsMade: number, attempts: number) {
  return {
    id: 'job-1',
    data: { organizationId: 'org-1', campaignId: 'campaign-1', objective: 'x' },
    attemptsMade,
    opts: { attempts },
  } as any;
}

// Couvre la correction du bug identifié à l'audit : une exception pendant la génération
// (crédits épuisés, panne fournisseur) ne mettait jamais à jour la campagne, qui restait
// IN_PROGRESS indéfiniment sans notification — cf. plan de correction, Phase 1.
describe('CampaignGenerationProcessor — gestion des échecs', () => {
  it("relance l'exception sans toucher la campagne quand il reste des tentatives BullMQ", async () => {
    const generateCampaign = jest.fn().mockRejectedValue(new Error('panne'));
    const { processor, campaignUpdate, notifyOrganization } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 2); // 1ère tentative sur 2 autorisées

    await expect(processor.process(job)).rejects.toThrow('panne');
    expect(campaignUpdate).not.toHaveBeenCalled();
    expect(notifyOrganization).not.toHaveBeenCalled();
  });

  it('marque la campagne FAILED avec un motif lisible quand la dernière tentative échoue, sans relancer l\'exception', async () => {
    const generateCampaign = jest.fn().mockRejectedValue(new Error('panne'));
    const { processor, campaignUpdate, notifyOrganization } = buildProcessor({ generateCampaign });
    const job = buildJob(1, 2); // 2ème et dernière tentative

    const result = await processor.process(job);

    expect(result).toEqual(expect.objectContaining({ campaignStatus: 'FAILED' }));
    expect(campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'campaign-1' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    expect(notifyOrganization).toHaveBeenCalledWith(
      'org-1',
      ['MARKETING_MANAGER', 'ADMIN', 'OWNER'],
      expect.objectContaining({ type: 'CAMPAIGN_GENERATION_FAILED' }),
    );
  });

  it('traduit une erreur de crédits en message utilisateur clair, jamais la trace technique brute', async () => {
    const generateCampaign = jest.fn().mockRejectedValue(new Error('Quota de crédits IA atteint (500/500)'));
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 1); // une seule tentative autorisée -> dernière d'office

    await processor.process(job);

    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('Crédits IA insuffisants');
    expect(call.data.failureReason).not.toContain('500/500');
  });

  it('single tentative configurée (attempts=1) : le tout premier échec est déjà définitif', async () => {
    const generateCampaign = jest.fn().mockRejectedValue(new Error('panne'));
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 1);

    await processor.process(job);

    expect(campaignUpdate).toHaveBeenCalled();
  });
});

// Chemin de succès de processInternal() — jamais couvert avant cette passe (audit du
// 2026-08-13) : persistance du contenu généré, verdicts de modération, notification.
describe('CampaignGenerationProcessor — chemin de succès (persistance + modération)', () => {
  it('PASSED : persiste un ContentPiece TEXT par canal + un IMAGE, passe la campagne à READY_FOR_REVIEW, notifie', async () => {
    const { processor, campaignUpdate, notifyOrganization, createPiece, moderation } = buildProcessor();
    const job = buildJob(0, 2);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('READY_FOR_REVIEW');
    // Chantier "valider seulement si l'objectif est atteint" (2026-08-18) : l'objectif de la
    // campagne (job.data.objective) doit être transmis à ModerationService — c'est lui qui en a
    // besoin pour le check OBJECTIVE_ACHIEVEMENT.
    expect(moderation.runCampaignModeration).toHaveBeenCalledWith('org-1', 'campaign-1', 'x', expect.any(Array), expect.any(Array));
    // 2 canaux (instagram, linkedin) + 1 image = 3 pièces de contenu.
    expect(createPiece).toHaveBeenCalledTimes(3);
    expect(createPiece).toHaveBeenCalledWith(expect.objectContaining({ channel: 'instagram', type: 'TEXT', body: 'texte instagram' }));
    expect(createPiece).toHaveBeenCalledWith(expect.objectContaining({ channel: 'linkedin', type: 'TEXT', body: 'texte linkedin' }));
    expect(createPiece).toHaveBeenCalledWith(expect.objectContaining({ type: 'IMAGE', assetId: 'asset-IMAGE-1' }));
    expect(campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'campaign-1' }, data: expect.objectContaining({ status: 'READY_FOR_REVIEW', moderationVerdict: 'PASSED', brandConsistencyScore: 82 }) }),
    );
    expect(notifyOrganization).toHaveBeenCalledWith(
      'org-1',
      ['MARKETING_MANAGER', 'ADMIN', 'OWNER'],
      expect.objectContaining({ type: 'CAMPAIGN_READY_FOR_REVIEW' }),
    );
  });

  it('FLAGGED : reste READY_FOR_REVIEW (le flag informe le validateur, ne bloque jamais automatiquement)', async () => {
    const { processor, campaignUpdate, notifyOrganization } = buildProcessor({
      moderationResult: { verdict: 'FLAGGED', checks: [{ status: 'FLAGGED', checkType: 'MISLEADING_CLAIMS', label: 'x', summary: 'à vérifier' }] },
    });
    const job = buildJob(0, 2);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('READY_FOR_REVIEW');
    expect(campaignUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'READY_FOR_REVIEW', moderationVerdict: 'FLAGGED' }) }));
    expect(notifyOrganization).toHaveBeenCalledWith('org-1', expect.anything(), expect.objectContaining({ type: 'CAMPAIGN_READY_FOR_REVIEW' }));
  });

  it('BLOCKED : rejette automatiquement, motif inclut le résumé des vérifications bloquées, AUCUNE notification envoyée', async () => {
    const { processor, campaignUpdate, notifyOrganization } = buildProcessor({
      moderationResult: {
        verdict: 'BLOCKED',
        checks: [
          { status: 'BLOCKED', checkType: 'TOXICITY', label: 'instagram', summary: 'contenu haineux détecté' },
          { status: 'PASSED', checkType: 'MISLEADING_CLAIMS', label: 'instagram', summary: 'ok' },
        ],
      },
    });
    const job = buildJob(0, 2);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('REJECTED');
    expect(campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REJECTED', moderationVerdict: 'BLOCKED', rejectionReason: expect.stringContaining('contenu haineux détecté') }) }),
    );
    // Contrairement à READY_FOR_REVIEW et FAILED, un rejet automatique n'envoie aujourd'hui
    // aucune notification — comportement existant, verrouillé ici pour qu'un futur changement
    // soit délibéré plutôt qu'une régression silencieuse.
    expect(notifyOrganization).not.toHaveBeenCalled();
  });

  it('sans vidéo générée (results.video null) : aucun ContentPiece VIDEO créé', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult({ video: null }));
    const { processor, createPiece } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 2);

    await processor.process(job);

    expect(createPiece).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO' }));
  });

  it("avec vidéo générée mais sans narration (results.narration null) : ContentPiece VIDEO pointe directement sur la vidéo brute, aucun appel à l'assemblage", async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { linkedin: { content: 'texte linkedin' }, tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
      }),
    );
    const { processor, createPiece, register, finalize } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 2);

    await processor.process(job);

    // linkedin est listé en premier dans channelContent, mais la vidéo doit aller sur tiktok
    // (canal natif vidéo), pas sur targetChannels[0] par défaut.
    expect(createPiece).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO', channel: 'tiktok', assetId: 'asset-VIDEO-2' }));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO', generationId: 'gen-video-1' }));
    expect(finalize).not.toHaveBeenCalled();
    // Aucun ContentPiece AUDIO — la narration (absente ici) n'est jamais un livrable à part.
    expect(createPiece).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'AUDIO' }));
  });

  it('vidéo + narration, assemblage réussi : le ContentPiece VIDEO pointe sur la vidéo FINALE assemblée, pas sur la vidéo brute — aucun ContentPiece AUDIO séparé', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
        transcript: [{ start: 0, end: 1, text: 'Salut' }],
      }),
    );
    const finalBuffer = Buffer.from('final-mp4-bytes');
    const finalize = jest.fn().mockResolvedValue({ status: 'assembled', buffer: finalBuffer, mimeType: 'video/mp4', durationSeconds: 12 });
    const { processor, createPiece, register, upload } = buildProcessor({ generateCampaign, finalize });
    const job = buildJob(0, 2);

    await processor.process(job);

    expect(finalize).toHaveBeenCalledWith({
      rawVideoUrl: 'https://provider.example/video.mp4',
      narrationDataUri: 'data:audio/mpeg;base64,ZmFrZQ==',
      transcript: [{ start: 0, end: 1, text: 'Salut' }],
    });
    expect(upload).toHaveBeenCalledWith('org-1', finalBuffer, 'campaign-final.mp4', 'video/mp4');
    // Séquence d'enregistrement : 1=IMAGE (visuel), 2=VIDEO (brute), 3=AUDIO (narration brute), 4=VIDEO (finale).
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO', generationId: 'gen-video-1' })); // brute
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: 'AUDIO', generationId: 'gen-audio-1' })); // narration brute
    expect(register).toHaveBeenCalledTimes(4);
    const finalRegisterCall = register.mock.calls[3][0];
    expect(finalRegisterCall).toEqual(expect.objectContaining({ type: 'VIDEO', url: 'https://storage.example/final.mp4' }));
    expect(finalRegisterCall.generationId).toBeUndefined(); // composite, aucune AiGeneration unique ne le représente
    expect(createPiece).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO', channel: 'tiktok', assetId: 'asset-VIDEO-4' }));
    expect(createPiece).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'AUDIO' }));
  });

  it('vidéo + narration, assemblage "skipped" (mode mock) : repli sur la vidéo brute comme sans narration', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'https://example.com/mock-narration.mp3', generationId: 'gen-audio-1' },
      }),
    );
    const finalize = jest.fn().mockResolvedValue({ status: 'skipped', reason: 'mode mock' });
    const { processor, createPiece, finalize: finalizeRef } = buildProcessor({ generateCampaign, finalize });
    const job = buildJob(0, 2);

    await processor.process(job);

    expect(finalizeRef).toHaveBeenCalledTimes(1);
    // Repli : assetId de la vidéo brute (2e registre : 1=IMAGE, 2=VIDEO brute, 3=AUDIO brute).
    expect(createPiece).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO', channel: 'tiktok', assetId: 'asset-VIDEO-2' }));
  });

  it("échec de l'assemblage vidéo final (ffmpeg/QC) : la campagne échoue avec le motif dédié, jamais silencieusement acceptée", async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
      }),
    );
    const finalize = jest.fn().mockRejectedValue(new Error("Échec du contrôle qualité de la vidéo finale : Aucun flux audio détecté"));
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign, finalize });
    const job = buildJob(0, 1); // dernière tentative d'office

    const result = await processor.process(job);

    expect(result).toEqual(expect.objectContaining({ campaignStatus: 'FAILED' }));
    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('assemblage final de la vidéo');
  });

  it('rehébergement du visuel échoué (uploadFromUrl renvoie null) : se rabat sur l\'URL d\'origine du fournisseur plutôt que d\'échouer', async () => {
    const uploadFromUrl = jest.fn().mockResolvedValue(null);
    const { processor, register } = buildProcessor({ uploadFromUrl });
    const job = buildJob(0, 2);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('READY_FOR_REVIEW'); // n'échoue pas toute la campagne
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: 'IMAGE', url: 'https://provider.example/image.png', storageKey: undefined }));
  });
});
