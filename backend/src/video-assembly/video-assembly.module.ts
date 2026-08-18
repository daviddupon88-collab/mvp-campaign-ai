import { Module } from '@nestjs/common';
import { SubtitleBuilderService } from './subtitle-builder.service';
import { MusicBedService } from './music-bed.service';
import { VideoAssemblyService } from './video-assembly.service';
import { VideoQcService } from './video-qc.service';
import { VideoFinalizationService } from './video-finalization.service';

// Seul VideoFinalizationService est exporté : les autres services de ce module sont des
// détails d'implémentation internes à l'assemblage, jamais appelés directement ailleurs dans
// l'application (même principe que ModerationModule/BrandConsistencyModule).
@Module({
  providers: [SubtitleBuilderService, MusicBedService, VideoAssemblyService, VideoQcService, VideoFinalizationService],
  exports: [VideoFinalizationService],
})
export class VideoAssemblyModule {}
