import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SocialConnectionsService } from './social-connections.service';

// Rafraîchit proactivement les tokens qui expirent dans les prochaines 24h, plutôt que
// d'attendre qu'une tentative de publication échoue au milieu de son exécution. Un client
// dont l'équipe marketing publie une fois par semaine pourrait sinon découvrir une
// connexion expirée uniquement au moment de publier — expérience dégradée évitable.
@Injectable()
export class TokenRefreshService {
  private readonly logger = new Logger(TokenRefreshService.name);

  constructor(private readonly connectionsService: SocialConnectionsService) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async refreshExpiringSoon() {
    const expiringSoon = await this.connectionsService.listExpiringSoon(24 * 60 * 60 * 1000);
    if (expiringSoon.length === 0) return;

    this.logger.log(`${expiringSoon.length} connexion(s) à rafraîchir proactivement`);

    let refreshed = 0;
    for (const connection of expiringSoon) {
      const success = await this.connectionsService.refreshConnectionById(connection.id);
      if (success) refreshed++;
    }

    this.logger.log(`Rafraîchissement proactif : ${refreshed}/${expiringSoon.length} réussi(s)`);
    // Les échecs restent ACTIVE jusqu'à expiration effective (getActiveConnection les
    // marquera EXPIRED au moment d'une tentative d'usage réelle) — pas d'action punitive
    // sur un simple échec de rafraîchissement anticipé, qui peut être transitoire.
  }
}
