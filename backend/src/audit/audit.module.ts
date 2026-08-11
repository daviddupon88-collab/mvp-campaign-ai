import { Module, Global } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

// @Global comme CryptoModule : la journalisation d'audit est un utilitaire transverse
// appelé depuis de nombreux services métier (approbation, facturation, équipe, publication)
// — éviter de réimporter ce module partout où une action sensible doit être tracée.
@Global()
@Module({
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
