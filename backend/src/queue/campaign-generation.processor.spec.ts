import { CampaignGenerationProcessor } from './campaign-generation.processor';
import { PlanLimitExceededException } from '../plans/plan-limit.exception';

function buildGenerationResult(overrides: Record<string, any> = {}) {
  return {
    productAnalysis: { content: 'analyse' },
    strategy: { content: 'stratégie' },
    channelContent: { instagram: { content: 'texte instagram' }, linkedin: { content: 'texte linkedin' } },
    visual: { content: 'https://provider.example/image.png', generationId: 'gen-image-1' },
    video: null as any,
    narration: null as any,
    transcript: null as any,
    // Creative Intelligence Engine & Video Quality Loop (2026-08-18) — champs additionnels
    // consommés par finalizeVideoAsset()/la modération élargie (P0.10), valeurs neutres par
    // défaut (les tests qui en ont besoin les précisent explicitement).
    videoClips: [],
    narrationText: 'narration par défaut',
    shotPlan: [],
    perShotQuality: new Map(),
    visualDnaResult: { productCategory: 'x', colors: [], materials: [], shape: 'x', distinctiveFeatures: [], logoOrBrandMarks: null, raw: '{}' },
    referenceImageUrl: 'https://provider.example/photo-source.png',
    creativeConcept: { title: 't', concept: 'c', coreMessage: 'm', hook: 'h', emotionalDirection: 'e', visualDirection: 'v', storytellingApproach: 's', proofStrategy: 'p', cta: 'cta', targetAudience: 'a', duration: 15, format: '9:16', scenesCount: 1, raw: '{}' },
    creativeIntelligence: { adObjective: 'x', targetAudience: 'x', primaryProblem: 'x', primaryDesire: 'x', primaryBenefit: 'x', valueProposition: 'x', creativeAngle: 'x', desiredEmotion: 'x', hook: 'x', proofToShow: 'x', objections: [], mainMessage: 'x', cta: 'x', visualTone: 'x', pacing: 'x', adStyle: 'x', raw: '{}' },
    productProfile: null,
    maxRepairAttempts: 2,
    // Phase J (chantier V2, 2026-08-19) — APPROVED par défaut : les tests de ce fichier vérifient
    // le câblage EN AVAL des portes amont (persistance, ContentPiece...), pas leur logique interne
    // (déjà couverte par creative-gate.service.spec.ts/storyboard-gate.service.spec.ts dédiés).
    creativeGateStatus: 'APPROVED',
    storyboardGateStatus: 'APPROVED',
    // Phase P (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — requis par
    // finalizeVideoAsset pour appeler regenerateShotPlanAndVideo/regenerateConceptStoryboardAndVideo
    // lors d'une escalade ; neutre par défaut (les tests d'escalade le précisent explicitement).
    effectiveParams: { organizationId: 'org-1', campaignId: 'campaign-1', objective: 'x', productDescription: 'produit par défaut' },
    ...overrides,
  };
}

// Repli PASSED par défaut, finalized 'skipped' — même intention que l'ancien mock `finalize`
// (repli mode mock/dev sans média réel à assembler). Les tests qui veulent un assemblage
// réussi/échoué/épuisé le précisent explicitement via `qualityLoopRun`.
function buildDefaultQualityLoopOutcome() {
  return { status: 'PASSED', finalized: { status: 'skipped', reason: 'narration non réelle (test)' }, lastJudge: null, attempts: [], transcript: null };
}

