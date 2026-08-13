import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCryptoService } from '../common/crypto/token-crypto.service';
import { ClickTrackingService } from './click-tracking.service';
import { fetchWithTimeout } from '../common/http/fetch-with-timeout';

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface PushConversionParams {
  value: number;
  currency: string;
}

// Pousse une conversion connue de Campaign-ai (aujourd'hui : saisie manuelle via
// POST /campaigns/:id/analytics/conversions) vers Meta Conversions API, avec une vraie
// attribution — jamais un événement "à l'aveugle" sans clic connu, ce qui défairait tout
// l'intérêt de cette intégration (cf. plan de conception, décision produit explicite).
//
// Contrat best-effort, comme NotificationsService : un échec (config absente, pixel invalide,
// panne Meta) ne doit jamais faire échouer l'enregistrement de la conversion elle-même — cette
// dernière reste valide côté Campaign-ai (ROAS calculé) même si le push externe échoue.
@Injectable()
export class MetaCapiService {
  private readonly logger = new Logger(MetaCapiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCrypto: TokenCryptoService,
    private readonly clickTracking: ClickTrackingService,
  ) {}

  async pushConversion(organizationId: string, campaignId: string, params: PushConversionParams): Promise<void> {
    const config = await this.prisma.metaCapiConfig.findUnique({ where: { organizationId } });
    if (!config || !config.enabled) {
      this.logger.debug(`Meta CAPI non configuré/désactivé pour l'organisation ${organizationId} — push ignoré`);
      return;
    }

    const click = await this.clickTracking.findMostRecentClickWithFbclid(campaignId);
    if (!click || !click.fbclid) {
      this.logger.debug(`Aucun clic Meta récent avec fbclid pour la campagne ${campaignId} — push ignoré (pas d'attribution possible)`);
      return;
    }

    try {
      const accessToken = this.tokenCrypto.decrypt(config.accessToken);
      const fbc = `fb.1.${click.createdAt.getTime()}.${click.fbclid}`;

      const response = await fetchWithTimeout(`${GRAPH_BASE}/${config.pixelId}/events?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            {
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              action_source: 'website',
              user_data: { fbc },
              custom_data: { value: params.value, currency: params.currency },
            },
          ],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.error(`Échec du push Meta CAPI (organisation ${organizationId}, campagne ${campaignId}): ${response.status} ${text}`);
        return;
      }

      this.logger.log(`Conversion poussée vers Meta CAPI (organisation ${organizationId}, campagne ${campaignId}, valeur ${params.value} ${params.currency})`);
    } catch (error) {
      this.logger.error(`Erreur lors du push Meta CAPI (organisation ${organizationId}, campagne ${campaignId}): ${error}`);
    }
  }
}
