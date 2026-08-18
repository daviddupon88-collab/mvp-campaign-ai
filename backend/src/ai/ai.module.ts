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
    AiOrchestratorService,
  ],
  exports: [AiGatewayService, AiOrchestratorService],
})
export class AiModule {}
