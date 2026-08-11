import { Module, Global } from '@nestjs/common';
import { TokenCryptoService } from './token-crypto.service';

// @Global : le chiffrement des tokens est un utilitaire transverse (utilisé par
// SocialConnectionsService, AnalyticsIngestionService, et potentiellement ProductImportService
// pour les tokens de boutiques e-commerce) — évite de le réimporter dans chaque module appelant.
@Global()
@Module({
  providers: [TokenCryptoService],
  exports: [TokenCryptoService],
})
export class CryptoModule {}
