import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { AiModule } from '../ai/ai.module';
import { ModerationModule } from '../moderation/moderation.module';
import { BrandConsistencyModule } from '../brand-consistency/brand-consistency.module';
import { ContentStudioModule } from '../content-studio/content-studio.module';
import { VideoAssemblyModule } from '../video-assembly/video-assembly.module';
import { CampaignGenerationProcessor } from '../queue/campaign-generation.processor';

// Module d'assemblage : le worker CampaignGenerationProcessor a besoin de AiOrchestratorService
// (génération), ModerationService (garde-fou sécurité), BrandConsistencyService (score qualité),
// ContentStudioService/AssetsService (persistance durable du contenu généré) et
// VideoFinalizationService (montage final : narration + musique + sous-titres), qui vivent
// dans des modules indépendants. Les regrouper ici évite les dépendances circulaires.
@Module({
  imports: [QueueModule, AiModule, ModerationModule, BrandConsistencyModule, ContentStudioModule, VideoAssemblyModule],
  providers: [CampaignGenerationProcessor],
})
export class CampaignOrchestrationModule {}
