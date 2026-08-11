import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { AiModule } from '../ai/ai.module';
import { CampaignTemplatesModule } from '../campaign-templates/campaign-templates.module';
import { PlansModule } from '../plans/plans.module';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';

@Module({
  imports: [QueueModule, AiModule, CampaignTemplatesModule, PlansModule],
  providers: [CampaignsService],
  controllers: [CampaignsController],
})
export class CampaignsModule {}