function buildProcessor(overrides?: {
  generateCampaign?: jest.Mock;
  moderationResult?: any;
  brandResult?: any;
  uploadFromUrl?: jest.Mock;
  upload?: jest.Mock;
  qualityLoopRun?: jest.Mock;
  regenerateShotPlanAndVideo?: jest.Mock;
  regenerateConceptStoryboardAndVideo?: jest.Mock;
}) {
  const orchestrator = {
    generateCampaign: overrides?.generateCampaign ?? jest.fn().mockResolvedValue(buildGenerationResult()),
    // Phase P — jamais appelés par les tests qui ne déclenchent pas d'escalade (cf. describe
    // dédié plus bas) ; un mock qui rejette par défaut ferait échouer bruyamment tout test qui
    // les appellerait par erreur, plutôt qu'un silencieux `undefined`.
    regenerateShotPlanAndVideo: overrides?.regenerateShotPlanAndVideo ?? jest.fn().mockRejectedValue(new Error('regenerateShotPlanAndVideo non attendu dans ce test')),
    regenerateConceptStoryboardAndVideo:
      overrides?.regenerateConceptStoryboardAndVideo ?? jest.fn().mockRejectedValue(new Error('regenerateConceptStoryboardAndVideo non attendu dans ce test')),
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
  // Phase Q (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — getTotalCreditsForCampaign
  // agrège AiGeneration.costEstimate pour la campagne ; 0 par défaut (les tests dédiés au montant
  // exact le surchargent explicitement).
  const aiGenerationAggregate = jest.fn().mockResolvedValue({ _sum: { costEstimate: 0 } });
  const prisma = { campaign: { update: campaignUpdate }, aiGeneration: { aggregate: aiGenerationAggregate } } as any;
  const notifyOrganization = jest.fn().mockResolvedValue(undefined);
  const notifications = { notifyOrganization } as any;

  const qualityLoopRun = overrides?.qualityLoopRun ?? jest.fn().mockResolvedValue(buildDefaultQualityLoopOutcome());
  const videoQualityLoop = { run: qualityLoopRun } as any;
  const upsertTrace = jest.fn().mockResolvedValue(undefined);
  const creativeGenerationTrace = { upsertTrace } as any;

  const processor = new CampaignGenerationProcessor(
    orchestrator,
    moderation,
    brandConsistency,
    contentStudio,
    assets,
    storage,
    prisma,
    notifications,
    videoQualityLoop,
    creativeGenerationTrace,
  );

  return { processor, orchestrator, campaignUpdate, notifyOrganization, createPiece, register, uploadFromUrl, upload, qualityLoopRun, upsertTrace, moderation, brandConsistency, aiGenerationAggregate };
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

  // Bug corrigé le 2026-08-19 (Phase R, chantier "Optimisation du pipeline vidéo — V2.1") : un
  // rejet du Storyboard Gate (Phase H) ne matchait AUCUN sous-cas QUALITY_GATE dédié et retombait
  // sur le message générique "après plusieurs tentatives de correction" — factuellement faux ici
  // (aucune vidéo n'a même été générée). Message distinct désormais, distinct aussi du Creative
  // Gate (concept publicitaire) et de la validation structurelle (Phase E, scénario incomplet).
  it('Storyboard Gate REJECT persistant (Phase H) : message dédié, distinct du message générique de la Quality Loop', async () => {
    const generateCampaign = jest.fn().mockRejectedValue(new Error('QUALITY_GATE: storyboard insuffisant après révision (score 40/100) — incohérent.'));
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 1);

    await processor.process(job);

    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('plan de tournage');
    expect(call.data.failureReason).not.toContain('seuil de qualité requis après plusieurs tentatives de correction');
  });

  // Mission 3 (validation empirique, 2026-08-20) — un échec de l'appel Judge groupé (rootCause
  // PROVIDER, cf. finalizeVideoAsset/providerNote) ne matchait auparavant aucun sous-cas dédié et
  // retombait aussi sur le message générique de la Quality Loop, laissant croire à un problème de
  // contenu créatif alors qu'aucun contenu n'a jamais été réellement mesuré.
  it("Cause PROVIDER (échec du Judge, Mission 3) : message dédié fournisseur, distinct du message générique de la Quality Loop", async () => {
    const generateCampaign = jest.fn().mockRejectedValue(
      new Error("QUALITY_GATE: la vidéo finale n'a pas atteint le seuil de qualité requis après 2 tentative(s) de correction (score global 64/100). Le Video Judge n'a pas pu évaluer plusieurs critères (appel fournisseur indisponible ou réponse non exploitable) — pas un problème de contenu créatif."),
    );
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 1);

    await processor.process(job);

    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('fournisseur IA');
    expect(call.data.failureReason).not.toContain('seuil de qualité requis après plusieurs tentatives de correction');
  });

  // Bug corrigé le 2026-08-18 (constaté en conditions réelles — clé OpenAI à sec) : distingue
  // désormais l'épuisement de NOTRE quota interne (PlanLimitExceededException) de l'épuisement
  // du VRAI solde payant d'un fournisseur externe (OpenAI, Anthropic...) — les deux remontaient
  // avant ce correctif sous le même message "Crédits IA insuffisants", laissant croire à un
  // problème de plan/quota interne alors qu'il fallait recharger le compte du FOURNISSEUR.
  it("erreur RÉELLE de solde fournisseur (OpenAI insufficient_quota) : message dédié, distinct de l'épuisement de notre propre quota", async () => {
    const generateCampaign = jest.fn().mockRejectedValue(
      new Error('Error: OpenAI TTS error: 429 {"error":{"message":"You have no credits remaining.","type":"insufficient_quota","code":"credit_balance_exhausted"}}'),
    );
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 1);

    await processor.process(job);

    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('fournisseur');
    expect(call.data.failureReason).not.toContain('Crédits IA insuffisants pour terminer cette génération.');
  });

  it('single tentative configurée (attempts=1) : le tout premier échec est déjà définitif', async () => {
    const generateCampaign = jest.fn().mockRejectedValue(new Error('panne'));
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 1);

    await processor.process(job);

    expect(campaignUpdate).toHaveBeenCalled();
  });

  // Bug corrigé le 2026-08-18 (constaté en conditions réelles — campagnes dépassant 1h) :
  // QUALITY_GATE (Video Judge, épuisement des réparations) et PlanLimitExceededException
  // (crédits/quota) sont des échecs MÉTIER définitifs — recommencer tout le pipeline depuis
  // zéro (retry BullMQ) ne peut jamais y remédier, ça ne fait que doubler le temps et le coût
  // réel. Les deux tests ci-dessous utilisent attempts=2/attemptsMade=0 (des tentatives BullMQ
  // restent disponibles) pour vérifier que ces erreurs précises sont malgré tout traitées comme
  // définitives DÈS le premier échec, contrairement à une panne technique générique (cf. test
  // "relance l'exception..." ci-dessus, qui doit lui continuer à relancer).
  it('QUALITY_GATE : définitif dès le premier échec, même avec des tentatives BullMQ restantes', async () => {
    const generateCampaign = jest.fn().mockRejectedValue(new Error('QUALITY_GATE: seuil de qualité jamais atteint (score 42/100).'));
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 2); // tentatives BullMQ restantes, ne doit pourtant PAS relancer

    const result = await processor.process(job);

    expect(result).toEqual(expect.objectContaining({ campaignStatus: 'FAILED' }));
    expect(campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('PlanLimitExceededException (crédits/quota) : définitif dès le premier échec, même avec des tentatives BullMQ restantes', async () => {
    const generateCampaign = jest.fn().mockRejectedValue(
      new PlanLimitExceededException({
        message: 'Crédits IA insuffisants',
        code: 'PLAN_LIMIT_EXCEEDED',
        limitType: 'credits',
        currentPlan: 'trial',
        current: 10,
        limit: 1000,
        recommendedPlan: 'growth',
      }),
    );
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 2);

    const result = await processor.process(job);

    expect(result).toEqual(expect.objectContaining({ campaignStatus: 'FAILED' }));
    expect(campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
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

  it("avec vidéo générée mais sans narration (results.narration null) : ContentPiece VIDEO pointe directement sur la vidéo brute, aucun appel à la boucle qualité", async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { linkedin: { content: 'texte linkedin' }, tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
      }),
    );
    const { processor, createPiece, register, qualityLoopRun } = buildProcessor({ generateCampaign });
    const job = buildJob(0, 2);

    await processor.process(job);

    // linkedin est listé en premier dans channelContent, mais la vidéo doit aller sur tiktok
    // (canal natif vidéo), pas sur targetChannels[0] par défaut.
    expect(createPiece).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO', channel: 'tiktok', assetId: 'asset-VIDEO-2' }));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO', generationId: 'gen-video-1' }));
    expect(qualityLoopRun).not.toHaveBeenCalled();
    // Aucun ContentPiece AUDIO — la narration (absente ici) n'est jamais un livrable à part.
    expect(createPiece).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'AUDIO' }));
  });

  it('vidéo + narration, boucle qualité PASSED (vidéo assemblée) : le ContentPiece VIDEO pointe sur la vidéo FINALE, aucun ContentPiece AUDIO séparé, trace persistée', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
        transcript: [{ start: 0, end: 1, text: 'Salut' }],
      }),
    );
    const finalBuffer = Buffer.from('final-mp4-bytes');
    const qualityLoopRun = jest.fn().mockResolvedValue({
      status: 'PASSED',
      finalized: { status: 'assembled', buffer: finalBuffer, mimeType: 'video/mp4', durationSeconds: 12 },
      lastJudge: { criteria: [], globalScore: 90, verdict: 'PASS' },
      attempts: [{ attempt: 1, judge: { criteria: [], globalScore: 90, verdict: 'PASS' }, repairsApplied: [] }],
      transcript: [{ start: 0, end: 1, text: 'Salut' }],
    });
    const { processor, createPiece, register, upload, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 2);

    await processor.process(job);

    expect(qualityLoopRun).toHaveBeenCalledWith(
      { organizationId: 'org-1', campaignId: 'campaign-1', purpose: 'campaign_generation' },
      expect.objectContaining({ rawVideoUrl: 'https://provider.example/video.mp4', narrationDataUri: 'data:audio/mpeg;base64,ZmFrZQ==', transcript: [{ start: 0, end: 1, text: 'Salut' }] }),
      2, // maxRepairAttempts, cf. buildGenerationResult
    );
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
    // P0.11 — trace d'observabilité persistée avec le verdict final réel.
    expect(upsertTrace).toHaveBeenCalledWith(expect.objectContaining({ finalOutcome: 'PASSED', campaignId: 'campaign-1' }));
  });

  // Phase J (chantier "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Sections
  // 59-61) : un Video Judge PASS seul ne suffit JAMAIS à livrer si une porte amont a été
  // contournée — jamais une livraison silencieuse incomplète.
  it("Video Judge PASS mais Storyboard Gate non APPROVED (REJECT persistant) : la livraison échoue quand même (QUALITY_GATE), jamais livrée silencieusement", async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
        transcript: [{ start: 0, end: 1, text: 'Salut' }],
        storyboardGateStatus: 'REJECT',
      }),
    );
    const qualityLoopRun = jest.fn().mockResolvedValue({
      status: 'PASSED',
      finalized: { status: 'assembled', buffer: Buffer.from('final-mp4-bytes'), mimeType: 'video/mp4', durationSeconds: 12 },
      lastJudge: { criteria: [], globalScore: 90, verdict: 'PASS' },
      attempts: [{ attempt: 1, judge: { criteria: [], globalScore: 90, verdict: 'PASS' }, repairsApplied: [] }],
      transcript: [{ start: 0, end: 1, text: 'Salut' }],
    });
    const { processor } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 2);

    const result = await processor.process(job);

    expect(result).toEqual(expect.objectContaining({ campaignStatus: 'FAILED' }));
  });

  it('vidéo + narration, boucle qualité PASSED mais assemblage "skipped" (mode mock) : repli sur la vidéo brute comme sans narration', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'https://example.com/mock-narration.mp3', generationId: 'gen-audio-1' },
      }),
    );
    const qualityLoopRun = jest.fn().mockResolvedValue({ status: 'PASSED', finalized: { status: 'skipped', reason: 'mode mock' }, lastJudge: null, attempts: [], transcript: null });
    const { processor, createPiece, qualityLoopRun: qualityLoopRunRef, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 2);

    await processor.process(job);

    expect(qualityLoopRunRef).toHaveBeenCalledTimes(1);
    // Repli : assetId de la vidéo brute (2e registre : 1=IMAGE, 2=VIDEO brute, 3=AUDIO brute).
    expect(createPiece).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIDEO', channel: 'tiktok', assetId: 'asset-VIDEO-2' }));
    expect(upsertTrace).toHaveBeenCalledWith(expect.objectContaining({ finalOutcome: 'SKIPPED_NO_VIDEO' }));
  });

  it("échec technique de l'assemblage vidéo (ffmpeg/QC, propagé par la boucle qualité) : la campagne échoue avec le motif dédié, jamais silencieusement acceptée", async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
      }),
    );
    const qualityLoopRun = jest.fn().mockRejectedValue(new Error("Échec du contrôle qualité de la vidéo finale : Aucun flux audio détecté"));
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 1); // dernière tentative d'office

    const result = await processor.process(job);

    expect(result).toEqual(expect.objectContaining({ campaignStatus: 'FAILED' }));
    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('assemblage final de la vidéo');
  });

  // P0.7 (chantier "Creative Intelligence Engine & Video Quality Loop", 2026-08-18) — cas
  // central du brief : "NE JAMAIS considérer automatiquement une génération comme réussie
  // simplement parce que le provider a retourné une vidéo." Une vidéo TECHNIQUEMENT assemblée
  // mais dont le Judge refuse le contenu après épuisement des réparations doit échouer, avec un
  // motif dédié distinct d'une panne technique.
  it('REPAIR_EXHAUSTED (Video Judge refuse après épuisement des réparations) : campagne FAILED avec le motif QUALITY_GATE, trace persistée', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
      }),
    );
    const qualityLoopRun = jest.fn().mockResolvedValue({
      status: 'REPAIR_EXHAUSTED',
      lastJudge: { criteria: [{ name: 'factualConsistency', score: 20, justification: 'affirmation non vérifiée', defect: 'x' }], globalScore: 40, verdict: 'REPAIR_REQUIRED' },
      attempts: [{ attempt: 1, judge: { criteria: [], globalScore: 40, verdict: 'REPAIR_REQUIRED' }, repairsApplied: [] }],
      // Phase A (chantier V2, 2026-08-19) — bestAttempt désormais requis sur ce statut.
      bestAttempt: { judge: { criteria: [], globalScore: 40, verdict: 'REPAIR_REQUIRED' }, attemptNumber: 1 },
      // Phase F (chantier V2, 2026-08-19) — history désormais requis sur ce statut.
      history: [],
    });
    const { processor, campaignUpdate, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 1); // dernière tentative d'office

    const result = await processor.process(job);

    expect(result).toEqual(expect.objectContaining({ campaignStatus: 'FAILED' }));
    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('seuil de qualité');
    expect(upsertTrace).toHaveBeenCalledWith(expect.objectContaining({ finalOutcome: 'REPAIR_EXHAUSTED' }));
  });

  it('rehébergement du visuel échoué (uploadFromUrl renvoie null) : se rabat sur l\'URL d\'origine du fournisseur plutôt que d\'échouer', async () => {
    const uploadFromUrl = jest.fn().mockResolvedValue(null);
    const { processor, register } = buildProcessor({ uploadFromUrl });
    const job = buildJob(0, 2);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('READY_FOR_REVIEW'); // n'échoue pas toute la campagne
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: 'IMAGE', url: 'https://provider.example/image.png', storageKey: undefined }));
  });

  // P0.10 (chantier "Creative Intelligence Engine & Video Quality Loop", 2026-08-18) — sécurité
  // factuelle élargie : le transcript réel de la vidéo finale et le texte à l'écran planifié
  // doivent atteindre la modération, purement additif (n'exclut aucun texte déjà envoyé avant).
  it('sécurité factuelle élargie : transcript final (post-boucle qualité) et onScreenText planifié atteignent la modération', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        channelContent: { tiktok: { content: 'texte tiktok' } },
        video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
        narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
        shotPlan: [{ sceneId: 'shot-1', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x', onScreenText: 'Visible dans le noir' }],
        // 1 plan livré pour 1 plan planifié — évite de déclencher le gate de livraison partielle
        // (audit forensique Mission 4.2, P0-4), hors du périmètre de ce test précis (modération).
        videoClips: [{ sceneId: 'shot-1', content: 'https://provider.example/clip-1.mp4' }],
      }),
    );
    const qualityLoopRun = jest.fn().mockResolvedValue({
      status: 'PASSED',
      finalized: { status: 'assembled', buffer: Buffer.from('x'), mimeType: 'video/mp4', durationSeconds: 5 },
      lastJudge: { criteria: [], globalScore: 90, verdict: 'PASS' },
      attempts: [],
      // Transcript corrigé par la boucle qualité — DIFFÉRENT du transcript d'origine (absent
      // ici), pour vérifier que c'est bien CE texte-là qui atteint la modération.
      transcript: [{ start: 0, end: 1, text: 'Corrigé par le Repair Loop' }],
    });
    const { processor, moderation } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 2);

    await processor.process(job);

    const texts = (moderation.runCampaignModeration as jest.Mock).mock.calls[0][3];
    expect(texts).toContainEqual({ label: 'video_transcript', text: 'Corrigé par le Repair Loop' });
    expect(texts).toContainEqual({ label: 'video_onscreen_text', text: 'Visible dans le noir' });
  });

  it("sans transcript ni onScreenText : aucune entrée video_transcript/video_onscreen_text ajoutée (pas d'entrée vide)", async () => {
    const { processor, moderation } = buildProcessor();
    const job = buildJob(0, 2);

    await processor.process(job);

    const texts = (moderation.runCampaignModeration as jest.Mock).mock.calls[0][3];
    expect(texts.some((t: any) => t.label === 'video_transcript')).toBe(false);
    expect(texts.some((t: any) => t.label === 'video_onscreen_text')).toBe(false);
  });
});

