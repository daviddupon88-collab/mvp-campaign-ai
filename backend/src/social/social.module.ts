import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module';
import { BrandModule } from '../brand/brand.module';
import { SocialController } from './social.controller';
import { SocialConnectionsService } from './social-connections.service';
import { PublishingService } from './publishing.service';
import { TokenRefreshService } from './token-refresh.service';
import { OAuthStateService } from './oauth-state.service';
import { MetaAdapter } from './adapters/meta.adapter';
import { LinkedInAdapter } from './adapters/linkedin.adapter';
import { GoogleAdsAdapter } from './adapters/google-ads.adapter';
import { TikTokAdapter } from './adapters/tiktok.adapter';

@Module({
  imports: [PlansModule, BrandModule],
  controllers: [SocialController],
  providers: [
    SocialConnectionsService,
    PublishingService,
    TokenRefreshService,
    OAuthStateService,
    MetaAdapter,
    LinkedInAdapter,
    GoogleAdsAdapter,
    TikTokAdapter,
  ],
  exports: [PublishingService, SocialConnectionsService],
})
export class SocialModule {}
