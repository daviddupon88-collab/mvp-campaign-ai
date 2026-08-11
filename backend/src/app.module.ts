import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { StorageModule } from './storage/storage.module';
import { LoggingModule } from './common/logging/logging.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { MetricsInterceptor } from './common/observability/metrics.interceptor';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrivacyModule } from './privacy/privacy.module';
import { SupportModule } from './support/support.module';
import { HelpModule } from './help/help.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { TeamsModule } from './teams/teams.module';
import { PlansModule } from './plans/plans.module';
import { BrandModule } from './brand/brand.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { ContentStudioModule } from './content-studio/content-studio.module';
import { EditorialCalendarModule } from './editorial-calendar/editorial-calendar.module';
import { AiModule } from './ai/ai.module';
import { BillingModule } from './billing/billing.module';
import { SocialModule } from './social/social.module';
import { ProductImportModule } from './product-import/product-import.module';
import { ModerationModule } from './moderation/moderation.module';
import { CampaignOrchestrationModule } from './campaign-orchestration/campaign-orchestration.module';
import { BrandConsistencyModule } from './brand-consistency/brand-consistency.module';
import { OptimizerModule } from './optimizer/optimizer.module';
import { CampaignTemplatesModule } from './campaign-templates/campaign-templates.module';
import { AiEconomicsModule } from './ai-economics/ai-economics.module';
import { AnalyticsModule } from './analytics/analytics.module';

// Monolithe modulaire (Phase 1 de la roadmap) : chaque module ci-dessous
// deviendra un candidat naturel à l'extraction en microservice en Phase 2.
// SocialModule et ProductImportModule sont les premiers candidats naturels à
// l'extraction (Phase 2) : ce sont ceux qui parlent le plus à des API externes
// tierces avec leurs propres contraintes de disponibilité et de rate limiting.
// OptimizerModule est également candidat à l'extraction : sa charge (cron nocturne
// sur toutes les organisations actives) est fondamentalement différente du trafic
// synchrone du reste de l'API.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(), // active les tâches @Cron (AiOptimizerService, TrialExpiryService, TokenRefreshService, ScheduledPublishingService)
    // Rate limiting global par IP — filet de sécurité de base contre l'abus/le bruteforce.
    // Des limites plus strictes sont posées ponctuellement via @Throttle() sur les endpoints
    // sensibles (ex: /auth/login) qui n'ont pas besoin d'autant de marge que le reste de l'API.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    CryptoModule,
    StorageModule,
    LoggingModule,
    ObservabilityModule,
    HealthModule,
    AuditModule,
    NotificationsModule,
    PrivacyModule,
    SupportModule,
    HelpModule,
    AdminModule,
    AuthModule,
    OrganizationsModule,
    TeamsModule,
    PlansModule,
    BrandModule,
    CampaignsModule,
    ContentStudioModule,
    EditorialCalendarModule,
    AiModule,
    BillingModule,
    SocialModule,
    ProductImportModule,
    ModerationModule,
    CampaignOrchestrationModule,
    BrandConsistencyModule,
    OptimizerModule,
    CampaignTemplatesModule,
    AiEconomicsModule,
    AnalyticsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class AppModule {}
