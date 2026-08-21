import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import { BrandContextBuilderService } from '../../brand/brand-context-builder.service';
import { VideoFinalizationService } from '../../video-assembly/video-finalization.service';
import { PlanLimitExceededException } from '../../plans/plan-limit.exception';
import { VisualDnaService, VisualDna } from '../video-direction/visual-dna.service';
import { VideoDirectorService, Shot, ShotPlan } from '../video-direction/video-director.service';
import { VideoAnalyzerService, ShotQualityResult } from '../video-direction/video-analyzer.service';
import { ProductIntelligenceService } from '../product-intelligence/product-intelligence.service';
import { CreativeIntelligenceService } from '../creative-intelligence/creative-intelligence.service';
import { CreativeConceptService } from '../creative-intelligence/creative-concept.service';
import { CreativeGateService } from '../creative-intelligence/creative-gate.service';
import { CreativeGateResult } from '../creative-intelligence/creative-gate.types';
import { StoryboardGateService } from '../video-direction/storyboard-gate.service';
import { StoryboardGateResult } from '../video-direction/storyboard-gate.types';
import { CreativeIntelligence } from '../creative-intelligence/creative-intelligence.types';
import { CreativeConcept } from '../creative-intelligence/creative-concept.types';
import { CostControlService } from '../../plans/cost-control.service';
import { EntitlementsService } from '../../plans/entitlements.service';

function buildBrandContextMock(text = '') {
  const build = jest.fn().mockResolvedValue({ text, rules: [], entriesUsed: [] });
  return { build } as unknown as BrandContextBuilderService;
}

// Contexte de marque vide par défaut — les tests existants (avant l'intégration du Lot D)
// vérifient un comportement inchangé quand aucune donnée de marque n'est configurée.
const brandContext = buildBrandContextMock();

// Tout accès ffmpeg/réseau réel reste encapsulé dans VideoAssemblyModule (cf.
// AiOrchestratorService.generateShotPlanVideoOrDegrade) — mock par défaut jamais exercé par la
// plupart des tests (le Shot Plan par défaut ci-dessous ne contient qu'UN SEUL plan, donc la
// concaténation multi-plans ne se déclenche pas) ; les tests dédiés au mécanisme multi-plans
// fournissent leur propre Shot Plan à plusieurs plans pour vérifier le contenu combiné.
function buildVideoFinalizationMock(concatenateClips?: jest.Mock) {
  return {
    concatenateClips: concatenateClips ?? jest.fn().mockResolvedValue('data:video/mp4;base64,Y29tYmluZWQ='),
  } as unknown as VideoFinalizationService;
}
const videoFinalization = buildVideoFinalizationMock();

// Architecture Shot Plan (2026-08-18) : VisualDnaService/VideoDirectorService/VideoAnalyzerService
// sont mockés au niveau de l'Orchestrateur — leurs appels IA internes (analyzeImage/generateText)
// sont donc INVISIBLES pour les tests de ce fichier, qui ne vérifient que le CÂBLAGE (quels
// arguments transitent entre l'Orchestrateur et ces services), jamais leur logique interne
// (déjà couverte par leurs propres fichiers .spec.ts dédiés).
const DEFAULT_VISUAL_DNA: VisualDna = {
  productCategory: 'chaussures',
  colors: ['bleu'],
  materials: ['mesh'],
  shape: 'basse',
  distinctiveFeatures: [],
  logoOrBrandMarks: null,
  raw: '{}',
};
function buildVisualDnaMock(dna: VisualDna = DEFAULT_VISUAL_DNA) {
  return { extract: jest.fn().mockResolvedValue(dna) } as unknown as VisualDnaService;
}
const visualDnaMock = buildVisualDnaMock();

// onScreenText présent (Phase E, chantier V2) : la validation structurelle pré-génération exige
// qu'au moins un plan porte un texte à l'écran/voix off — sans ce champ, TOUS les tests de ce
// fichier échoueraient avant même d'atteindre generateVideo, alors qu'ils ciblent le câblage
// EN AVAL de cette étape. Neutre par défaut, comme le reste des mocks de ce fichier.
const DEFAULT_SHOT: Shot = { sceneId: 'shot-1', camera: 'dolly-in', subject: 'product', motion: 'slow rotation', lighting: 'moving highlight', background: 'particles', onScreenText: 'Découvrez maintenant' };

// Un SEUL plan par défaut — garde le comportement "1 appel generateVideo" pour tous les tests
// qui ne portent pas spécifiquement sur le mécanisme multi-plans (le shotCount réel de
// production, 3, passé par l'Orchestrateur à generateShotPlan(), est vérifié dans un test
// dédié ; comme ce service est mocké ici, il peut renvoyer autant de plans que le test le
// demande indépendamment de ce paramètre).
function buildVideoDirectorMock(shotPlan: ShotPlan = [DEFAULT_SHOT]) {
  return {
    generateShotPlan: jest.fn().mockResolvedValue(shotPlan),
    serializeShotToPrompt: jest.fn((shot: Shot) => `PROMPT[${shot.camera}]`),
    // Repair Loop intelligent (2026-08-18) : mock par défaut distinguable de serializeShotToPrompt
    // — permet de vérifier que le 2e essai utilise bien LE PROMPT CORRIGÉ, pas le même texte.
    repairShotPrompt: jest.fn((shot: Shot) => `REPAIRED[${shot.camera}]`),
  } as unknown as VideoDirectorService;
}
const videoDirectorMock = buildVideoDirectorMock();

const PASSING_QUALITY: ShotQualityResult = {
  passed: true,
  qualityScore: 90,
  motionQuality: { passed: true, score: 90, reasons: [], freezeRatio: 0 },
  visualFidelity: { passed: true, score: 90, reasons: [] },
  reasons: [],
};
const FAILING_QUALITY: ShotQualityResult = {
  passed: false,
  qualityScore: 30,
  motionQuality: { passed: false, score: 20, reasons: ['quasi-statique'], freezeRatio: 0.5 },
  visualFidelity: { passed: false, score: 40, reasons: ['produit différent'] },
  reasons: ['quasi-statique', 'produit différent'],
};
function buildVideoAnalyzerMock(result: ShotQualityResult = PASSING_QUALITY) {
  return { analyze: jest.fn().mockResolvedValue(result) } as unknown as VideoAnalyzerService;
}
const videoAnalyzerMock = buildVideoAnalyzerMock();

// Product Intelligence (chantier "Product Intelligence & Creative Intelligence Engine V2",
// 2026-08-18) : profil neutre par défaut (webResearchStatus NOT_CONFIGURED, aucun champ marché
// deviné) — cohérent avec ce que ProductIntelligenceService produit réellement sans Web Research.
const DEFAULT_PRODUCT_PROFILE = {
  category: 'Chaussures',
  subcategory: null,
  brand: 'TestBrand',
  productName: null,
  model: null,
  features: ['semelle épaisse'],
  usps: ['confort premium'],
  visibleClaims: [],
  webResearchStatus: 'NOT_CONFIGURED',
};
function buildProductIntelligenceMock(profile: unknown = DEFAULT_PRODUCT_PROFILE) {
  return { buildProfile: jest.fn().mockResolvedValue(profile) } as unknown as ProductIntelligenceService;
}
const productIntelligenceMock = buildProductIntelligenceMock();

// Creative Intelligence Engine & Video Quality Loop (2026-08-18) : mocks neutres par défaut —
// les tests de ce fichier vérifient le CÂBLAGE avec le reste de l'Orchestrateur (cf. commentaire
// ci-dessus sur VisualDnaService/VideoDirectorService/VideoAnalyzerService), pas la logique
// interne de ces services (déjà couverte par leurs propres .spec.ts dédiés).
const DEFAULT_CREATIVE_INTELLIGENCE: CreativeIntelligence = {
  adObjective: 'x', targetAudience: 'x', primaryProblem: 'x', primaryDesire: 'x', primaryBenefit: 'x',
  valueProposition: 'x', creativeAngle: 'x', desiredEmotion: 'x', hook: 'x', proofToShow: 'x',
  objections: [], mainMessage: 'x', cta: 'x', visualTone: 'x', pacing: 'x', adStyle: 'x', raw: '{}',
};
function buildCreativeIntelligenceMock(value: CreativeIntelligence = DEFAULT_CREATIVE_INTELLIGENCE) {
  return { generate: jest.fn().mockResolvedValue(value) } as unknown as CreativeIntelligenceService;
}
const creativeIntelligenceMock = buildCreativeIntelligenceMock();

// scenesCount=1 par défaut ici (pas 3) : cohérent avec DEFAULT_SHOT (1 seul plan) utilisé par la
// plupart des tests de ce fichier — videoDirectorMock.generateShotPlan étant lui-même mocké pour
// renvoyer un ShotPlan fixe indépendamment de scenesCount, ce choix n'affecte que la lisibilité,
// jamais le comportement réel des tests.
const DEFAULT_CONCEPT: CreativeConcept = {
  title: 'x', concept: 'x', coreMessage: 'x', hook: 'x', emotionalDirection: 'x', visualDirection: 'x',
  storytellingApproach: 'x', proofStrategy: 'x', cta: 'x', targetAudience: 'x', duration: 15, format: '9:16',
  scenesCount: 1, raw: '{}',
};
function buildCreativeConceptMock(value: CreativeConcept = DEFAULT_CONCEPT) {
  return { generate: jest.fn().mockResolvedValue(value) } as unknown as CreativeConceptService;
}
const creativeConceptMock = buildCreativeConceptMock();

// Phase G (chantier V2) : APPROVED par défaut — les tests de ce fichier vérifient le câblage EN
// AVAL du Creative Gate (Shot Plan, génération vidéo...), pas sa logique interne (déjà couverte
// par creative-gate.service.spec.ts dédié). Une seule évaluation par défaut : APPROVED d'emblée.
const APPROVED_GATE: CreativeGateResult = {
  status: 'APPROVED', score: 90, hook: 'x', promessePrincipale: 'x', benefices: ['x'], preuve: 'x',
  cta: 'x', forces: ['x'], faiblesses: [], risques: [], causesDeRejet: [], recommandation: '',
};
function buildCreativeGateMock(result: CreativeGateResult = APPROVED_GATE) {
  return { evaluate: jest.fn().mockResolvedValue(result) } as unknown as CreativeGateService;
}
const creativeGateMock = buildCreativeGateMock();

