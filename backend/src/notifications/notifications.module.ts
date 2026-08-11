import { Module, Global } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EmailService } from './email/email.service';

// @Global comme AuditModule/CryptoModule : les notifications sont déclenchées depuis de
// nombreux services métier dispersés (campagnes, facturation, équipe, support, essai) —
// éviter de réimporter ce module partout où un événement doit notifier un utilisateur.
@Global()
@Module({
  providers: [NotificationsService, EmailService],
  controllers: [NotificationsController],
  exports: [NotificationsService, EmailService],
})
export class NotificationsModule {}
