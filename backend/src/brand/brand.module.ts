import { Module } from '@nestjs/common';
import { BrandService } from './brand.service';
import { BrandLearningService } from './brand-learning.service';
import { BrandMemoryQueryService } from './brand-memory-query.service';
import { ContradictionService } from './contradiction.service';
import { BrandContextBuilderService } from './brand-context-builder.service';
import { BrandRuleGuardService } from './brand-rule-guard.service';
import { BrandBriefService } from './brand-brief.service';
import { BrandController } from './brand.controller';

@Module({
  providers: [
    BrandService,
    BrandLearningService,
    BrandMemoryQueryService,
    ContradictionService,
    BrandContextBuilderService,
    BrandRuleGuardService,
    BrandBriefService,
  ],
  controllers: [BrandController],
  exports: [
    BrandService,
    BrandLearningService,
    BrandMemoryQueryService,
    ContradictionService,
    BrandContextBuilderService,
    BrandRuleGuardService,
    BrandBriefService,
  ],
})
export class BrandModule {}
