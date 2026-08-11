import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { BrandConsistencyService } from './brand-consistency.service';
import { BrandConsistencyController } from './brand-consistency.controller';

@Module({
  imports: [AiModule],
  providers: [BrandConsistencyService],
  controllers: [BrandConsistencyController],
  exports: [BrandConsistencyService],
})
export class BrandConsistencyModule {}
