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
    BullModule.registerQueue({ name: CAMPAIGN_GENERATION_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
