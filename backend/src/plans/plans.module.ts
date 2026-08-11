import { Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { PlansController } from './plans.controller';

@Module({
  providers: [EntitlementsService],
  controllers: [PlansController],
  exports: [EntitlementsService],
})
export class PlansModule {}
