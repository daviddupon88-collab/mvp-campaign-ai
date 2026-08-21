import { Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { CostControlService } from './cost-control.service';
import { PlansController } from './plans.controller';

@Module({
  // CostControlService (P0.9, chantier "Creative Intelligence Engine & Video Quality Loop",
  // 2026-08-18) : dépend uniquement de EntitlementsService (déjà dans ce module) — exporté pour
  // être consommé par AiOrchestratorService (AiModule importe déjà PlansModule).
  providers: [EntitlementsService, CostControlService],
  controllers: [PlansController],
  exports: [EntitlementsService, CostControlService],
})
export class PlansModule {}
