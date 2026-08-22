import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { BrandModule } from '../brand/brand.module';
import { VideoAssemblyModule } from '../video-assembly/video-assembly.module';
import { AiGatewayService } from './ai-gateway/ai-gateway.service';
import { MockProvider } from './ai-gateway/providers/mock.provider';
import { OpenAiProvider } from './ai-gateway/providers/openai.provider';
import { AnthropicProvider } from './ai-gateway/providers/anthropic.provider';
import { GoogleVeoProvider } from './ai-gateway/providers/google-veo.provider';
import { RunwayProvider } from './ai-gateway/providers/runway.provider';
import { FluxProvider } from './ai-gateway/providers/flux.provider';
import { IdeogramProvider } from './ai-gateway/providers/ideogram.provider';
import { AiOrchestratorService } from './ai-orchestrator/ai-orchestrator.service';
import { VisualDnaService } from './video-direction/visual-dna.service';
import { VideoDirectorService } from './video-direction/video-director.service';
import { VideoAnalyzerService } from './video-direction/video-analyzer.service';
import { ProductVisionAnalysisService } from './product-intelligence/product-vision-analysis.service';
import { ProductIdentificationService } from './product-intelligence/product-identification.service';
import { ProductIntelligenceService } from './product-intelligence/product-intelligence.service';
import { ProductIntelligenceFusionService } from './product-intelligence/product-intelligence-fusion.service';
import { SafeProductPageFetcherService } from './product-intelligence/product-page/safe-product-page-fetcher.service';
import { ProductPageLlmExtractorService } from './product-intelligence/product-page/product-page-llm-extractor.service';
import { PromptEngineService } from './prompt-engine/prompt-engine.service';
import { MockWebResearchProvider } from './web-research/mock-web-research.provider';
import { FactVerificationService } from './web-research/fact-verification.service';
import { WebResearchService } from './web-research/web-research.service';
import { CreativeIntelligenceService } from './creative-intelligence/creative-intelligence.service';
import { CreativeConceptService } from './creative-intelligence/creative-concept.service';
import { NarrativeBlueprintService } from './creative-intelligence/narrative-blueprint.service';
import { VideoJudgeService } from './video-judge/video-judge.service';
import { VideoQualityLoopService } from './video-judge/video-quality-loop.service';
import { CreativeGenerationTraceService } from './video-judge/creative-generation-trace.service';
import { CreativeVariationService } from './creative-intelligence/creative-variation.service';
import { CreativeGateService } from './creative-intelligence/creative-gate.service';
import { StoryboardGateService } from './video-direction/storyboard-gate.service';
import { PipelineMetricsService, CampaignComparisonService } from './video-judge/pipeline-metrics.service';

// Le worker qui consomme la queue de génération (CampaignGenerationProcessor) vit
// désormais dans CampaignOrchestrationModule, pas ici : il a besoin à la fois de
// AiOrchestratorService ET de ModerationService, et les faire cohabiter dans ce module
// créerait une dépendance circulaire AiModule <-> ModerationModule.
@Module({
  // VideoAssemblyModule : AiOrchestratorService dépend de VideoFinalizationService pour la
  // concaténation multi-plans (cf. generateShotPlanVideoOrDegrade) — aucune dépendance en
  // sens inverse (VideoAssemblyModule n'importe rien de ce module), donc pas de cycle.
  imports: [PlansModule, BrandModule, VideoAssemblyModule],
  providers: [
    AiGatewayService,
    MockProvider,
    OpenAiProvider,
    AnthropicProvider,
    GoogleVeoProvider,
    RunwayProvider,
    FluxProvider,
    IdeogramProvider,
    // Architecture Shot Plan (2026-08-18) : déclarés directement ici plutôt que dans un module
    // séparé — les trois dépendent de AiGatewayService, qui vit dans CE module ; un module
    // dédié importé ici et ayant lui-même besoin de réimporter AiModule créerait un cycle. Même
    // logique que la cohabitation déjà existante de AiGatewayService et AiOrchestratorService.
    VisualDnaService,
    VideoDirectorService,
    VideoAnalyzerService,
    // Product Intelligence (2026-08-18) : PrismaService est fourni globalement (PrismaModule
    // @Global(), cf. backend/src/prisma/prisma.module.ts) — pas d'import de module nécessaire ici,
    // même situation que AiGatewayService qui injecte déjà PrismaService sans import explicite.
    PromptEngineService,
    ProductVisionAnalysisService,
    ProductIdentificationService,
    ProductIntelligenceService,
    // Mission 4.4 (Product URL Intelligence) — cf. plan dédié. Même convention : déclaré
    // directement ici, pas de sous-module.
    SafeProductPageFetcherService,
    ProductPageLlmExtractorService,
    ProductIntelligenceFusionService,
    // Web Research (P1, 2026-08-18) : architecture prête, AUCUN fournisseur réel sélectionné —
    // règle absolue du brief. MockWebResearchProvider est enregistré comme provider Nest
    // ORDINAIRE (utilisable dans les tests d'intégration futurs) mais n'est JAMAIS lié au token
    // WEB_RESEARCH_REAL_PROVIDER ci-dessous — volontairement absent de ce module. Tant qu'aucune
    // décision n'est prise sur un vrai fournisseur, WebResearchService.researchProduct() reste
    // donc TOUJOURS NOT_CONFIGURED en production (cf. web-research.service.ts).
    MockWebResearchProvider,
    FactVerificationService,
    WebResearchService,
    // Creative Intelligence Engine & Video Quality Loop (2026-08-18) — cf. plan dédié. Même
    // convention que Product Intelligence : déclaré directement ici, pas de sous-module.
    CreativeIntelligenceService,
    CreativeConceptService,
    // Mission 4.3 (Goal-First Quality Architecture, Phase 3) — cf. plan dédié. Même convention :
    // déclaré directement ici, pas de sous-module.
    NarrativeBlueprintService,
    VideoJudgeService,
    VideoQualityLoopService,
    CreativeGenerationTraceService,
    CreativeVariationService,
    // Moteur d'optimisation de la qualité vidéo — V2 (2026-08-19) — cf. plan dédié. Même
    // convention : déclaré directement ici, pas de sous-module.
    CreativeGateService,
    StoryboardGateService,
    AiOrchestratorService,
    // Phase R (chantier "Optimisation du pipeline vidéo — V2.1", 2026-08-19) — service de calcul
    // seul (cf. plan, "périmètre réduit") : aucun endpoint HTTP dans ce chantier, exporté pour
    // qu'un futur contrôleur (suivant le pattern déjà établi par AiEconomicsController) puisse
    // l'exposer sans réenregistrer ce provider.
    PipelineMetricsService,
    // Mission 4.5 (préparation Phases 3-11) — lecture seule, aucun appel IA : croise
    // Campaign/CreativeGenerationTrace/AiGeneration en une ligne comparable par campagne pour la
    // collecte des 5+5 campagnes contrôle/URL, cf. pipeline-metrics.service.ts.
    CampaignComparisonService,
  ],
  exports: [
    AiGatewayService,
    AiOrchestratorService,
    VideoQualityLoopService,
    CreativeGenerationTraceService,
    CreativeVariationService,
    PipelineMetricsService,
    CampaignComparisonService,
  ],
})
export class AiModule {}
