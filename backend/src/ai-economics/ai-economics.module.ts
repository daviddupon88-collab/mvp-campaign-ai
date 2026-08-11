import { Module } from '@nestjs/common';
import { AiEconomicsService } from './ai-economics.service';
import { AiEconomicsController } from './ai-economics.controller';

@Module({
  providers: [AiEconomicsService],
  controllers: [AiEconomicsController],
  exports: [AiEconomicsService],
})
export class AiEconomicsModule {}
