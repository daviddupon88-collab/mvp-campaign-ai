import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { AiModule } from '../ai/ai.module';
import { ModerationModule } from '../moderation/moderation.module';
import { BrandConsistencyModule } from '../brand-consistency/brand-consistency.module';
import { ContentStudioModule } from '../content-studio/content-studio.module';
import { CampaignGenerationProcessor } from '../queue/campaign-generation.processor';

// Module d'assemblage : le worker CampaignGenerationProcessor a besoin de AiOrchestratorService
// (génération), ModerationService (garde-fou sécurité), BrandConsistencyService (score qualité),
// ContentStudioService/AssetsService (persistance durable du contenu généré) et, depuis le
// chantier "Creative Intelligence Engine & Video Quality Loop" (2026-08-18),
// VideoQualityLoopService/CreativeGenerationTraceService (montage final + Video Judge + boucle
// de réparation + trace d'observabilité) — tous deux exportés par AiModule, qui importe déjà
// VideoAssemblyModule en interne (plus besoin de l'importer séparément ici). Regroupés ici pour
// éviter les dépendances circulaires.
@Module({
  imports: [QueueModule, AiModule, ModerationModule, BrandConsistencyModule, ContentStudioModule],
  providers: [CampaignGenerationProcessor],
})
export class CampaignOrchestrationModule {}