// Phase H (chantier V2) : APPROVED, aucune scène à élaguer par défaut — même raisonnement que
// creativeGateMock ci-dessus.
const APPROVED_STORYBOARD_GATE: StoryboardGateResult = { status: 'APPROVED', score: 90, scenesToRemove: [], faiblesses: [], recommandation: '' };
function buildStoryboardGateMock(result: StoryboardGateResult = APPROVED_STORYBOARD_GATE) {
  return { evaluate: jest.fn().mockResolvedValue(result) } as unknown as StoryboardGateService;
}
const storyboardGateMock = buildStoryboardGateMock();

// scenesCount=3 (Phase E, chantier V2) : les tests ci-dessous fournissent un Shot Plan à 3 plans
// (threeShots) — la validation structurelle pré-génération exige désormais que le nombre de
// plans corresponde à creativeConcept.scenesCount, sinon la campagne échoue AVANT generateVideo.
const THREE_SHOT_CONCEPT: CreativeConcept = { ...DEFAULT_CONCEPT, scenesCount: 3 };

function buildCostControlMock() {
  return {
    assertBeforeGeneration: jest.fn().mockResolvedValue(undefined),
    checkBeforeVideoLoop: jest.fn().mockResolvedValue({ maxRepairAttempts: 2 }),
  } as unknown as CostControlService;
}
const costControlMock = buildCostControlMock();

// Phase M (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) : null (illimité) par
// défaut — les tests de ce fichier vérifient le CÂBLAGE existant, jamais plafonnés par défaut,
// exactement comme avant l'introduction de cette dépendance. Les tests dédiés à Phase M
// (describe séparé plus bas) surchargent explicitement cette valeur pour exercer le plafonnement.
function buildEntitlementsMock(remainingSlots: number | null = null) {
  return { getRemainingVideoShotSlots: jest.fn().mockResolvedValue(remainingSlots) } as unknown as EntitlementsService;
}
const entitlementsMock = buildEntitlementsMock();

