import { Module } from '@nestjs/common';
import { SocialModule } from '../social/social.module';
import { EditorialCalendarService } from './editorial-calendar.service';
import { EditorialCalendarController } from './editorial-calendar.controller';
import { ScheduledPublishingService } from './scheduled-publishing.service';

@Module({
  imports: [SocialModule],
  providers: [EditorialCalendarService, ScheduledPublishingService],
  controllers: [EditorialCalendarController],
  exports: [EditorialCalendarService],
})
export class EditorialCalendarModule {}
