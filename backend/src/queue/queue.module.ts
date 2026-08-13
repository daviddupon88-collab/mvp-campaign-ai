import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const CAMPAIGN_GENERATION_QUEUE = 'campaign-generation';

// File d'attente pour toute opération longue (cf. chapitre 10.7) :
// génération de campagne complète, vidéo, export, etc.
// L'API répond immédiatement avec un jobId ; le résultat arrive de façon asynchrone.
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    BullModule.registerQueue({
      name: CAMPAIGN_GENERATION_QUEUE,
      // 2 tentatives max (pas plus) : une erreur systématique (budget/crédits épuisés,
      // abonnement inactif) ne se résoudra jamais en boucle et ne doit pas re-consommer des
      // crédits IA à chaque essai — cf. CampaignGenerationProcessor.process(), qui marque la
      // campagne FAILED dès que ces tentatives sont épuisées plutôt que de la laisser
      // IN_PROGRESS indéfiniment (l'ancien comportement, sans aucun retry ni état d'échec).
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