function buildGatewayMock(textResponses: Record<string, string> = {}, analyzeImageResponse?: string) {
  const generateText = jest.fn(async (_ctx: any, params: { prompt: string }, provider?: string) => {
    // Le canal est identifiable dans le prompt via son mot-clé distinctif (cf. buildChannelPrompt)
    // — le mock retourne une réponse adaptée si fournie, sinon un texte générique par défaut.
    const key = Object.keys(textResponses).find((k) => params.prompt.includes(k));
    return {
      content: key ? textResponses[key] : `[texte généré] ${params.prompt.slice(0, 30)}`,
      provider: provider ?? 'openai',
      model: 'test-model',
      durationMs: 10,
    };
  });
  const generateImage = jest.fn(async () => ({ content: 'https://example.com/image.png', provider: 'flux', model: 'flux-1', durationMs: 10 }));
  const generateVideo = jest.fn(async () => ({ content: 'https://example.com/video.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 }));
  const analyzeImage = jest.fn(async () => ({
    content:
      analyzeImageResponse ??
      JSON.stringify({ category: 'Chaussures', priceRange: '80 – 120 €', strengths: ['Confort', 'Durabilité'], usp: 'Amorti premium à prix accessible' }),
    provider: 'openai',
    model: 'test-vision-model',
    durationMs: 10,
  }));
  // Data URI valide par défaut (pas juste une URL) — exerce réellement le chemin de
  // transcription en aval, comme en production, plutôt que de le contourner silencieusement.
  const generateAudio = jest.fn(async () => ({
    content: `data:audio/mpeg;base64,${Buffer.from('fake-audio').toString('base64')}`,
    provider: 'openai',
    model: 'tts-1',
    durationMs: 10,
  }));
  const transcribeAudio = jest.fn(async () => ({
    content: JSON.stringify([{ start: 0, end: 1.5, text: 'Une photo.' }]),
    provider: 'openai',
    model: 'whisper-1',
    durationMs: 10,
  }));

  return { generateText, generateImage, generateVideo, generateAudio, transcribeAudio, analyzeImage } as unknown as AiGatewayService;
}

const BASE_PARAMS = { organizationId: 'org-1', campaignId: 'camp-1', productDescription: 'Chaussures de course', objective: 'Vendre 100 paires' };

// Les mocks partagés ci-dessus (visualDnaMock, videoDirectorMock, videoAnalyzerMock,
// videoFinalization) sont RÉUTILISÉS entre tous les tests de ce fichier — sans ce nettoyage,
// `.mock.calls` s'accumule au fil de l'exécution et un test qui inspecte `.mock.calls[0]` ou
// `.toHaveBeenCalledTimes(N)` récupère l'historique d'un test précédent, pas le sien. `gateway`
// n'a pas besoin de ce traitement : chaque test en construit une instance fraîche via
// buildGatewayMock().
beforeEach(() => {
  (visualDnaMock.extract as jest.Mock).mockClear();
  (videoDirectorMock.generateShotPlan as jest.Mock).mockClear();
  (videoDirectorMock.serializeShotToPrompt as jest.Mock).mockClear();
  (videoDirectorMock.repairShotPrompt as jest.Mock).mockClear();
  (videoAnalyzerMock.analyze as jest.Mock).mockClear();
  (videoFinalization.concatenateClips as jest.Mock).mockClear();
  (productIntelligenceMock.buildProfile as jest.Mock).mockClear();
  (creativeIntelligenceMock.generate as jest.Mock).mockClear();
  (creativeConceptMock.generate as jest.Mock).mockClear();
  (creativeGateMock.evaluate as jest.Mock).mockClear();
  (storyboardGateMock.evaluate as jest.Mock).mockClear();
  (costControlMock.assertBeforeGeneration as jest.Mock).mockClear();
  (costControlMock.checkBeforeVideoLoop as jest.Mock).mockClear();
  (entitlementsMock.getRemainingVideoShotSlots as jest.Mock).mockClear();
});

// Remplace les ~30 sites d'appel manuel à `new AiOrchestratorService(...)` suite au passage de
// 3 à 6 dépendances (architecture Shot Plan, 2026-08-18) — chaque dépendance est overridable
// individuellement, avec un mock par défaut partagé sinon (mêmes instances réutilisées entre
// tests, cohérent avec le pattern déjà établi pour brandContext/videoFinalization dans ce fichier).
function buildService(
  gateway: AiGatewayService,
  overrides: {
    brandContext?: BrandContextBuilderService;
    videoFinalization?: VideoFinalizationService;
    visualDna?: VisualDnaService;
    videoDirector?: VideoDirectorService;
    videoAnalyzer?: VideoAnalyzerService;
    productIntelligence?: ProductIntelligenceService;
    creativeIntelligence?: CreativeIntelligenceService;
    creativeConcept?: CreativeConceptService;
    creativeGate?: CreativeGateService;
    storyboardGate?: StoryboardGateService;
    costControl?: CostControlService;
    entitlements?: EntitlementsService;
  } = {},
): AiOrchestratorService {
  return new AiOrchestratorService(
    gateway,
    overrides.brandContext ?? brandContext,
    overrides.videoFinalization ?? videoFinalization,
    overrides.visualDna ?? visualDnaMock,
    overrides.videoDirector ?? videoDirectorMock,
    overrides.videoAnalyzer ?? videoAnalyzerMock,
    overrides.productIntelligence ?? productIntelligenceMock,
    overrides.creativeIntelligence ?? creativeIntelligenceMock,
    overrides.creativeConcept ?? creativeConceptMock,
    overrides.creativeGate ?? creativeGateMock,
    overrides.storyboardGate ?? storyboardGateMock,
    overrides.costControl ?? costControlMock,
    overrides.entitlements ?? entitlementsMock,
  );
}

describe('AiOrchestratorService — génération spécifique par canal', () => {
  it('génère un appel generateText DISTINCT pour chaque canal sélectionné, jamais un texte partagé', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram', 'facebook', 'linkedin'] });

    // 2 appels de fondation (analyse + stratégie) + 1 par canal = 5 au total.
    expect((gateway.generateText as jest.Mock).mock.calls.length).toBe(5);
    expect(Object.keys(result.channelContent)).toEqual(['instagram', 'facebook', 'linkedin']);
    // Le point central de ce chantier : chaque canal a bien reçu un prompt DIFFÉRENT,
    // jamais le même texte dupliqué comme c'était le cas auparavant.
    const prompts = (gateway.generateText as jest.Mock).mock.calls.slice(2).map((c) => c[1].prompt);
    expect(new Set(prompts).size).toBe(3);
  });

  // Bug réel constaté en conditions réelles le 2026-08-18 (retour utilisateur) : le prompt de
  // stratégie ne mentionnait jamais les canaux réellement sélectionnés — Claude proposait donc
  // spontanément un plan omnicanal complet (emails, SMS, landing page dédiée, retargeting
  // publicitaire...) que campaign-ai ne produit jamais. Le nouveau gate OBJECTIVE_ACHIEVEMENT
  // comparait ensuite honnêtement ce plan fictif aux quelques posts réellement générés et
  // rejetait la campagne — alors que le vrai défaut était la stratégie elle-même, pas un manque
  // de contenu. Corrigé en bornant explicitement la stratégie aux canaux sélectionnés + au
  // format réellement livré.
  it('borne la stratégie aux canaux réellement sélectionnés et au format réellement livré — pas de tactiques hors périmètre (emails, SMS, landing page...)', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['facebook', 'instagram'] });

    const strategyPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(strategyPrompt).toContain('facebook, instagram');
    expect(strategyPrompt).toContain('un texte publicitaire par canal');
    expect(strategyPrompt).toContain('Ne propose JAMAIS de tactiques hors de ce périmètre');
  });

  it('adapte le prompt Instagram : texte court + hashtags', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(instagramPrompt).toContain('Instagram');
    expect(instagramPrompt).toContain('hashtag');
    expect(instagramPrompt).toContain('courte');
  });

  it("inclut l'objectif de campagne EXPLICITEMENT dans le prompt de copywriting par canal, plus seulement noyé dans la stratégie (chantier du 2026-08-18)", async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(instagramPrompt).toContain('Objectif de la campagne : Vendre 100 paires');
  });

  // Chantier Creative Brief (2026-08-18) : suite au bug réel de greenwashing (stratégie
  // inventant des promesses écologiques non étayées par l'analyse produit, rejetée par le gate
  // OBJECTIVE_ACHIEVEMENT), le prompt de stratégie demande désormais un bloc structuré
  // AUDIENCE/TON/MESSAGE CLÉ/MANDATORIES — ce dernier borne explicitement ce qui peut être
  // affirmé sur le produit, dérivé strictement de l'analyse.
  it('le prompt de stratégie demande un bloc Creative Brief structuré (AUDIENCE/TON/MESSAGE CLÉ/MANDATORIES) ancré sur l\'analyse produit', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const strategyPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(strategyPrompt).toContain('AUDIENCE :');
    expect(strategyPrompt).toContain('TON :');
    expect(strategyPrompt).toContain('MESSAGE CLÉ :');
    expect(strategyPrompt).toContain('MANDATORIES :');
    expect(strategyPrompt).toContain('jamais une caractéristique inventée');
  });

  // Chantier Product Intelligence (2026-08-18) : le profil produit (cache-or-build) doit être
  // réellement consommé par le pipeline existant — pas seulement construit et jamais utilisé.
  it('avec une vraie photo produit : construit le Product Intelligence Profile et injecte son contexte de grounding dans le prompt de stratégie', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      objective: 'Vendre',
      productImageUrl: 'https://cdn.example.com/vraie-photo.png',
      channels: ['instagram'],
    });

    expect(productIntelligenceMock.buildProfile).toHaveBeenCalledWith(expect.anything(), 'org-1', 'https://cdn.example.com/vraie-photo.png', undefined);
    // calls[0] et non [1] ici : avec une photo, productAnalysis passe par analyzeImage (pas
    // generateText) — la stratégie est donc le 1er appel generateText, pas le 2e.
    const strategyPrompt = (gateway.generateText as jest.Mock).mock.calls[0][1].prompt;
    expect(strategyPrompt).toContain('Intelligence produit (source de vérité');
    expect(strategyPrompt).toContain('TestBrand');
    expect(strategyPrompt).toContain('confort premium');
  });

  it('sans photo produit (texte seul) : le Product Intelligence Profile n\'est JAMAIS construit — pas de coût IA supplémentaire pour rien à ancrer', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(productIntelligenceMock.buildProfile).not.toHaveBeenCalled();
  });

  it('adapte le prompt LinkedIn : argumentation B2B professionnelle, et route vers Anthropic', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['linkedin'] });

    const call = (gateway.generateText as jest.Mock).mock.calls[2];
    expect(call[1].prompt).toContain('LinkedIn');
    expect(call[1].prompt).toContain('professionnel');
    expect(call[2]).toBe('anthropic'); // raisonnement B2B -> modèle plus fort, pas le modèle économique par défaut
  });

  it('adapte le prompt Facebook : ton conversationnel', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['facebook'] });

    const prompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(prompt).toContain('Facebook');
    expect(prompt).toContain('conversationnel');
  });

  it('adapte le prompt TikTok : hook court + script vidéo par plans, avec Visuel/Voix off distincts', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['tiktok'] });

    const prompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(prompt).toContain('Hook');
    expect(prompt).toContain('Plan 1');
    // Corrige le défaut du 2026-08-16 : le prompt doit explicitement demander un texte à dire
    // à voix haute par plan (pas seulement une mise en scène) pour que la narration atteigne
    // la durée demandée (15-30s) — cf. scriptToNarration().
    expect(prompt).toContain('Voix off');
    expect(prompt).toContain('15 et 30 secondes');
  });

  // Audit forensic (2026-08-20, campagne réelle 5345726a-5ace-49ec-821e-b0355aaac4df) — le script
  // TikTok (source de la narration finale via scriptToNarration) était rédigé SANS connaître le
  // Creative Concept déjà utilisé pour le Shot Plan/la vidéo : deux pipelines créatifs
  // indépendants, d'où une voix off générique ("inventaire de caractéristiques produit") qui
  // contredisait systématiquement le concept réellement filmé (storytelling/hookStrength/pacing/
  // brandCoherence/advertisingEffectiveness tous en défaut CRITIQUE en conditions réelles).
  it('le prompt TikTok reçoit le Creative Concept réel (hook/approche narrative/direction émotionnelle), pas seulement la stratégie générique', async () => {
    const gateway = buildGatewayMock();
    const richConcept: CreativeConcept = {
      ...DEFAULT_CONCEPT,
      title: 'Le bruit qu\'on n\'entend jamais',
      hook: 'Une réunion silencieuse, puis une lumière discrète — jamais de bip.',
      coreMessage: 'La vraie innovation ne se voit pas, ne s\'entend pas — elle s\'intègre.',
      storytellingApproach: 'Structure en tension-résolution : on installe une attente, puis on la déjoue par le silence total.',
      emotionalDirection: 'Sérénité et satisfaction discrète.',
    };
    const service = buildService(gateway, { creativeConcept: buildCreativeConceptMock(richConcept) });
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['tiktok'] });

    const prompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    expect(prompt).toContain('Le bruit qu\'on n\'entend jamais');
    expect(prompt).toContain('Une réunion silencieuse, puis une lumière discrète — jamais de bip.');
    expect(prompt).toContain('Structure en tension-résolution : on installe une attente, puis on la déjoue par le silence total.');
    expect(prompt).toContain('Sérénité et satisfaction discrète.');
    // Instruction explicite : jamais un inventaire de caractéristiques, doit suivre le concept.
    expect(prompt).toContain('jamais un simple inventaire de caractéristiques produit');
  });

  it('le prompt vidéo envoyé à Veo provient de VideoDirectorService.serializeShotToPrompt, pas construit directement par l\'Orchestrateur', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const videoPrompt = (gateway.generateVideo as jest.Mock).mock.calls[0][1].prompt;
    // Le mock partagé de VideoDirectorService renvoie "PROMPT[camera]" — si ce texte apparaît
    // tel quel dans le prompt envoyé à Veo, c'est bien serializeShotToPrompt qui l'a produit.
    expect(videoPrompt).toBe('PROMPT[dolly-in]');
    expect(videoDirectorMock.serializeShotToPrompt).toHaveBeenCalledWith(DEFAULT_SHOT);
  });

  it("le prompt du visuel (image) publicitaire est orienté objectif — plus la simple ligne \"Visuel publicitaire pour: {productDescription}\" d'avant le chantier du 2026-08-18", async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const [, imageParams] = (gateway.generateImage as jest.Mock).mock.calls[0];
    expect(imageParams.prompt).toContain('Objectif de la campagne : Vendre 100 paires');
    expect(imageParams.prompt).toContain('Chaussures de course');
  });

  // Chantier "fidélité visuelle du visuel marketing" (2026-08-18) : bug réel constaté en
  // conditions réelles — le visuel était généré en texte-vers-image PUR même quand une vraie
  // photo produit était disponible, pouvant représenter un produit/une marque différente de
  // celle réellement injectée. Verrouille le routage correctif : ancrage + OpenAI prioritaire
  // UNIQUEMENT quand une vraie photo existe, comportement inchangé (Flux, pas d'ancrage) sinon.
  it('avec une vraie photo produit : le visuel est généré avec imageUrl renseigné, routé vers OpenAI (édition ancrée) plutôt que Flux', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      objective: 'Vendre',
      productImageUrl: 'https://cdn.example.com/vraie-photo.png',
      channels: ['instagram'],
    });

    const [, imageParams, provider] = (gateway.generateImage as jest.Mock).mock.calls[0];
    expect(imageParams.imageUrl).toBe('https://cdn.example.com/vraie-photo.png');
    expect(provider).toBe('openai');
  });

  // Routage Flux→OpenAI pour le cas sans photo changé le 2026-08-19 (constaté en conditions
  // réelles) : REPLICATE_API_TOKEN/IDEOGRAM_API_KEY sont vides dans cet environnement — router
  // vers Flux en premier demandait systématiquement un aller-retour voué à l'échec (401) avant
  // de retomber sur openai (désormais seul fournisseur du repli generateImage, cf.
  // AiGatewayService.fallbackChains). openai demandé directement tant que ces comptes ne sont
  // pas configurés.
  it('sans photo produit (texte seul) : le visuel est routé vers OpenAI, sans imageUrl', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const [, imageParams, provider] = (gateway.generateImage as jest.Mock).mock.calls[0];
    expect(imageParams.imageUrl).toBeUndefined();
    expect(provider).toBe('openai');
  });

  it('transmet le visuel généré (ou la vraie photo si fournie) comme image source de la vidéo — nécessaire à Veo (ancrage) et à Runway (repli image-to-video)', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);
    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const [, videoParams] = (gateway.generateVideo as jest.Mock).mock.calls[0];
    expect(videoParams.imageUrl).toBe('https://example.com/image.png'); // visual.content du mock generateImage — pas de photo uploadée ici
  });

  describe('narration (voix off) et sous-titres', () => {
    it('dérive la narration du script TikTok, en retirant les lignes "Plan N — ..." (indications de mise en scène, pas du texte parlé)', async () => {
      const gateway = buildGatewayMock({ TikTok: 'Hook: Regardez ça !\nPlan 1 — gros plan produit\nPlan 2 — logo final' });
      const service = buildService(gateway);
      await service.generateCampaign({ ...BASE_PARAMS, channels: ['tiktok'] });

      const narrationPrompt = (gateway.generateAudio as jest.Mock).mock.calls[0][1].prompt;
      expect(narrationPrompt).toContain('Regardez ça');
      expect(narrationPrompt).not.toContain('Plan 1');
      expect(narrationPrompt).not.toContain('Plan 2');
    });

    // Régression du 2026-08-16 : avec le format "Voix off: ..." demandé par buildChannelPrompt
    // (cas 'tiktok'), la narration doit reprendre le Hook ET chaque réplique "Voix off", jamais
    // seulement le Hook — sinon la vidéo finale est bien plus courte que les 15-30s demandés au
    // modèle (finalDuration = narrationDuration, cf. VideoAssemblyService).
    it('avec le format "Visuel/Voix off" par plan, la narration reprend le Hook ET chaque réplique "Voix off" — pas seulement le Hook', async () => {
      const gateway = buildGatewayMock({
        TikTok:
          'Hook: Une photo suffit.\n\n' +
          'Plan 1 — Visuel: gros plan smartphone | Voix off: Déposez votre photo produit.\n' +
          'Plan 2 — Visuel: écran de génération | Voix off: Notre IA génère toute votre campagne.\n' +
          'Plan 3 — Visuel: logo final | Voix off: Essayez gratuitement dès aujourd\'hui.',
      });
      const service = buildService(gateway);
      await service.generateCampaign({ ...BASE_PARAMS, channels: ['tiktok'] });

      const narrationPrompt = (gateway.generateAudio as jest.Mock).mock.calls[0][1].prompt;
      expect(narrationPrompt).toContain('Une photo suffit');
      expect(narrationPrompt).toContain('Déposez votre photo produit');
      expect(narrationPrompt).toContain('Notre IA génère toute votre campagne');
      expect(narrationPrompt).toContain('Essayez gratuitement');
      expect(narrationPrompt).not.toContain('Visuel:');
      expect(narrationPrompt).not.toContain('gros plan smartphone');
    });

    // Bug corrigé le 2026-08-19 (constaté sur le 1er passage E2E réel du chantier Creative
    // Intelligence Engine — Video Judge : storytelling 15/100, hookStrength 25/100, ctaClarity
    // 10/100) : la narration de repli (sans canal TikTok) reconstruisait le texte à partir de la
    // SEULE productDescription brute, ignorant totalement le hook/message central/CTA déjà
    // produits par CreativeConceptService — la publicité pensée en amont n'atteignait jamais la
    // voix off réellement générée.
    it("sans canal TikTok, la narration de repli s'appuie sur le Creative Concept (hook + message central + CTA), pas sur la seule productDescription", async () => {
      const gateway = buildGatewayMock();
      const richConcept: CreativeConcept = {
        ...DEFAULT_CONCEPT,
        hook: "Ce bleu marine mat n'est pas qu'une question de style",
        coreMessage: 'Un design premium qui tient vraiment ses promesses.',
        cta: 'Commandez dès maintenant',
      };
      const service = buildService(gateway, { creativeConcept: buildCreativeConceptMock(richConcept) });
      await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

      expect(gateway.generateAudio as jest.Mock).toHaveBeenCalledTimes(1);
      const narrationPrompt = (gateway.generateAudio as jest.Mock).mock.calls[0][1].prompt;
      expect(narrationPrompt).toContain("Ce bleu marine mat n'est pas qu'une question de style");
      expect(narrationPrompt).toContain('Un design premium qui tient vraiment ses promesses');
      expect(narrationPrompt).toContain('Commandez dès maintenant');
    });

    it('sans canal TikTok ET sans Creative Concept exploitable (champs vides), se rabat sur productDescription plutôt que sur une narration vide', async () => {
      const gateway = buildGatewayMock();
      const emptyConcept: CreativeConcept = { ...DEFAULT_CONCEPT, hook: '', coreMessage: '', cta: '' };
      const service = buildService(gateway, { creativeConcept: buildCreativeConceptMock(emptyConcept) });
      await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

      expect(gateway.generateAudio as jest.Mock).toHaveBeenCalledTimes(1);
      const narrationPrompt = (gateway.generateAudio as jest.Mock).mock.calls[0][1].prompt;
      expect(narrationPrompt).toContain('Chaussures de course');
    });

    // Régression du 2026-08-17 : productDescription est souvent l'analyse vision complète
    // (plusieurs phrases, parfois un paragraphe entier), pas un nom de produit court. Sans
    // troncature, la narration de repli lisait ce texte intégralement — jusqu'à 20-30s de voix
    // off pour un clip vidéo unique plafonné à 6-8s côté fournisseur (sans canal TikTok pour
    // déclencher le multi-plans), gelant l'image sur l'essentiel de la vidéo finale (retour
    // utilisateur, perçu comme "quasi statique").
    it('sans canal TikTok ET sans Creative Concept exploitable, tronque une productDescription longue plutôt que de la lire intégralement dans la narration', async () => {
      const longDescription =
        'Catégories détectées, SaaS d\'automatisation marketing, IA pour réseaux sociaux, fourchette de prix estimée entre 29 et 149 euros par mois, essai gratuit disponible sans engagement, compatible avec Instagram TikTok et Facebook.';
      const gateway = buildGatewayMock();
      const emptyConcept: CreativeConcept = { ...DEFAULT_CONCEPT, hook: '', coreMessage: '', cta: '' };
      const service = buildService(gateway, { creativeConcept: buildCreativeConceptMock(emptyConcept) });
      await service.generateCampaign({ ...BASE_PARAMS, productDescription: longDescription, channels: ['instagram'] });

      const narrationPrompt = (gateway.generateAudio as jest.Mock).mock.calls[0][1].prompt;
      expect(narrationPrompt.length).toBeLessThan(longDescription.length);
      expect(narrationPrompt).not.toBe(`Découvrez ${longDescription}.`);
    });

    // Bug réel constaté en conditions réelles le 2026-08-18 (retour utilisateur, campagne
    // "Lancement gamme entretien écologique") : sans description saisie par l'utilisateur ET
    // sans canal TikTok, `effectiveParams.productDescription` est le bloc ÉTIQUETÉ produit par
    // formatProductAnalysis() ("Catégorie détectée : ...\n..."), pas une phrase naturelle — la
    // narration disait littéralement "Découvrez Catégorie détectée : Produits ménagers...".
    it("sans productDescription fourni ET sans canal TikTok (photo seule) ET sans Creative Concept exploitable, la narration de repli est une phrase naturelle — jamais \"Découvrez Catégorie détectée : ...\"", async () => {
      const gateway = buildGatewayMock({}, JSON.stringify({
        category: 'kit de nettoyants multi-usages',
        priceRange: '10-25 €',
        strengths: ['Formats variés', 'Dosage précis'],
        usp: "Pack tout-en-un couvrant la plupart des besoins de nettoyage domestique",
      }));
      const emptyConcept: CreativeConcept = { ...DEFAULT_CONCEPT, hook: '', coreMessage: '', cta: '' };
      const service = buildService(gateway, { creativeConcept: buildCreativeConceptMock(emptyConcept) });
      await service.generateCampaign({
        organizationId: 'org-1',
        campaignId: 'camp-1',
        objective: 'Vendre',
        productImageUrl: 'https://cdn.example.com/produit.png',
        channels: ['instagram'],
      });

      const narrationPrompt = (gateway.generateAudio as jest.Mock).mock.calls[0][1].prompt;
      expect(narrationPrompt).not.toContain('Catégorie détectée');
      expect(narrationPrompt).toContain('kit de nettoyants multi-usages');
      expect(narrationPrompt).toContain('Pack tout-en-un');
    });

    it('transcrit la narration générée (pas le texte du script) pour obtenir le timing réel des sous-titres', async () => {
      const gateway = buildGatewayMock();
      const service = buildService(gateway);
      const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

      expect(gateway.transcribeAudio as jest.Mock).toHaveBeenCalledTimes(1);
      const [, transcribeParams] = (gateway.transcribeAudio as jest.Mock).mock.calls[0];
      expect(transcribeParams.audioBuffer).toBeInstanceOf(Buffer);
      expect(transcribeParams.mimeType).toBe('audio/mpeg');
      expect(result.transcript).toEqual([{ start: 0, end: 1.5, text: 'Une photo.' }]);
    });

    it('mode mock (narration = simple URL, pas un data URI) : transcript dégrade à null sans jamais appeler transcribeAudio', async () => {
      const gateway = buildGatewayMock();
      (gateway.generateAudio as jest.Mock).mockResolvedValue({
        content: 'https://example.com/mock-narration.mp3',
        provider: 'mock',
        model: 'mock-audio-v1',
        durationMs: 10,
      });
      const service = buildService(gateway);

      const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

      expect(result.transcript).toBeNull();
      expect(gateway.transcribeAudio as jest.Mock).not.toHaveBeenCalled();
    });

    it('échec de transcription (fournisseur en panne) : dégrade à transcript null, ne fait jamais échouer toute la campagne', async () => {
      const gateway = buildGatewayMock();
      (gateway.transcribeAudio as jest.Mock).mockRejectedValue(new Error('Whisper indisponible (500)'));
      const service = buildService(gateway);

      const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

      expect(result.transcript).toBeNull();
      expect(result.narration.content).toBeTruthy();
      expect(result.video?.content).toBeTruthy();
    });
  });

  describe('Google Ads — validation stricte des contraintes publicitaires', () => {
    it('parse le JSON, tronque les titres à 30 caractères et les descriptions à 90', async () => {
      const longHeadline = 'Cette accroche fait bien plus de trente caractères de long';
      const longDescription = 'Cette description dépasse largement la limite de quatre-vingt-dix caractères autorisée par Google Ads pour une annonce responsive';
      const gateway = buildGatewayMock({
        'Google Ads': JSON.stringify({ headlines: [longHeadline, 'Court', 'Aussi court'], descriptions: [longDescription, 'Description courte'] }),
      });
      const service = buildService(gateway);

      const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['googleads'] });
      const content = result.channelContent.googleads.content;

      // Aucune ligne de titre ne doit dépasser 30 caractères (hors numérotation "1. ").
      const headlineLines = content.split('\n').filter((l) => /^\d+\. /.test(l)).slice(0, 3);
      for (const line of headlineLines) {
        const text = line.replace(/^\d+\. /, '');
        expect(text.length).toBeLessThanOrEqual(30);
      }
      expect(content).toContain('…'); // le titre trop long a bien été tronqué avec une ellipse
    });

    it('se rabat sur le texte brut si le modèle ne respecte pas le format JSON demandé', async () => {
      const gateway = buildGatewayMock({ 'Google Ads': 'Désolé, voici votre annonce : un texte libre, pas du JSON.' });
      const service = buildService(gateway);

      const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['googleads'] });

      // Ne plante jamais — le texte brut est conservé tel quel pour revue humaine.
      expect(result.channelContent.googleads.content).toContain('texte libre');
    });
  });

  it('sans canal spécifié, génère un seul contenu générique sous la clé "general"', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: [] });

    expect(Object.keys(result.channelContent)).toEqual(['general']);
  });
});