// Phase P (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19, spec Section 16-19) —
// escalade automatique EXÉCUTÉE (pas seulement recommandée) : scène -> storyboard -> concept.
describe('CampaignGenerationProcessor — Phase P : escalade automatique EXÉCUTÉE', () => {
  const VIDEO_RESULT_BASE = {
    channelContent: { tiktok: { content: 'texte tiktok' } },
    video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
    narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
  };

  const NEW_SHOT = { sceneId: 'shot-1-v2', camera: 'x', subject: 'product', motion: 'x', lighting: 'x', background: 'x' };

  function repairExhaustedOutcome(criterionName: string, historyEntries: any[] = [{ criterion: 'motionDynamism', sceneId: 'shot-1', strategy: 'CLIP_REGEN', scoreDelta: -3, outcome: 'ECHEC' }]) {
    const criteria = [{ name: criterionName, score: 30, justification: 'défaut principal', defect: 'défaut principal', sceneRef: undefined }];
    return {
      status: 'REPAIR_EXHAUSTED',
      lastJudge: { criteria, globalScore: 40, verdict: 'REPAIR_REQUIRED' },
      attempts: [{ attempt: 1, judge: { criteria, globalScore: 40, verdict: 'REPAIR_REQUIRED' }, repairsApplied: [] }],
      bestAttempt: { judge: { criteria, globalScore: 40, verdict: 'REPAIR_REQUIRED' }, attemptNumber: 1 },
      history: historyEntries,
    };
  }

  // Final Advertising Gate (Phase J, evaluateFinalDelivery) exige narrationDataUri ET un
  // transcript non vide — un transcript null ferait échouer la livraison finale (QUALITY_GATE)
  // pour une raison SANS RAPPORT avec ce que ces tests d'escalade veulent vérifier.
  const PASSED_OUTCOME = {
    status: 'PASSED',
    finalized: { status: 'assembled', buffer: Buffer.from('x'), mimeType: 'video/mp4', durationSeconds: 5 },
    lastJudge: { criteria: [], globalScore: 90, verdict: 'PASS' },
    attempts: [],
    transcript: [{ start: 0, end: 1, text: 'Narration finale.' }],
  };

  function storyboardEscalationResult(overrides: Record<string, any> = {}) {
    return {
      shotPlan: [NEW_SHOT],
      video: { content: 'https://provider.example/video-v2.mp4', generationId: 'gen-video-2' },
      videoClips: [{ sceneId: 'shot-1-v2', content: 'https://provider.example/video-v2.mp4' }],
      perShotQuality: new Map(),
      storyboardGateStatus: 'APPROVED',
      ...overrides,
    };
  }

  function conceptEscalationResult(overrides: Record<string, any> = {}) {
    return {
      creativeConcept: { title: 't2', concept: 'c2', coreMessage: 'm2', hook: 'h2', emotionalDirection: 'e', visualDirection: 'v', storytellingApproach: 's', proofStrategy: 'p', cta: 'cta', targetAudience: 'a', duration: 15, format: '9:16', scenesCount: 1, raw: '{}' },
      shotPlan: [NEW_SHOT],
      video: { content: 'https://provider.example/video-v3.mp4', generationId: 'gen-video-3' },
      videoClips: [{ sceneId: 'shot-1-v2', content: 'https://provider.example/video-v3.mp4' }],
      perShotQuality: new Map(),
      creativeGateStatus: 'APPROVED',
      storyboardGateStatus: 'APPROVED',
      narrationText: 'nouvelle narration',
      narrationDataUri: 'data:audio/mpeg;base64,bmV3',
      transcript: null,
      ...overrides,
    };
  }

  it('cause STORYBOARD (storytelling) : regenerateShotPlanAndVideo appelé UNE fois avec le défaut du Judge, puis succès -> READY_FOR_REVIEW, trace avec 2 versions de Shot Plan', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockResolvedValueOnce(repairExhaustedOutcome('storytelling')).mockResolvedValueOnce(PASSED_OUTCOME);
    const regenerateShotPlanAndVideo = jest.fn().mockResolvedValue(storyboardEscalationResult());
    const { processor, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo });
    const job = buildJob(0, 1);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('READY_FOR_REVIEW');
    expect(regenerateShotPlanAndVideo).toHaveBeenCalledTimes(1);
    const [, escalationParams] = regenerateShotPlanAndVideo.mock.calls[0];
    expect(escalationParams.escalationFeedback).toContain('storytelling');
    expect(qualityLoopRun).toHaveBeenCalledTimes(2);
    expect(upsertTrace).toHaveBeenCalledWith(expect.objectContaining({ finalOutcome: 'PASSED', shotPlanVersions: expect.arrayContaining([expect.objectContaining({ attempt: 1 }), expect.objectContaining({ attempt: 2 })]) }));
    const trace = upsertTrace.mock.calls[0][0];
    expect(trace.shotPlanVersions).toHaveLength(2);
  });

  it("Audit forensique Mission 4.2 (P1-4) — les clips vidéo déjà générés avant une escalade sont comptés comme jetés (discardedClipsOnEscalation), pure visibilité économique, aucun réemploi tenté", async () => {
    const generateCampaign = jest.fn().mockResolvedValue(
      buildGenerationResult({
        ...VIDEO_RESULT_BASE,
        // 3 clips déjà générés (réels, payés) avant que l'escalade storyboard ne les jette.
        videoClips: [
          { sceneId: 'shot-1', content: 'https://provider.example/clip-1.mp4' },
          { sceneId: 'shot-2', content: 'https://provider.example/clip-2.mp4' },
          { sceneId: 'shot-3', content: 'https://provider.example/clip-3.mp4' },
        ],
      }),
    );
    const qualityLoopRun = jest.fn().mockResolvedValueOnce(repairExhaustedOutcome('storytelling')).mockResolvedValueOnce(PASSED_OUTCOME);
    const regenerateShotPlanAndVideo = jest.fn().mockResolvedValue(storyboardEscalationResult());
    const { processor, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo });
    const job = buildJob(0, 1);

    await processor.process(job);

    const trace = upsertTrace.mock.calls[0][0];
    expect(trace.report.discardedClipsOnEscalation).toBe(3);
  });

  it("Audit forensique Mission 4.2 (P1-3) — un défaut UNREPAIRABLE (storytelling) SEUL dès la 1ère tentative (historique VIDE, aucune réparation jamais tentée) déclenche quand même l'escalade storyboard, jamais bloquée par l'absence d'ECHEC dans l'historique", async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    // historyEntries: [] explicite — reproduit le cas réel où applyRepairs n'a jamais tenté la
    // moindre réparation car le seul défaut détecté (storytelling) est classé UNREPAIRABLE dès le
    // 1er jugement (repairsApplied.length === 0 → REPAIR_EXHAUSTED immédiat, spec Section 5).
    // Avant P1-3 : actionRecommandee retombait à 'RETRY_LOCAL' (aucun ECHEC dans un historique
    // vide) et tryEscalate abandonnait AVANT même de vérifier que rootCause='STORYBOARD' était
    // pourtant éligible à l'escalade.
    const qualityLoopRun = jest.fn().mockResolvedValueOnce(repairExhaustedOutcome('storytelling', [])).mockResolvedValueOnce(PASSED_OUTCOME);
    const regenerateShotPlanAndVideo = jest.fn().mockResolvedValue(storyboardEscalationResult());
    const { processor } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo });
    const job = buildJob(0, 1);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('READY_FOR_REVIEW');
    expect(regenerateShotPlanAndVideo).toHaveBeenCalledTimes(1);
    const [, escalationParams] = regenerateShotPlanAndVideo.mock.calls[0];
    expect(escalationParams.escalationFeedback).toContain('storytelling');
  });

  it('budget dur : après une escalade storyboard déjà tentée, un nouvel épuisement escalade au CONCEPT, jamais une 2e escalade storyboard', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest
      .fn()
      .mockResolvedValueOnce(repairExhaustedOutcome('storytelling'))
      .mockResolvedValueOnce(repairExhaustedOutcome('storytelling'))
      .mockResolvedValueOnce(PASSED_OUTCOME);
    const regenerateShotPlanAndVideo = jest.fn().mockResolvedValue(storyboardEscalationResult());
    const regenerateConceptStoryboardAndVideo = jest.fn().mockResolvedValue(conceptEscalationResult());
    const { processor } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo, regenerateConceptStoryboardAndVideo });
    const job = buildJob(0, 1);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('READY_FOR_REVIEW');
    expect(regenerateShotPlanAndVideo).toHaveBeenCalledTimes(1); // jamais une 2e fois
    expect(regenerateConceptStoryboardAndVideo).toHaveBeenCalledTimes(1);
    expect(qualityLoopRun).toHaveBeenCalledTimes(3);
  });

  it('cause CONCEPT directe (factualConsistency) : escalade directement au concept, jamais de détour par le storyboard', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockResolvedValueOnce(repairExhaustedOutcome('factualConsistency')).mockResolvedValueOnce(PASSED_OUTCOME);
    const regenerateShotPlanAndVideo = jest.fn();
    const regenerateConceptStoryboardAndVideo = jest.fn().mockResolvedValue(conceptEscalationResult());
    const { processor } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo, regenerateConceptStoryboardAndVideo });
    const job = buildJob(0, 1);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('READY_FOR_REVIEW');
    expect(regenerateShotPlanAndVideo).not.toHaveBeenCalled();
    expect(regenerateConceptStoryboardAndVideo).toHaveBeenCalledTimes(1);
    const [, escalationParams] = regenerateConceptStoryboardAndVideo.mock.calls[0];
    expect(escalationParams.escalationFeedback).toContain('factualConsistency');
  });

  it('budget d\'escalade totalement épuisé (storyboard ET concept déjà tentés) : échec propre QUALITY_GATE citant le niveau atteint', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest
      .fn()
      .mockResolvedValueOnce(repairExhaustedOutcome('storytelling'))
      .mockResolvedValueOnce(repairExhaustedOutcome('storytelling'))
      .mockResolvedValueOnce(repairExhaustedOutcome('storytelling'));
    const regenerateShotPlanAndVideo = jest.fn().mockResolvedValue(storyboardEscalationResult());
    const regenerateConceptStoryboardAndVideo = jest.fn().mockResolvedValue(conceptEscalationResult());
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo, regenerateConceptStoryboardAndVideo });
    const job = buildJob(0, 1);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('FAILED');
    expect(regenerateShotPlanAndVideo).toHaveBeenCalledTimes(1);
    expect(regenerateConceptStoryboardAndVideo).toHaveBeenCalledTimes(1);
    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('seuil de qualité');
  });

  it('cause non escaladable (UNKNOWN, ex: pacing) sans escalade storyboard préalable : échec propre, aucune escalade tentée', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockResolvedValue(repairExhaustedOutcome('pacing'));
    const regenerateShotPlanAndVideo = jest.fn();
    const regenerateConceptStoryboardAndVideo = jest.fn();
    const { processor } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo, regenerateConceptStoryboardAndVideo });
    const job = buildJob(0, 1);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('FAILED');
    expect(regenerateShotPlanAndVideo).not.toHaveBeenCalled();
    expect(regenerateConceptStoryboardAndVideo).not.toHaveBeenCalled();
    expect(qualityLoopRun).toHaveBeenCalledTimes(1); // aucune relance, épuisé dès le 1er passage
  });

  // Audit forensic (2026-08-20, campagne réelle 83cbcd41-2baf-4517-bb4e-edee62b1c910) — reproduit
  // le cas réel : un défaut UNREPAIRABLE (storytelling, score 38 — la voix off contredit le
  // concept) coexiste avec un défaut moins grave mais mécaniquement réparable (pacing, score 48,
  // SUBTITLE_ONLY à 8 crédits). AVANT le fix, rootCause se basait sur `ordreDePriorite[0]`
  // (pondéré par computePriority, qui donne priorité 0 aux stratégies UNREPAIRABLE à coût infini)
  // -> "pacing" passait en tête -> rootCause="SUBTITLE" -> jamais escaladable -> échec sec sans
  // jamais tenter la régénération storyboard/concept qui aurait pu corriger le vrai problème.
  it("Audit forensic 83cbcd41 — un défaut UNREPAIRABLE plus grave (storytelling) déclenche bien l'escalade storyboard, même en présence d'un défaut moins grave mais moins cher à réparer (pacing)", async () => {
    const criteria = [
      { name: 'storytelling', score: 38, justification: 'x', defect: 'Voix off explicative et répétitive qui contredit le concept' },
      { name: 'pacing', score: 48, justification: 'x', defect: 'Surcharge informationnelle' },
    ];
    const judgeResult = { criteria, globalScore: 45, verdict: 'REPAIR_REQUIRED' };
    const repairExhausted = {
      status: 'REPAIR_EXHAUSTED',
      lastJudge: judgeResult,
      attempts: [{ attempt: 1, judge: judgeResult, repairsApplied: [] }],
      bestAttempt: { judge: judgeResult, attemptNumber: 1 },
      // Un ECHEC dans l'historique est nécessaire pour que buildQualityReport recommande
      // l'escalade (actionRecommandee = ESCALADE_STORYBOARD_RECOMMANDEE) — indépendant du sujet
      // de ce test (la SÉLECTION de rootCause), reproduit tel quel depuis les autres fixtures.
      history: [{ criterion: 'pacing', sceneId: undefined, strategy: 'SUBTITLE_ONLY', scoreDelta: -18, outcome: 'ECHEC' }],
    };
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockResolvedValueOnce(repairExhausted).mockResolvedValueOnce(PASSED_OUTCOME);
    const regenerateShotPlanAndVideo = jest.fn().mockResolvedValue(storyboardEscalationResult());
    const { processor } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo });
    const job = buildJob(0, 1);

    const result = await processor.process(job);

    // Avant le fix : FAILED, regenerateShotPlanAndVideo jamais appelé (rootCause="SUBTITLE" via
    // pacing, non escaladable). Après le fix : l'escalade storyboard est bien déclenchée sur le
    // défaut le plus grave (storytelling), et la campagne aboutit.
    expect(regenerateShotPlanAndVideo).toHaveBeenCalledTimes(1);
    const [, escalationParams] = regenerateShotPlanAndVideo.mock.calls[0];
    expect(escalationParams.escalationFeedback).toContain('storytelling');
    expect(escalationParams.escalationFeedback).not.toContain('pacing');
    expect(result.campaignStatus).toBe('READY_FOR_REVIEW');
  });
});

