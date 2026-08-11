import { Module } from '@nestjs/common';
import { CampaignTemplatesService } from './campaign-templates.service';
import { CampaignTemplatesController } from './campaign-templates.controller';

@Module({
  providers: [CampaignTemplatesService],
  controllers: [CampaignTemplatesController],
  exports: [CampaignTemplatesService],
})
export class CampaignTemplatesModule {}
