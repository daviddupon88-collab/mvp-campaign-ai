import { Module, Global, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { RequestContextService } from './request-context.service';
import { RequestIdMiddleware } from './request-id.middleware';

@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class LoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