// Phase Q (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — budget temps/crédits +
// rapport final enrichi + persistance (le rapport structuré, calculé depuis la Phase F mais
// jamais persisté avant ce chantier, est désormais conservé sur les 3 branches).
describe('CampaignGenerationProcessor — Phase Q : budget temps/crédits + rapport enrichi', () => {
  const VIDEO_RESULT_BASE = {
    channelContent: { tiktok: { content: 'texte tiktok' } },
    video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
    narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
  };
  const PASSED_OUTCOME = {
    status: 'PASSED',
    finalized: { status: 'assembled', buffer: Buffer.from('x'), mimeType: 'video/mp4', durationSeconds: 5 },
    lastJudge: { criteria: [], globalScore: 90, verdict: 'PASS' },
    attempts: [],
    transcript: [{ start: 0, end: 1, text: 'Narration finale.' }],
  };
  const REPAIR_EXHAUSTED_OUTCOME = {
    status: 'REPAIR_EXHAUSTED',
    lastJudge: { criteria: [{ name: 'pacing', score: 30, justification: 'x', defect: 'x' }], globalScore: 40, verdict: 'REPAIR_REQUIRED' },
    attempts: [{ attempt: 1, judge: { criteria: [], globalScore: 40, verdict: 'REPAIR_REQUIRED' }, repairsApplied: [] }],
    bestAttempt: { judge: { criteria: [{ name: 'pacing', score: 30, justification: 'x', defect: 'x' }], globalScore: 40, verdict: 'REPAIR_REQUIRED' }, attemptNumber: 1 },
    history: [],
  };

  it('elapsedMs présent et cohérent (>= 0) sur la trace persistée après un run PASSED', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockResolvedValue(PASSED_OUTCOME);
    const { processor, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 1);

    await processor.process(job);

    const call = upsertTrace.mock.calls[0][0];
    expect(typeof call.elapsedMs).toBe('number');
    expect(call.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(call.report.elapsedMs).toBe(call.elapsedMs);
  });

  it('budget temps dépassé : timeBudgetStatus=TIME_BUDGET_EXCEEDED dans le rapport persisté, jamais un abandon silencieux', async () => {
    // Horloge système FICTIVE (pas d'interception de Date.now par comptage d'appels — fragile,
    // d'autres appels internes au framework y compris NestJS Logger y touchent aussi) : on avance
    // le temps réel entre le début du job et l'appel à la Quality Loop, exactement comme le
    // ferait un run réel qui prend 25 minutes.
    jest.useFakeTimers();
    const start = Date.now();
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockImplementation(async () => {
      jest.setSystemTime(start + 25 * 60 * 1000);
      return REPAIR_EXHAUSTED_OUTCOME;
    });
    const { processor, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 1);

    const result = await processor.process(job);
    jest.useRealTimers();

    expect(result.campaignStatus).toBe('FAILED');
    const call = upsertTrace.mock.calls[0][0];
    expect(call.report).toBeDefined();
    expect(call.report.timeBudgetStatus).toBe('TIME_BUDGET_EXCEEDED');
    expect(call.report.statut).toBe('REPAIR_EXHAUSTED'); // rapport structuré complet, pas un abandon silencieux
  });

  it('totalCredits correspond exactement à la somme agrégée des AiGeneration.costEstimate de la campagne', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockResolvedValue(PASSED_OUTCOME);
    const { processor, upsertTrace, aiGenerationAggregate } = buildProcessor({ generateCampaign, qualityLoopRun });
    (aiGenerationAggregate as jest.Mock).mockResolvedValue({ _sum: { costEstimate: 237.5 } });
    const job = buildJob(0, 1);

    await processor.process(job);

    expect(aiGenerationAggregate).toHaveBeenCalledWith(expect.objectContaining({ where: { campaignId: 'campaign-1' } }));
    const call = upsertTrace.mock.calls[0][0];
    expect(call.report.totalCredits).toBe(237.5);
  });

  it('le rapport structuré (report) est présent dans upsertTrace sur les 3 branches : PASSED, SKIPPED_NO_VIDEO, REPAIR_EXHAUSTED', async () => {
    // PASSED
    {
      const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
      const qualityLoopRun = jest.fn().mockResolvedValue(PASSED_OUTCOME);
      const { processor, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
      await processor.process(buildJob(0, 1));
      expect(upsertTrace.mock.calls[0][0].report).toBeDefined();
      expect(upsertTrace.mock.calls[0][0].report.statut).toBe('PASSED');
    }
    // SKIPPED_NO_VIDEO (mode mock)
    {
      const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
      const qualityLoopRun = jest.fn().mockResolvedValue(buildDefaultQualityLoopOutcome());
      const { processor, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
      await processor.process(buildJob(0, 1));
      expect(upsertTrace.mock.calls[0][0].report).toBeDefined();
      expect(upsertTrace.mock.calls[0][0].report.statut).toBe('SKIPPED_NO_VIDEO');
    }
    // REPAIR_EXHAUSTED
    {
      const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
      const qualityLoopRun = jest.fn().mockResolvedValue(REPAIR_EXHAUSTED_OUTCOME);
      const { processor, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
      await processor.process(buildJob(0, 1));
      expect(upsertTrace.mock.calls[0][0].report).toBeDefined();
      expect(upsertTrace.mock.calls[0][0].report.statut).toBe('REPAIR_EXHAUSTED');
    }
  });
});

// Mission 3 (validation empirique du pipeline, 2026-08-20) — REJEU de 3 campagnes réelles
// historiques (base de données) : décision correcte quand la cause racine est le fournisseur
// (échec de l'appel Judge groupé), jamais une escalade storyboard/concept gaspillée.
describe('CampaignGenerationProcessor — Mission 3 : cause PROVIDER (échec du Judge), jamais d\'escalade gaspillée', () => {
  const VIDEO_RESULT_BASE = {
    channelContent: { tiktok: { content: 'texte tiktok' } },
    video: { content: 'https://provider.example/video.mp4', generationId: 'gen-video-1' },
    narration: { content: 'data:audio/mpeg;base64,ZmFrZQ==', generationId: 'gen-audio-1' },
  };

  // Reprend EXACTEMENT le schéma observé sur la campagne réelle c29f0982-f5c4-40a0-bbac-e8dad2eba0eb
  // (tentative 1) : 9 critères texte UNAVAILABLE_DEFECT, scores visuels réels élevés, 1 entrée
  // d'historique ECHEC (nécessaire pour que buildQualityReport recommande une escalade).
  function providerOutcome() {
    const criteria = [
      { name: 'productConsistency', score: 92, justification: 'x' },
      { name: 'motionDynamism', score: 100, justification: 'x' },
      { name: 'audioQuality', score: 49, justification: 'x', defect: 'Le mixage final ne converge pas vers le niveau sonore cible' },
      { name: 'voiceAudibility', score: 90, justification: 'x' },
      { name: 'productVisibility', score: 94, justification: 'x' },
      { name: 'formatCompliance', score: 100, justification: 'x' },
      { name: 'storytelling', score: 50, justification: 'x', defect: 'Vérification indisponible' },
      { name: 'hookStrength', score: 50, justification: 'x', defect: 'Vérification indisponible' },
      { name: 'pacing', score: 50, justification: 'x', defect: 'Vérification indisponible' },
      { name: 'textReadability', score: 50, justification: 'x', defect: 'Vérification indisponible' },
      { name: 'grammar', score: 50, justification: 'x', defect: 'Vérification indisponible' },
      { name: 'ctaClarity', score: 50, justification: 'x', defect: 'Vérification indisponible' },
      { name: 'brandCoherence', score: 50, justification: 'x', defect: 'Vérification indisponible' },
      { name: 'factualConsistency', score: 50, justification: 'x', defect: 'Vérification indisponible' },
      { name: 'advertisingEffectiveness', score: 50, justification: 'x', defect: 'Vérification indisponible' },
    ];
    return {
      status: 'REPAIR_EXHAUSTED',
      lastJudge: { criteria, globalScore: 64, verdict: 'REPAIR_REQUIRED' },
      attempts: [{ attempt: 1, judge: { criteria, globalScore: 64, verdict: 'REPAIR_REQUIRED' }, repairsApplied: [] }],
      bestAttempt: { judge: { criteria, globalScore: 64, verdict: 'REPAIR_REQUIRED' }, attemptNumber: 1 },
      history: [{ criterion: 'audioQuality', sceneId: undefined, strategy: 'AUDIO_REGEN', scoreDelta: -3, outcome: 'ECHEC' }],
    };
  }

  it('cause PROVIDER : jamais de regenerateShotPlanAndVideo/regenerateConceptStoryboardAndVideo, échec propre citant le fournisseur (pas le contenu)', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockResolvedValue(providerOutcome());
    const regenerateShotPlanAndVideo = jest.fn();
    const regenerateConceptStoryboardAndVideo = jest.fn();
    const { processor, campaignUpdate } = buildProcessor({ generateCampaign, qualityLoopRun, regenerateShotPlanAndVideo, regenerateConceptStoryboardAndVideo });
    const job = buildJob(0, 1);

    const result = await processor.process(job);

    expect(result.campaignStatus).toBe('FAILED');
    expect(regenerateShotPlanAndVideo).not.toHaveBeenCalled();
    expect(regenerateConceptStoryboardAndVideo).not.toHaveBeenCalled();
    expect(qualityLoopRun).toHaveBeenCalledTimes(1); // aucune relance, épuisé dès le 1er passage
    const call = campaignUpdate.mock.calls[0][0];
    expect(call.data.failureReason).toContain('fournisseur IA');
    expect(call.data.failureReason).not.toContain('après plusieurs tentatives de correction');
  });

  it('le rapport persisté cite rootCause=PROVIDER, jamais STORYBOARD/CONCEPT malgré le critère storytelling présent', async () => {
    const generateCampaign = jest.fn().mockResolvedValue(buildGenerationResult(VIDEO_RESULT_BASE));
    const qualityLoopRun = jest.fn().mockResolvedValue(providerOutcome());
    const { processor, upsertTrace } = buildProcessor({ generateCampaign, qualityLoopRun });
    const job = buildJob(0, 1);

    await processor.process(job);

    const trace = upsertTrace.mock.calls[0][0];
    expect(trace.report.rootCause).toBe('PROVIDER');
  });
});