describe('AiOrchestratorService — analyse produit par photo ("une photo suffit")', () => {
  const IMAGE_PARAMS = { organizationId: 'org-1', campaignId: 'camp-1', objective: 'Vendre 100 paires', productImageUrl: 'https://cdn.example.com/product.png' };

  it('sans productImageUrl, analyzeImage n\'est jamais appelé — chemin texte-seul historique inchangé', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gateway.analyzeImage as jest.Mock).not.toHaveBeenCalled();
    expect((gateway.generateText as jest.Mock).mock.calls[0][1].prompt).toContain('Analyse ce produit');
  });

  it('avec productImageUrl, analyzeImage est appelé avec le prompt vision et l\'URL de la photo, à la place de generateText pour l\'analyse', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...IMAGE_PARAMS, channels: ['instagram'] });

    expect(gateway.analyzeImage as jest.Mock).toHaveBeenCalledTimes(1);
    const [, callParams] = (gateway.analyzeImage as jest.Mock).mock.calls[0];
    expect(callParams.imageUrl).toBe('https://cdn.example.com/product.png');
    expect(callParams.prompt).toContain('Observe cette photo de produit');
    expect(callParams.prompt).toContain('JSON strict');
  });

  it('recoupe la description texte fournie avec la photo dans le prompt vision, quand les deux sont présents', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...IMAGE_PARAMS, productDescription: 'Chaussures de course', channels: ['instagram'] });

    const [, callParams] = (gateway.analyzeImage as jest.Mock).mock.calls[0];
    expect(callParams.prompt).toContain('à recouper avec ce que montre la photo');
    expect(callParams.prompt).toContain('Chaussures de course');
  });

  it('formate le JSON d\'analyse vision en texte lisible, réutilisé comme productDescription effective quand aucun texte n\'a été saisi', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    const result = await service.generateCampaign({ ...IMAGE_PARAMS, channels: ['instagram'] });

    expect(result.productAnalysis.content).toContain('Catégorie détectée : Chaussures');
    expect(result.productAnalysis.content).toContain('USP : Amorti premium à prix accessible');
    // La description effective (dérivée de la photo) alimente bien le prompt du canal en aval.
    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(instagramPrompt).toContain('Catégorie détectée : Chaussures');
  });

  it('se rabat sur le texte brut si la réponse vision ne respecte pas le format JSON demandé, sans jamais planter', async () => {
    const gateway = buildGatewayMock({}, 'Désolé, je ne peux pas répondre en JSON, voici une description libre.');
    const service = buildService(gateway);

    const result = await service.generateCampaign({ ...IMAGE_PARAMS, channels: ['instagram'] });

    expect(result.productAnalysis.content).toContain('description libre');
  });

  it('la description utilisateur explicite reste prioritaire pour les prompts en aval, même quand une photo est aussi fournie', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...IMAGE_PARAMS, productDescription: 'Chaussures de course premium', channels: ['instagram'] });

    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(instagramPrompt).toContain('Chaussures de course premium');
    expect(instagramPrompt).not.toContain('Catégorie détectée');
  });
});

