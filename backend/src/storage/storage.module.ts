import { Module, Global } from '@nestjs/common';
import { StorageService } from './storage.service';

// @Global comme CryptoModule/NotificationsModule : l'upload est déclenché depuis
// AssetsController (upload direct) et CampaignGenerationProcessor (re-hébergement des
// visuels générés) — deux modules indépendants, éviter de réimporter StorageModule partout.
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
