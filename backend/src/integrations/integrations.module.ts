import { Module } from '@nestjs/common';
import { ClickTrackingController } from './click-tracking.controller';
import { ClickTrackingService } from './click-tracking.service';
import { MetaCapiConfigController } from './meta-capi-config.controller';
import { MetaCapiConfigService } from './meta-capi-config.service';
import { MetaCapiService } from './meta-capi.service';

// PrismaService et TokenCryptoService sont globaux (CryptoModule/PrismaModule @Global()) —
// aucun import de module requis ici. MetaCapiService est exporté pour être consommé par
// AnalyticsIngestionService (OptimizerModule) lors de l'enregistrement d'une conversion
// manuelle, cf. plan de conception "Intégration Conversions API réelle".
@Module({
  controllers: [ClickTrackingController, MetaCapiConfigController],
  providers: [ClickTrackingService, MetaCapiConfigService, MetaCapiService],
  exports: [MetaCapiService],
})
export class IntegrationsModule {}