// Fix du bug racine identifié à l'audit du 2026-08-12 : BrandService.buildPromptContext()
// n'était jamais appelé nulle part — le contexte de marque n'atteignait donc jamais aucun
// prompt de génération. Ces tests vérifient que BrandContextBuilderService est désormais
// réellement consommé, avec le bon scope à chaque étape.
describe('AiOrchestratorService — intégration du contexte de marque (Lot D)', () => {
  it('injecte le contexte de marque GLOBAL (sans canal) dans le prompt de stratégie', async () => {
    const gateway = buildGatewayMock();
    const contextWithBrand = buildBrandContextMock('Mission : Rendre le sport accessible à tous.');
    const service = buildService(gateway, { brandContext: contextWithBrand });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const globalCall = (contextWithBrand.build as jest.Mock).mock.calls[0][0];
    expect(globalCall.organizationId).toBe('org-1');
    expect(globalCall.channel).toBeUndefined();
    const strategyPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(strategyPrompt).toContain('Mission : Rendre le sport accessible à tous.');
  });

  it('demande un contexte SPÉCIFIQUE À CHAQUE CANAL pour le prompt de copywriting, pas seulement le contexte global', async () => {
    const gateway = buildGatewayMock();
    const contextWithBrand = buildBrandContextMock('Règle : toujours mentionner la livraison gratuite.');
    const service = buildService(gateway, { brandContext: contextWithBrand });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram', 'linkedin'] });

    expect(contextWithBrand.build).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', channel: 'instagram' }));
    expect(contextWithBrand.build).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', channel: 'linkedin' }));

    const instagramPrompt = (gateway.generateText as jest.Mock).mock.calls[2][1].prompt;
    const linkedinPrompt = (gateway.generateText as jest.Mock).mock.calls[3][1].prompt;
    expect(instagramPrompt).toContain('Règle : toujours mentionner la livraison gratuite.');
    expect(linkedinPrompt).toContain('Règle : toujours mentionner la livraison gratuite.');
  });

  it("n'ajoute aucun bloc de contexte de marque quand aucune donnée de marque n'existe (organisation sans Brand Kit)", async () => {
    const gateway = buildGatewayMock();
    const emptyContext = buildBrandContextMock('');
    const service = buildService(gateway, { brandContext: emptyContext });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const strategyPrompt = (gateway.generateText as jest.Mock).mock.calls[1][1].prompt;
    expect(strategyPrompt).not.toContain('Contexte de marque');
  });

  it("transmet l'archétype de persona du template comme persona identifiable, jamais un persona deviné", async () => {
    const gateway = buildGatewayMock();
    const contextWithBrand = buildBrandContextMock('contexte');
    const service = buildService(gateway, { brandContext: contextWithBrand });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'], templateHints: { personaArchetype: 'Responsable marketing PME' } });

    expect(contextWithBrand.build).toHaveBeenCalledWith(expect.objectContaining({ persona: 'Responsable marketing PME' }));
  });
});

