import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { SocialModule } from '../social/social.module';
import { BrandModule } from '../brand/brand.module';
import { PlansModule } from '../plans/plans.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { AnalyticsIngestionService } from './analytics-ingestion.service';
import { AiOptimizerService } from './ai-optimizer.service';
import { OptimizerService } from './optimizer.service';
import { OptimizerOutcomeService } from './optimizer-outcome.service';
import { AutomationService } from './automation.service';
import { OptimizerController } from './optimizer.controller';

@Module({
  imports: [AiModule, SocialModule, BrandModule, PlansModule, IntegrationsModule],
  providers: [AnalyticsIngestionService, AiOptimizerService, OptimizerService, OptimizerOutcomeService, AutomationService],
  controllers: [OptimizerController],
  exports: [AiOptimizerService, AnalyticsIngestionService],
})
export class OptimizerModule {}
