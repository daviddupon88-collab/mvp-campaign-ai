import { Module } from '@nestjs/common';
import { BrandModule } from '../brand/brand.module';
import { AssetsService } from './assets.service';
import { AssetsController } from './assets.controller';
import { ContentStudioService } from './content-studio.service';
import { ContentStudioController } from './content-studio.controller';

@Module({
  imports: [BrandModule],
  providers: [AssetsService, ContentStudioService],
  controllers: [AssetsController, ContentStudioController],
  exports: [AssetsService, ContentStudioService],
})
export class ContentStudioModule {}