// Architecture Shot Plan (2026-08-18) : remplace l'ancien mécanisme à prompt texte unique
// (Veo devait comprendre le produit, inventer le scénario ET cadrer/filmer en même temps) par
// IMAGE → VISION ANALYSIS → VISUAL DNA → VIDEO DIRECTOR → SHOT PLAN → VEO → VIDEO ANALYZER,
// avec régénération (1 max) sur échec qualité — désormais pour TOUTES les campagnes, plus
// seulement quand un script TikTok était disponible.
describe('AiOrchestratorService — architecture Shot Plan (Visual DNA → Video Director → Veo → Video Analyzer)', () => {
  it('extrait l\'ADN visuel depuis la VRAIE photo produit quand elle est fournie, pas depuis le visuel marketing généré', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      objective: 'Vendre',
      productImageUrl: 'https://cdn.example.com/vraie-photo.png',
      channels: ['instagram'],
    });

    const [, imageUrl] = (visualDnaMock.extract as jest.Mock).mock.calls[0];
    expect(imageUrl).toBe('https://cdn.example.com/vraie-photo.png');
  });

  it('extrait l\'ADN visuel depuis le visuel marketing généré (repli) quand aucune photo n\'a été uploadée', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const [, imageUrl] = (visualDnaMock.extract as jest.Mock).mock.calls[0];
    expect(imageUrl).toBe('https://example.com/image.png'); // visual.content du mock generateImage
  });

  it('la même image de référence (photo réelle ou visuel de repli) est transmise à Veo pour CHAQUE plan', async () => {
    const gateway = buildGatewayMock();
    const threeShots = [DEFAULT_SHOT, { ...DEFAULT_SHOT, camera: 'orbit' }, { ...DEFAULT_SHOT, camera: 'close-up' }];
    const service = buildService(gateway, { videoDirector: buildVideoDirectorMock(threeShots), creativeConcept: buildCreativeConceptMock(THREE_SHOT_CONCEPT) });

    await service.generateCampaign({
      organizationId: 'org-1',
      campaignId: 'camp-1',
      objective: 'Vendre',
      productImageUrl: 'https://cdn.example.com/vraie-photo.png',
      channels: ['facebook'], // volontairement PAS tiktok — le Shot Plan s'applique à tous les canaux désormais
    });

    const calls = (gateway.generateVideo as jest.Mock).mock.calls;
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call[1].imageUrl).toBe('https://cdn.example.com/vraie-photo.png');
    }
  });

  it('le Video Director reçoit l\'ADN visuel, la description produit, le contexte de stratégie, la narration prévue et le concept créatif', async () => {
    // Clé de recherche unique à la génération de la stratégie (cf. buildChannelPrompt, qui
    // reprend "Stratégie marketing de référence" mais jamais "SMART") — isole ce contenu du
    // reste des prompts en aval pour vérifier précisément que campaignContext EST bien
    // strategy.content, pas un autre texte généré.
    const gateway = buildGatewayMock({ 'stratégie marketing SMART': 'STRATEGY_CONTENT_MARKER' });
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const [, directorParams] = (videoDirectorMock.generateShotPlan as jest.Mock).mock.calls[0];
    expect(directorParams.visualDna).toEqual(DEFAULT_VISUAL_DNA);
    expect(directorParams.productDescription).toBe('Chaussures de course');
    expect(directorParams.objective).toBe('Vendre 100 paires'); // chantier "prompts précis, orientés objectif" (2026-08-18) — champ dédié, plus seulement noyé dans campaignContext
    expect(directorParams.campaignContext).toBe('STRATEGY_CONTENT_MARKER');
    // Bug corrigé le 2026-08-19 : la narration de repli (sans canal TikTok) vient désormais du
    // Creative Concept (hook/message central/CTA), plus de productDescription — cf. DEFAULT_CONCEPT
    // (hook/coreMessage/cta = 'x' par défaut dans ce fichier de tests) et le describe dédié
    // "voix off et sous-titres" plus bas pour la couverture complète de cette logique.
    expect(directorParams.narrationHint).toBe('x. x. x');
    // P0.3 (chantier Creative Intelligence Engine, 2026-08-18) : shotCount n'est plus un 3e
    // argument positionnel — dérivé de creativeConcept.scenesCount, désormais le VRAI concept
    // produit par CreativeConceptService (mocké ici via creativeConceptMock, cf. DEFAULT_CONCEPT).
    expect(directorParams.creativeConcept).toEqual(DEFAULT_CONCEPT);
  });

  it('génère un clip PAR PLAN du Shot Plan, indépendamment du canal sélectionné (pas seulement TikTok)', async () => {
    const gateway = buildGatewayMock();
    const threeShots = [DEFAULT_SHOT, { ...DEFAULT_SHOT, camera: 'orbit' }, { ...DEFAULT_SHOT, camera: 'close-up' }];
    const service = buildService(gateway, { videoDirector: buildVideoDirectorMock(threeShots), creativeConcept: buildCreativeConceptMock(THREE_SHOT_CONCEPT) });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['facebook'] }); // volontairement PAS tiktok

    expect(gateway.generateVideo as jest.Mock).toHaveBeenCalledTimes(3);
    expect(videoAnalyzerMock.analyze as jest.Mock).toHaveBeenCalledTimes(3);
  });

  it('chaque clip généré est vérifié par le Video Analyzer avant d\'être retenu', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(videoAnalyzerMock.analyze as jest.Mock).toHaveBeenCalledTimes(1);
    const [, clipContent, analyzeParams] = (videoAnalyzerMock.analyze as jest.Mock).mock.calls[0];
    expect(clipContent).toBe('https://example.com/video.mp4');
    expect(analyzeParams.visualDna).toEqual(DEFAULT_VISUAL_DNA);
  });

  it('échec qualité puis succès à la régénération : 2 appels generateVideo pour ce plan, le 2e (réussi) retenu', async () => {
    const gateway = buildGatewayMock();
    const secondClip = { content: 'https://example.com/clip-2.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 };
    (gateway.generateVideo as jest.Mock).mockResolvedValueOnce({ content: 'https://example.com/clip-1.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 }).mockResolvedValueOnce(secondClip);
    const analyzer = { analyze: jest.fn().mockResolvedValueOnce(FAILING_QUALITY).mockResolvedValueOnce(PASSING_QUALITY) } as unknown as VideoAnalyzerService;
    const service = buildService(gateway, { videoAnalyzer: analyzer });

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gateway.generateVideo).toHaveBeenCalledTimes(2);
    expect(result.video).toEqual(secondClip);
  });

  // Repair Loop intelligent (chantier du 2026-08-18) : avant ce chantier, le 2e essai renvoyait
  // EXACTEMENT le même prompt que le 1er (tirage aléatoire). Vérifie que le 2e appel utilise
  // désormais le prompt CORRIGÉ renvoyé par VideoDirectorService.repairShotPrompt, pas
  // serializeShotToPrompt à nouveau.
  it('échec qualité puis succès : le 2e appel generateVideo utilise le prompt CORRIGÉ (repairShotPrompt), pas le même texte que le 1er essai', async () => {
    const gateway = buildGatewayMock();
    const analyzer = { analyze: jest.fn().mockResolvedValueOnce(FAILING_QUALITY).mockResolvedValueOnce(PASSING_QUALITY) } as unknown as VideoAnalyzerService;
    const service = buildService(gateway, { videoAnalyzer: analyzer });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    const [, firstCall] = (gateway.generateVideo as jest.Mock).mock.calls[0];
    const [, secondCall] = (gateway.generateVideo as jest.Mock).mock.calls[1];
    expect(firstCall.prompt).toBe('PROMPT[dolly-in]'); // serializeShotToPrompt (1er essai, inchangé)
    expect(secondCall.prompt).toBe('REPAIRED[dolly-in]'); // repairShotPrompt (2e essai, NOUVEAU)
    expect(videoDirectorMock.repairShotPrompt).toHaveBeenCalledWith(DEFAULT_SHOT, FAILING_QUALITY);
  });

  it('échec qualité aux deux tentatives : le meilleur des deux essais (qualityScore le plus haut) est retenu, jamais 0 clip', async () => {
    const gateway = buildGatewayMock();
    const worseClip = { content: 'https://example.com/worse.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 };
    const betterClip = { content: 'https://example.com/better.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 };
    (gateway.generateVideo as jest.Mock).mockResolvedValueOnce(worseClip).mockResolvedValueOnce(betterClip);
    const analyzer = {
      analyze: jest
        .fn()
        .mockResolvedValueOnce({ ...FAILING_QUALITY, qualityScore: 30 })
        .mockResolvedValueOnce({ ...FAILING_QUALITY, qualityScore: 55 }),
    } as unknown as VideoAnalyzerService;
    const service = buildService(gateway, { videoAnalyzer: analyzer });

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gateway.generateVideo).toHaveBeenCalledTimes(2);
    expect(result.video).toEqual(betterClip); // le 2e essai, mieux noté (55 > 30), même si toujours en échec qualité
  });

  it('échec technique sur le RETRY (2e essai) après un 1er essai déjà réussi côté génération : le 1er essai est conservé, la campagne n\'échoue pas', async () => {
    const gateway = buildGatewayMock();
    const firstClip = { content: 'https://example.com/clip-1.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 };
    (gateway.generateVideo as jest.Mock).mockResolvedValueOnce(firstClip).mockRejectedValueOnce(new Error('Google Veo indisponible (500)'));
    // Le 1er essai réussit à générer un clip mais échoue la vérification qualité -> déclenche
    // une régénération, qui elle-même échoue techniquement (pas un souci de quota).
    const analyzer = { analyze: jest.fn().mockResolvedValueOnce(FAILING_QUALITY) } as unknown as VideoAnalyzerService;
    const service = buildService(gateway, { videoAnalyzer: analyzer });

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(result.video).toEqual(firstClip);
  });
});

// Phase E (chantier "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Section
// 23-24) : un plan de tournage structurellement invalide ne doit JAMAIS atteindre generateVideo
// (150 crédits/plan) — la validation doit échouer AVANT, gratuitement.
describe('AiOrchestratorService — Phase E : validation structurelle du Shot Plan avant génération vidéo', () => {
  it('nombre de plans ne correspondant pas à creativeConcept.scenesCount : échoue AVANT generateVideo, jamais appelé', async () => {
    const gateway = buildGatewayMock();
    const threeShots = [DEFAULT_SHOT, { ...DEFAULT_SHOT, camera: 'orbit' }, { ...DEFAULT_SHOT, camera: 'close-up' }];
    // scenesCount reste à 1 (DEFAULT_CONCEPT) alors que le Shot Plan mocké en fournit 3 — mismatch délibéré.
    const service = buildService(gateway, { videoDirector: buildVideoDirectorMock(threeShots) });

    await expect(service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] })).rejects.toThrow(/QUALITY_GATE:.*structurellement invalide/);
    expect(gateway.generateVideo as jest.Mock).not.toHaveBeenCalled();
  });

  it("aucun plan ne porte de texte à l'écran ni de voix off : échoue AVANT generateVideo, jamais appelé", async () => {
    const gateway = buildGatewayMock();
    const shotWithoutText: Shot = { ...DEFAULT_SHOT, onScreenText: undefined };
    const service = buildService(gateway, { videoDirector: buildVideoDirectorMock([shotWithoutText]) });

    await expect(service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] })).rejects.toThrow(/QUALITY_GATE:/);
    expect(gateway.generateVideo as jest.Mock).not.toHaveBeenCalled();
  });

  it('plan structurellement valide (compte correct, champs requis présents, CTA présent) : generateVideo appelé normalement', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gateway.generateVideo as jest.Mock).toHaveBeenCalledTimes(1);
    expect(result.video).not.toBeNull();
  });
});

// Phase G (chantier "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Sections
// 35-45) : le Creative Gate doit être franchi AVANT tout Shot Plan — jamais la génération vidéo
// utilisée comme outil de découverte pour savoir si le concept fonctionne.
describe('AiOrchestratorService — Phase G : Creative Gate', () => {
  const REVISE_GATE: CreativeGateResult = { ...APPROVED_GATE, status: 'REVISE', score: 60, faiblesses: ['hook trop générique'], recommandation: 'renforcer le hook' };
  const BLOCKED_GATE: CreativeGateResult = { ...APPROVED_GATE, status: 'BLOCKED', score: 20, causesDeRejet: ['produit absent du concept'] };

  it('APPROVED dès le 1er essai : une seule évaluation, le Shot Plan est généré normalement', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(creativeGateMock.evaluate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(videoDirectorMock.generateShotPlan as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('REVISE au 1er essai puis APPROVED après régénération : le concept est régénéré UNE fois avec le retour du jugement, puis la campagne continue', async () => {
    const gateway = buildGatewayMock();
    const gate = { evaluate: jest.fn().mockResolvedValueOnce(REVISE_GATE).mockResolvedValueOnce(APPROVED_GATE) } as unknown as CreativeGateService;
    const concept = { generate: jest.fn().mockResolvedValue(DEFAULT_CONCEPT) } as unknown as CreativeConceptService;
    const service = buildService(gateway, { creativeGate: gate, creativeConcept: concept });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gate.evaluate as jest.Mock).toHaveBeenCalledTimes(2);
    expect(concept.generate as jest.Mock).toHaveBeenCalledTimes(2);
    const [, secondCallParams] = (concept.generate as jest.Mock).mock.calls[1];
    expect(secondCallParams.gateFeedback).toContain('hook trop générique');
    expect(videoDirectorMock.generateShotPlan as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('BLOCKED persistant après la seule régénération autorisée : échoue AVANT le Shot Plan, jamais un 2e cycle de régénération', async () => {
    const gateway = buildGatewayMock();
    const gate = buildCreativeGateMock(BLOCKED_GATE);
    const service = buildService(gateway, { creativeGate: gate });

    await expect(service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] })).rejects.toThrow(/QUALITY_GATE:.*concept publicitaire insuffisant/);

    expect(gate.evaluate as jest.Mock).toHaveBeenCalledTimes(2); // 1er essai + re-évaluation après régénération, jamais plus
    expect(videoDirectorMock.generateShotPlan as jest.Mock).not.toHaveBeenCalled();
    expect(gateway.generateVideo as jest.Mock).not.toHaveBeenCalled();
  });
});

// Phase H (chantier "Moteur d'optimisation de la qualité vidéo — V2", 2026-08-19, spec Sections
// 46-53) : le Storyboard Gate doit être franchi AVANT toute génération vidéo.
describe('AiOrchestratorService — Phase H : Storyboard Gate', () => {
  const REJECT_STORYBOARD: StoryboardGateResult = { ...APPROVED_STORYBOARD_GATE, status: 'REJECT', score: 55, faiblesses: ['aucune démonstration du bénéfice'], recommandation: 'ajouter un plan de démonstration' };

  it('APPROVED dès le 1er essai, aucune scène à élaguer : une seule évaluation, generateVideo appelé pour le plan complet', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(storyboardGateMock.evaluate as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('REJECT au 1er essai puis APPROVED après régénération : le Shot Plan est régénéré UNE fois avec le retour du jugement', async () => {
    const gateway = buildGatewayMock();
    const gate = { evaluate: jest.fn().mockResolvedValueOnce(REJECT_STORYBOARD).mockResolvedValueOnce(APPROVED_STORYBOARD_GATE) } as unknown as StoryboardGateService;
    const service = buildService(gateway, { storyboardGate: gate });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gate.evaluate as jest.Mock).toHaveBeenCalledTimes(2);
    expect(videoDirectorMock.generateShotPlan as jest.Mock).toHaveBeenCalledTimes(2); // 1er plan + régénération
    const [, secondCallParams] = (videoDirectorMock.generateShotPlan as jest.Mock).mock.calls[1];
    expect(secondCallParams.storyboardGateFeedback).toContain('aucune démonstration du bénéfice');
  });

  it('REJECT persistant après la seule régénération autorisée : échoue AVANT generateVideo', async () => {
    const gateway = buildGatewayMock();
    const gate = buildStoryboardGateMock(REJECT_STORYBOARD);
    const service = buildService(gateway, { storyboardGate: gate });

    await expect(service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] })).rejects.toThrow(/QUALITY_GATE:.*storyboard insuffisant/);

    expect(gate.evaluate as jest.Mock).toHaveBeenCalledTimes(2);
    expect(gateway.generateVideo as jest.Mock).not.toHaveBeenCalled();
  });

  it('scenesToRemove non vide : le plan est élagué (garde-fou appliqué) avant la génération vidéo, moins de clips générés', async () => {
    const gateway = buildGatewayMock();
    const threeShots = [
      { ...DEFAULT_SHOT, sceneId: 'shot-1', narrativeRole: 'hook' },
      { ...DEFAULT_SHOT, sceneId: 'shot-2', camera: 'orbit', narrativeRole: 'demonstration', onScreenText: undefined },
      { ...DEFAULT_SHOT, sceneId: 'shot-3', camera: 'close-up', narrativeRole: 'payoff' },
    ];
    // scenesToRemove cible shot-2 (ni hook ni CTA) — doit être effectivement retiré.
    const gate = buildStoryboardGateMock({ ...APPROVED_STORYBOARD_GATE, scenesToRemove: ['shot-2'] });
    const service = buildService(gateway, {
      videoDirector: buildVideoDirectorMock(threeShots),
      creativeConcept: buildCreativeConceptMock(THREE_SHOT_CONCEPT),
      storyboardGate: gate,
    });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gateway.generateVideo as jest.Mock).toHaveBeenCalledTimes(2); // 3 plans - 1 élagué
  });

  // Phase J (chantier V2) — le câblage final (Final Advertising Gate, cf.
  // campaign-generation.processor.ts) a besoin de connaître le statut final de CHAQUE porte,
  // pas seulement APPROVED implicite.
  it('expose creativeGateStatus/storyboardGateStatus sur le résultat, pour le câblage aval (Final Advertising Gate)', async () => {
    const gateway = buildGatewayMock();
    const service = buildService(gateway);

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(result.creativeGateStatus).toBe('APPROVED');
    expect(result.storyboardGateStatus).toBe('APPROVED');
  });
});

