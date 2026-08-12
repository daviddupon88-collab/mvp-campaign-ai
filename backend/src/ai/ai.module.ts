import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { BrandModule } from '../brand/brand.module';
import { AiGatewayService } from './ai-gateway/ai-gateway.service';
import { MockProvider } from './ai-gateway/providers/mock.provider';
import { OpenAiProvider } from './ai-gateway/providers/openai.provider';
import { AnthropicProvider } from './ai-gateway/providers/anthropic.provider';
import { GoogleVeoProvider } from './ai-gateway/providers/google-veo.provider';
import { FluxProvider } from './ai-gateway/providers/flux.provider';
import { IdeogramProvider } from './ai-gateway/providers/ideogram.provider';
import { AiOrchestratorService } from './ai-orchestrator/ai-orchestrator.service';

// Le worker qui consomme la queue de génération (CampaignGenerationProcessor) vit
// désormais dans CampaignOrchestrationModule, pas ici : il a besoin à la fois de
// AiOrchestratorService ET de ModerationService, et les faire cohabiter dans ce module
// créerait une dépendance circulaire AiModule <-> ModerationModule.
@Module({
  imports: [PlansModule, BrandModule],
  providers: [
    AiGatewayService,
    MockProvider,
    OpenAiProvider,
    AnthropicProvider,
    GoogleVeoProvider,
    FluxProvider,
    IdeogramProvider,
    AiOrchestratorService,
  ],
  exports: [AiGatewayService, AiOrchestratorService],
})
export class AiModule {}