// Correction de l'audit du 2026-08-13 : rendre la vidéo obligatoire pour chaque campagne
// (item 63 du README) entre en conflit avec le plafond dédié `maxVideos` de l'essai gratuit
// (1 vidéo au total) — sans ce garde-fou, la 2e/3e campagne d'un essai échouerait
// systématiquement (statut FAILED) au lieu de simplement ne pas avoir de vidéo (cf. item 75).
describe('AiOrchestratorService — dégradation propre quand le quota vidéo dédié est atteint', () => {
  function buildGatewayWithVideoError(error: unknown) {
    const gateway = buildGatewayMock();
    (gateway.generateVideo as jest.Mock).mockRejectedValue(error);
    return gateway;
  }

  const QUOTA_ERROR = new PlanLimitExceededException({
    message: 'Quota de vidéos de l\'essai atteint (1/1)',
    code: 'PLAN_LIMIT_EXCEEDED',
    limitType: 'videos',
    currentPlan: 'trial',
    current: 1,
    limit: 1,
    recommendedPlan: 'growth',
  });

  it('termine la campagne sans vidéo (video: null) quand generateVideo lève un PlanLimitExceededException de type "videos"', async () => {
    const gateway = buildGatewayWithVideoError(QUOTA_ERROR);
    const service = buildService(gateway);

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(result.video).toBeNull();
    // Le reste de la campagne (texte, image) doit rester intact — seule la vidéo est omise.
    expect(result.channelContent.instagram.content).toBeTruthy();
    expect(result.visual.content).toBeTruthy();
  });

  it('ne dégrade PAS pour un autre type de plafond (ex: crédits épuisés) — l\'erreur remonte normalement', async () => {
    const creditsError = new PlanLimitExceededException({
      message: 'Quota de crédits IA atteint',
      code: 'PLAN_LIMIT_EXCEEDED',
      limitType: 'credits',
      currentPlan: 'trial',
      current: 300,
      limit: 300,
      recommendedPlan: 'growth',
    });
    const gateway = buildGatewayWithVideoError(creditsError);
    const service = buildService(gateway);

    await expect(service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] })).rejects.toBe(creditsError);
  });

  it('ne dégrade PAS pour une panne technique réelle dès le 1er essai (fournisseur vidéo indisponible) — jamais de repli silencieux', async () => {
    const providerError = new Error('Google Veo indisponible (500)');
    const gateway = buildGatewayWithVideoError(providerError);
    const service = buildService(gateway);

    await expect(service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] })).rejects.toBe(providerError);
  });

  // Régression du 2026-08-16 (architecture Shot Plan depuis le 2026-08-18) : la vidéo
  // multi-plans appelle generateVideo() PLUSIEURS fois pour UNE campagne — sur l'essai gratuit
  // (maxVideos: 1), le quota est déjà atteint après le 1er clip réussi. Le comportement attendu
  // n'est PAS "aucune vidéo" mais "garder le ou les clips déjà générés" — jamais perdre un clip
  // réussi à cause d'un plafond atteint ensuite. Conséquence gratuite du garde-fou quota
  // existant (assertVideoQuotaAvailable) : aucun code dédié à la régénération n'est nécessaire
  // pour que la tentative de RETRY soit elle-même bloquée par ce même quota.
  it('avec plusieurs plans et un quota atteint après le 1er clip réussi : garde ce clip plutôt que de tout perdre', async () => {
    const gateway = buildGatewayMock();
    const firstClip = { content: 'https://example.com/clip-1.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 };
    (gateway.generateVideo as jest.Mock).mockResolvedValueOnce(firstClip).mockRejectedValue(QUOTA_ERROR);
    const threeShots = [DEFAULT_SHOT, { ...DEFAULT_SHOT, camera: 'orbit' }, { ...DEFAULT_SHOT, camera: 'close-up' }];
    const service = buildService(gateway, { videoDirector: buildVideoDirectorMock(threeShots), creativeConcept: buildCreativeConceptMock(THREE_SHOT_CONCEPT) });

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    // Phase M (2026-08-19) : les 3 plans (aucune dépendance entre eux) sont désormais lancés
    // CONCURREMMENT dans la même vague — le 1er obtient un clip, les 2e/3e échouent chacun
    // immédiatement sur le quota (dégradation propre par plan, cf. generateSingleShot), pas
    // seulement le 2e comme du temps de la boucle séquentielle. L'issue reste identique (le clip
    // déjà obtenu n'est jamais perdu), seul le nombre d'appels change (3, pas 2).
    expect(result.video).toEqual(firstClip);
    expect(gateway.generateVideo).toHaveBeenCalledTimes(3);
    // Un seul clip réussi -> renvoyé tel quel, jamais concaténé (rien à enchaîner avec un seul
    // élément) — concatenateClips ne doit donc jamais être appelé dans ce scénario précis.
    expect((videoFinalization.concatenateClips as jest.Mock).mock.calls.length).toBe(0);
  });

  // Bug corrigé le 2026-08-18 : avant ce correctif, seul limitType 'videos' déclenchait la
  // dégradation propre — un plafond 'videoShots' (cf. EntitlementsService, plafond de clips
  // DANS une campagne, distinct de 'videos' qui borne les campagnes distinctes) remontait
  // comme une vraie erreur et faisait échouer TOUTE la campagne, y compris les clips déjà
  // générés avec succès. Cas réel qui l'a révélé : régénérer une campagne dont une tentative
  // précédente avait déjà consommé une partie du quota de clips pour CE campaignId.
  it('avec plusieurs plans et un quota "videoShots" (clips DANS cette campagne) atteint : garde les clips déjà réussis plutôt que de tout perdre', async () => {
    const gateway = buildGatewayMock();
    const firstClip = { content: 'https://example.com/clip-1.mp4', provider: 'google-veo', model: 'veo-1', durationMs: 10 };
    const SHOTS_QUOTA_ERROR = new PlanLimitExceededException({
      message: 'Quota de plans vidéo pour cette campagne atteint (6/6)',
      code: 'PLAN_LIMIT_EXCEEDED',
      limitType: 'videoShots',
      currentPlan: 'trial',
      current: 6,
      limit: 6,
      recommendedPlan: 'growth',
    });
    (gateway.generateVideo as jest.Mock).mockResolvedValueOnce(firstClip).mockRejectedValue(SHOTS_QUOTA_ERROR);
    const threeShots = [DEFAULT_SHOT, { ...DEFAULT_SHOT, camera: 'orbit' }, { ...DEFAULT_SHOT, camera: 'close-up' }];
    const service = buildService(gateway, { videoDirector: buildVideoDirectorMock(threeShots), creativeConcept: buildCreativeConceptMock(THREE_SHOT_CONCEPT) });

    const result = await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    // Phase M (2026-08-19) : cf. commentaire du test précédent — les 3 plans sont lancés
    // concurremment, seul le 1er réussit, les 2 autres échouent chacun immédiatement sur le
    // quota (3 appels, pas 2).
    expect(result.video).toEqual(firstClip);
    expect(gateway.generateVideo).toHaveBeenCalledTimes(3);
  });
});

// Phase M (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19, spec Section 9-11) —
// génération parallèle des scènes indépendantes (Promise.allSettled intra-job, cf. plan).
describe('AiOrchestratorService — Phase M : parallélisation des scènes indépendantes', () => {
  const clip = (content: string) => ({ content, provider: 'google-veo' as const, model: 'veo-1', durationMs: 5 });

  it('2 scènes indépendantes (dependencies absent) : generateVideo est appelé pour les DEUX avant qu\'aucune des deux ne se termine', async () => {
    const shotA: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-a', camera: 'a' };
    const shotB: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-b', camera: 'b' };
    const gateway = buildGatewayMock();
    const deferreds: Record<string, (v: unknown) => void> = {};
    let callCount = 0;
    let resolveBothCalled!: () => void;
    const bothCalled = new Promise<void>((res) => (resolveBothCalled = res));
    (gateway.generateVideo as jest.Mock).mockImplementation((_ctx: unknown, params: { prompt: string }) => {
      callCount += 1;
      const p = new Promise((resolve) => {
        deferreds[params.prompt] = resolve;
      });
      if (callCount === 2) resolveBothCalled();
      return p;
    });
    const service = buildService(gateway, {
      videoDirector: buildVideoDirectorMock([shotA, shotB]),
      creativeConcept: buildCreativeConceptMock({ ...DEFAULT_CONCEPT, scenesCount: 2 }),
    });

    const resultPromise = service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });
    await bothCalled; // se résout dès que les 2 appels sont partis, AVANT qu'aucun ne soit résolu

    expect(callCount).toBe(2);
    expect(Object.keys(deferreds).sort()).toEqual(['PROMPT[a]', 'PROMPT[b]']);

    deferreds['PROMPT[a]'](clip('clip-a'));
    deferreds['PROMPT[b]'](clip('clip-b'));
    await resultPromise;

    expect(gateway.generateVideo).toHaveBeenCalledTimes(2);
  });

  it('scène B avec dependencies: [shot-A] : B n\'est lancée qu\'après la résolution de A (vague 2)', async () => {
    const shotA: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-a', camera: 'a' };
    const shotB: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-b', camera: 'b', dependencies: ['shot-a'] };
    const gateway = buildGatewayMock();
    const callOrder: string[] = [];
    let resolveA!: (v: unknown) => void;
    (gateway.generateVideo as jest.Mock).mockImplementation((_ctx: unknown, params: { prompt: string }) => {
      callOrder.push(params.prompt);
      if (params.prompt === 'PROMPT[a]') return new Promise((resolve) => (resolveA = resolve));
      return Promise.resolve(clip('clip-b'));
    });
    const service = buildService(gateway, {
      videoDirector: buildVideoDirectorMock([shotA, shotB]),
      creativeConcept: buildCreativeConceptMock({ ...DEFAULT_CONCEPT, scenesCount: 2 }),
    });

    const resultPromise = service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(callOrder).toEqual(['PROMPT[a]']); // B jamais lancée tant que A n'est pas résolue

    resolveA(clip('clip-a'));
    await resultPromise;

    expect(callOrder).toEqual(['PROMPT[a]', 'PROMPT[b]']);
  });

  it('quota permettant seulement 1 génération sur un plan à 3 scènes : seule la scène de plus haute priorité (hook) est effectivement lancée', async () => {
    const hook: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-hook', camera: 'hook-cam', narrativeRole: 'hook' };
    const demo: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-demo', camera: 'demo-cam', narrativeRole: 'demonstration' };
    const secondary: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-secondary', camera: 'secondary-cam', narrativeRole: 'establishing' };
    const gateway = buildGatewayMock();
    const service = buildService(gateway, {
      videoDirector: buildVideoDirectorMock([secondary, demo, hook]), // ordre arbitraire dans le tableau
      creativeConcept: buildCreativeConceptMock({ ...DEFAULT_CONCEPT, scenesCount: 3 }),
      entitlements: buildEntitlementsMock(1),
    });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(gateway.generateVideo).toHaveBeenCalledTimes(1);
    expect((gateway.generateVideo as jest.Mock).mock.calls[0][1].prompt).toBe('PROMPT[hook-cam]');
  });

  it('réassemble le résultat dans l\'ORDRE DE PRIORITÉ même si les promesses se résolvent dans le désordre', async () => {
    const hook: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-hook', camera: 'hook-cam', narrativeRole: 'hook' };
    const secondary: Shot = { ...DEFAULT_SHOT, sceneId: 'shot-secondary', camera: 'secondary-cam', narrativeRole: 'establishing' };
    const gateway = buildGatewayMock();
    (gateway.generateVideo as jest.Mock).mockImplementation((_ctx: unknown, params: { prompt: string }) => {
      if (params.prompt === 'PROMPT[hook-cam]') {
        // Résout DERNIER même si lancé en même temps que l'autre — la priorité (pas l'ordre de
        // complétion) doit gouverner l'ordre final.
        return new Promise((resolve) => setTimeout(() => resolve(clip('clip-hook')), 20));
      }
      return Promise.resolve(clip('clip-secondary'));
    });
    const concatenateClips = jest.fn().mockResolvedValue('data:video/mp4;base64,Y29tYmluZWQ=');
    const service = buildService(gateway, {
      videoDirector: buildVideoDirectorMock([secondary, hook]), // secondary en 1er dans le tableau, hook prioritaire
      creativeConcept: buildCreativeConceptMock({ ...DEFAULT_CONCEPT, scenesCount: 2 }),
      videoFinalization: buildVideoFinalizationMock(concatenateClips),
    });

    await service.generateCampaign({ ...BASE_PARAMS, channels: ['instagram'] });

    expect(concatenateClips.mock.calls[0][0]).toEqual(['clip-hook', 'clip-secondary']);
  });
});

// Phase P (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19, spec Section 16-19) —
// méthodes d'escalade EXÉCUTÉE, appelées par CampaignGenerationProcessor.finalizeVideoAsset
// quand le Video Quality Loop s'épuise (cf. root-cause.ts pour la classification du niveau).
describe('AiOrchestratorService — Phase P : méthodes d\'escalade automatique', () => {
  const ctx = { organizationId: 'org-1', campaignId: 'camp-1', purpose: 'campaign_generation' as const };

  describe('regenerateShotPlanAndVideo', () => {
    it('régénère le Shot Plan en seedant storyboardGateFeedback avec escalationFeedback, puis génère la vidéo', async () => {
      const gateway = buildGatewayMock();
      const videoDirector = buildVideoDirectorMock([DEFAULT_SHOT]);
      const service = buildService(gateway, { videoDirector });

      const result = await service.regenerateShotPlanAndVideo(ctx, {
        creativeConcept: DEFAULT_CONCEPT,
        visualDnaResult: DEFAULT_VISUAL_DNA,
        referenceImageUrl: 'https://cdn.example.com/photo.png',
        effectiveParams: BASE_PARAMS,
        strategy: 'Stratégie X',
        narrationText: 'Narration X',
        organizationId: 'org-1',
        escalationFeedback: 'Le hook ne convainc pas',
      });

      const [, directorParams] = (videoDirector.generateShotPlan as jest.Mock).mock.calls[0];
      expect(directorParams.storyboardGateFeedback).toBe('Le hook ne convainc pas');
      expect(result.shotPlan).toEqual([DEFAULT_SHOT]);
      expect(result.storyboardGateStatus).toBe('APPROVED');
      expect(gateway.generateVideo).toHaveBeenCalledTimes(1);
      expect(result.video).toBeTruthy();
    });

    it('échoue proprement (QUALITY_GATE) si le storyboard reste REJECT après l\'unique régénération, jamais de generateVideo', async () => {
      const gateway = buildGatewayMock();
      const storyboardGate = buildStoryboardGateMock({ status: 'REJECT', score: 40, scenesToRemove: [], faiblesses: ['incohérent'], recommandation: '' });
      const service = buildService(gateway, { storyboardGate });

      await expect(
        service.regenerateShotPlanAndVideo(ctx, {
          creativeConcept: DEFAULT_CONCEPT,
          visualDnaResult: DEFAULT_VISUAL_DNA,
          referenceImageUrl: 'https://cdn.example.com/photo.png',
          effectiveParams: BASE_PARAMS,
          strategy: 'Stratégie X',
          narrationText: 'Narration X',
          organizationId: 'org-1',
        }),
      ).rejects.toThrow(/QUALITY_GATE/);
      expect(gateway.generateVideo).not.toHaveBeenCalled();
    });
  });

  describe('regenerateConceptStoryboardAndVideo', () => {
    it('régénère le concept en seedant gateFeedback avec escalationFeedback, régénère la narration, puis compose regenerateShotPlanAndVideo', async () => {
      const gateway = buildGatewayMock();
      const videoDirector = buildVideoDirectorMock([DEFAULT_SHOT]);
      const service = buildService(gateway, { videoDirector });

      const result = await service.regenerateConceptStoryboardAndVideo(ctx, {
        creativeIntelligence: DEFAULT_CREATIVE_INTELLIGENCE,
        visualDnaResult: DEFAULT_VISUAL_DNA,
        referenceImageUrl: 'https://cdn.example.com/photo.png',
        effectiveParams: BASE_PARAMS,
        strategy: 'Stratégie X',
        organizationId: 'org-1',
        productProfile: null,
        escalationFeedback: 'Le concept ne convainc jamais',
      });

      const [, conceptParams] = (creativeConceptMock.generate as jest.Mock).mock.calls[0];
      expect(conceptParams.gateFeedback).toBe('Le concept ne convainc jamais');
      expect(result.creativeGateStatus).toBe('APPROVED');
      expect(result.storyboardGateStatus).toBe('APPROVED');
      expect(gateway.generateAudio).toHaveBeenCalledTimes(1); // narration régénérée sur le NOUVEAU concept
      expect(result.narrationDataUri).toBeTruthy();
      expect(result.narrationText).toBeTruthy();
      expect(result.shotPlan).toEqual([DEFAULT_SHOT]);
      expect(gateway.generateVideo).toHaveBeenCalledTimes(1);
    });

    it('échoue proprement (QUALITY_GATE) si le Creative Gate reste BLOCKED après l\'unique régénération, jamais de narration ni de vidéo régénérées', async () => {
      const gateway = buildGatewayMock();
      const blockedGate: CreativeGateResult = {
        status: 'BLOCKED', score: 10, hook: '', promessePrincipale: '', benefices: [], preuve: '', cta: '',
        forces: [], faiblesses: [], risques: [], causesDeRejet: ['produit non identifiable'], recommandation: '',
      };
      const creativeGate = buildCreativeGateMock(blockedGate);
      const service = buildService(gateway, { creativeGate });

      await expect(
        service.regenerateConceptStoryboardAndVideo(ctx, {
          creativeIntelligence: DEFAULT_CREATIVE_INTELLIGENCE,
          visualDnaResult: DEFAULT_VISUAL_DNA,
          referenceImageUrl: 'https://cdn.example.com/photo.png',
          effectiveParams: BASE_PARAMS,
          strategy: 'Stratégie X',
          organizationId: 'org-1',
          productProfile: null,
          escalationFeedback: 'x',
        }),
      ).rejects.toThrow(/QUALITY_GATE/);
      expect(gateway.generateAudio).not.toHaveBeenCalled();
      expect(gateway.generateVideo).not.toHaveBeenCalled();
    });
  });
});
